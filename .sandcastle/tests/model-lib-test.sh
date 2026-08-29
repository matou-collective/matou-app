#!/usr/bin/env bash
# Offline tests for the shared swarm/healer model config (#448, learning L6).
# Run: bash .sandcastle/tests/model-lib-test.sh
#
# The hazard this closes: the model was hardcoded in TWO unrelated places —
# main.mts's claudeCode("claude-opus-4-8") and heal.sh's `claude --model
# claude-opus-4-8` — which could drift apart silently, and every ticket paid
# top-tier with no way to right-size a mechanical one. model-lib.sh + swarm.config
# are now the ONE source; a model-<name> ticket label right-sizes per-ticket, and
# an unknown model fails LOUD before any worker spawns.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sc="$here/.."
. "$sc/model-lib.sh"

fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0
eq() { [ "$1" = "$2" ] || fail "$3: expected [$2], got [$1]"; pass=$((pass+1)); }

# --- swarm.config is the single source: it defines the default + the map,
#     plus the diagnosis/repair tier (healer + rehearsal reporter) ---
[ -n "${SWARM_MODEL:-}" ]        || fail "swarm.config must set SWARM_MODEL"
[ -n "${SWARM_MODEL_MAP:-}" ]    || fail "swarm.config must set SWARM_MODEL_MAP"
[ -n "${SWARM_HEAL_MODEL:-}" ]   || fail "swarm.config must set SWARM_HEAL_MODEL"
[ -n "${SWARM_REPORT_MODEL:-}" ] || fail "swarm.config must set SWARM_REPORT_MODEL"
pass=$((pass+4))

# --- swarm_resolve_model: the default, the label form, the bare suffix ---
eq "$(swarm_resolve_model "")"            "$SWARM_MODEL"        "empty selector -> fleet default"
eq "$(swarm_resolve_model "model-haiku")" "claude-haiku-4-5"    "model-haiku label -> haiku id"
eq "$(swarm_resolve_model "haiku")"       "claude-haiku-4-5"    "bare haiku suffix -> haiku id"
eq "$(swarm_resolve_model "model-sonnet")" "claude-sonnet-4-5"  "model-sonnet label -> sonnet id"
eq "$(swarm_resolve_model "opus")"        "claude-opus-4-8"     "opus suffix -> opus id"
# a full, already-allowed model id resolves to itself
eq "$(swarm_resolve_model "claude-haiku-4-5")" "claude-haiku-4-5" "full allowed id -> itself"

# --- default is a member of the allowlist (a run always has a valid model) ---
swarm_model_ids | grep -qx "$SWARM_MODEL" || fail "SWARM_MODEL must be one of the allowed ids"
pass=$((pass+1))

# --- fail-fast: an unknown model resolves to NOTHING and fails LOUD (never a
#     silent fall back to the default). This is the 5-second catch for a typo'd
#     model-* label that would otherwise spawn the whole run on the wrong model. ---
if out="$(swarm_resolve_model "model-gpt5" 2>err.txt)"; then
  fail "unknown model must fail (got [$out])"
fi
[ -z "${out:-}" ] || fail "unknown model must emit NO stdout (would be read as a model id)"
grep -q "FAILED" err.txt || fail "unknown model must name the failure on stderr"
grep -q "not launch\|never launch\|Fix the ticket" err.txt || fail "failure must point at the fix"
rm -f err.txt
pass=$((pass+3))

# --- changing the shared value changes the resolver (drift-free proof): a
#     throwaway swarm.config with a different default flows straight through. ---
tmpdir="$(mktemp -d)"; trap 'rm -rf "$tmpdir"' EXIT
cp "$sc/model-lib.sh" "$tmpdir/model-lib.sh"
cat > "$tmpdir/swarm.config" <<'CFG'
SWARM_MODEL=claude-sonnet-4-5
SWARM_MODEL_MAP="sonnet=claude-sonnet-4-5 haiku=claude-haiku-4-5"
SWARM_HEAL_MODEL=claude-opus-4-8
SWARM_REPORT_MODEL=claude-opus-4-8
CFG
got="$(unset __SWARM_MODEL_LIB SWARM_MODEL SWARM_MODEL_MAP SWARM_HEAL_MODEL SWARM_REPORT_MODEL
       . "$tmpdir/model-lib.sh"; swarm_resolve_model "")"
eq "$got" "claude-sonnet-4-5" "a changed swarm.config default flows through the resolver"
heal_got="$(unset __SWARM_MODEL_LIB SWARM_MODEL SWARM_MODEL_MAP SWARM_HEAL_MODEL SWARM_REPORT_MODEL
       . "$tmpdir/model-lib.sh"; printf %s "$SWARM_HEAL_MODEL")"
eq "$heal_got" "claude-opus-4-8" "a changed swarm.config heal model flows through too"

# --- every consumer reads a shared value; NO hardcoded model id and NO
#     model-less claude launch (silently riding the host CLI default) survives ---
grep -q 'claudeCode(SWARM_MODEL' "$sc/main.mts" || fail "main.mts must launch on the resolved SWARM_MODEL"
grep -q 'readFileSync' "$sc/main.mts"            || fail "main.mts must read swarm.config"
! grep -Eq 'claude-(opus|sonnet|haiku|fable)-' "$sc/main.mts" \
  || fail "main.mts still hardcodes a model id (#448 AC: grep proves none remains)"
grep -q -- '--model "\$SWARM_HEAL_MODEL"' "$sc/heal.sh" || fail "heal.sh must launch on \$SWARM_HEAL_MODEL"
grep -q -- '--model "\$SWARM_HEAL_MODEL"' "$sc/rehearsal-report.sh" \
  || fail "rehearsal-report.sh's heal leg must launch on \$SWARM_HEAL_MODEL"
grep -q -- '--model "\$SWARM_REPORT_MODEL"' "$sc/rehearsal-report.sh" \
  || fail "rehearsal-report.sh's diagnosis leg must launch on \$SWARM_REPORT_MODEL"
grep -q -- '--model "\$SWARM_MODEL"' "$sc/session-runner.sh" \
  || fail "session-runner.sh must launch on \$SWARM_MODEL (never the host CLI default)"
grep -q -- '--model "\$SWARM_MODEL"' "$sc/run-triage.sh" \
  || fail "run-triage.sh must launch on \$SWARM_MODEL (never the host CLI default)"
grep -q -- '--model "\$SWARM_MODEL"' "$sc/landing-lib.sh" \
  || fail "landing-lib.sh's rebase rescue must launch on \$SWARM_MODEL (never the host CLI default)"
for f in heal.sh rehearsal-report.sh session-runner.sh run-triage.sh landing-lib.sh; do
  ! grep -Eq 'model claude-(opus|sonnet|haiku|fable)-' "$sc/$f" \
    || fail "$f still hardcodes a model id (#448 AC: grep proves none remains)"
done
pass=$((pass+14))

# --- list-ready-tasks.sh surfaces a ticket's model-<name> label as `.model`
#     (the jq the worker launch reads). Drive the exact transform on a fixture
#     issue: a model-haiku ticket surfaces "haiku"; an unlabelled one, null. ---
labelled='[{"number":1,"title":"t","body":"b","html_url":"u",
  "labels":[{"name":"ready-for-agent"},{"name":"model-haiku"}]}]'
plain='[{"number":2,"title":"t","body":"b","html_url":"u",
  "labels":[{"name":"ready-for-agent"}]}]'
model_of() { jq -r '.[0]
  | ((.labels // []) | map(.name) | map(select(startswith("model-")))
     | if length == 0 then "null" else (.[0] | ltrimstr("model-")) end)' <<<"$1"; }
eq "$(model_of "$labelled")" "haiku" "list-ready surfaces model-haiku as .model=haiku"
eq "$(model_of "$plain")"    "null"  "an unlabelled ticket surfaces .model=null (default)"
# the surfaced suffix resolves to the model a labelled run launches on
eq "$(swarm_resolve_model "$(model_of "$labelled")")" "claude-haiku-4-5" \
   "the surfaced label resolves to the launch model"

echo "model-lib: $pass checks passed"
