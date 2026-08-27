#!/usr/bin/env bash
# Offline test for preflight-lib.sh — the PREFLIGHT seam of run-swarm.sh (#2):
# the three gates that fire BEFORE any real work (self-tests, policy, model).
# All three fail CLOSED — the run aborts, the failure is posted, and NO worker is
# spawned; preflight-swarm.sh and policy-lib.sh own the guards themselves.
#
# Run: bash .sandcastle/tests/preflight-lib-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sc="$here/.."

fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"

# policy_validate's HUMAN_LABELS check makes ONE tracker call (are the loop-in
# labels minted?) — shim it, exactly as policy-lib-test.sh does.
cat > "$tmp/bin/curl" <<'SH'
#!/usr/bin/env bash
url=""
for a in "$@"; do case "$a" in http*) url="$a" ;; esac; done
case "$url" in
  */labels*) echo '[{"id":1,"name":"ready-for-human"},{"id":2,"name":"agent-blocked"},{"id":3,"name":"needs-info"}]' ;;
  *) echo "fake curl: unhandled url $url" >&2; exit 22 ;;
esac
SH
chmod +x "$tmp/bin/curl"
export PATH="$tmp/bin:$PATH"
export FORGEJO_API="https://git.example/api/v1/repos/Owner/repo"
export FORGEJO_TOKEN="x"

. "$sc/verdict-lib.sh"
. "$sc/model-lib.sh"
. "$sc/policy-lib.sh"
. "$sc/schedule-lib.sh"
. "$sc/preflight-lib.sh"

# The fleet default, captured before any gate overwrites SWARM_MODEL.
SWARM_MODEL_DEFAULT_PIN="$SWARM_MODEL"

export PREFLIGHT_NOTIFY="$tmp/bin/notify.sh"
cat > "$PREFLIGHT_NOTIFY" <<'SH'
#!/usr/bin/env bash
printf '%s\n===\n' "$1" >> "${NOTIFY_LOG:?}"
SH
chmod +x "$PREFLIGHT_NOTIFY"
export NOTIFY_LOG="$tmp/notify.log"

# ── 1. the self-tests gate (#446) ─────────────────────────────────────────
cat > "$tmp/preflight-green" <<'SH'
#!/usr/bin/env bash
echo "PREFLIGHT OK: limit grep"
echo "PREFLIGHT OK: verdict parsing"
SH
cat > "$tmp/preflight-red" <<'SH'
#!/usr/bin/env bash
echo "PREFLIGHT OK: limit grep"
echo "PREFLIGHT RED: healer signature rails did not fire on its fixture"
exit 1
SH
chmod +x "$tmp/preflight-green" "$tmp/preflight-red"

: > "$NOTIFY_LOG"; SWARM_EXIT_REASON=""
PREFLIGHT_SCRIPT="$tmp/preflight-green" preflight_gate Acme/widget >"$tmp/pf.out" \
  || fail "a green preflight must pass"
out="$(cat "$tmp/pf.out")"
grep -q 'PREFLIGHT OK: limit grep' <<<"$out" || fail "a green preflight's output must still reach the job log: $out"
[ ! -s "$NOTIFY_LOG" ] || fail "a green preflight must post nothing: $(cat "$NOTIFY_LOG")"
[ "${VERDICT_STAGE:-}" = "preflight self-tests (#446)" ] || fail "the stage must be named, got '${VERDICT_STAGE:-}'"
pass=$((pass+1))

: > "$NOTIFY_LOG"; SWARM_EXIT_REASON=""
RC=0
PREFLIGHT_SCRIPT="$tmp/preflight-red" preflight_gate Acme/widget >"$tmp/pf.out" || RC=$?
out="$(cat "$tmp/pf.out")"
[ "$RC" = 1 ] || fail "a red preflight must abort the run, got $RC"
[ "$SWARM_EXIT_REASON" = "preflight-red" ] || fail "the reason must be named, got '$SWARM_EXIT_REASON'"
grep -q 'PREFLIGHT RED' <<<"$out" || fail "the failing guard must reach the job log: $out"
grep -q 'Swarm preflight RED' "$NOTIFY_LOG" || fail "a red preflight must alarm: $(cat "$NOTIFY_LOG")"
grep -q 'healer signature rails' "$NOTIFY_LOG" || fail "the alarm must name the failing guard, not just say 'red'"
grep -q 'NO worker was spawned' "$NOTIFY_LOG" || fail "the alarm must say nothing was started"
pass=$((pass+1))

# ── 2. the policy gate (#12, ADR 0002) ────────────────────────────────────
# Absent file = byte-identical default behaviour, and the run says which it got.
: > "$NOTIFY_LOG"; SWARM_EXIT_REASON=""
out="$(preflight_policy_gate Acme/widget "$tmp/no-such-policy.sh")" \
  || fail "an absent policy file must be the defaults, not a refusal"
grep -q 'policy: defaults (LANDING=push MERGE_AUTHORITY=human)' <<<"$out" \
  || fail "the defaults must be logged explicitly: $out"
[ ! -s "$NOTIFY_LOG" ] || fail "the default policy must post nothing"
pass=$((pass+1))

printf 'LANDING=pr\nMERGE_AUTHORITY=agent-after-green\n' > "$tmp/policy-ok.sh"
out="$(preflight_policy_gate Acme/widget "$tmp/policy-ok.sh")" \
  || fail "a valid policy file must pass"
grep -q 'policy: LANDING=pr MERGE_AUTHORITY=agent-after-green' <<<"$out" \
  || fail "a present policy must be logged as loaded, not as defaults: $out"
pass=$((pass+1))

printf 'LANDING=merge\n' > "$tmp/policy-bad.sh"
: > "$NOTIFY_LOG"; SWARM_EXIT_REASON=""
RC=0
preflight_policy_gate Acme/widget "$tmp/policy-bad.sh" >/dev/null 2>&1 || RC=$?
[ "$RC" = 1 ] || fail "an invalid policy must abort BEFORE a worker spawns, got $RC"
[ "$SWARM_EXIT_REASON" = "invalid-policy" ] || fail "the reason must be named, got '$SWARM_EXIT_REASON'"
grep -q 'invalid' "$NOTIFY_LOG" || fail "an invalid policy must alarm: $(cat "$NOTIFY_LOG")"
grep -q 'no worker was spawned' "$NOTIFY_LOG" || fail "the alarm must say nothing was started"
pass=$((pass+1))

# ── 3. the model gate (#448 fail-fast) ────────────────────────────────────
: > "$NOTIFY_LOG"; SWARM_EXIT_REASON=""
preflight_model_gate Acme/widget '[{"number":9,"model":"opus"}]' >"$tmp/mg.out" \
  || fail "a known model label must pass the gate"
out="$(cat "$tmp/mg.out")"
grep -q 'model for this run' <<<"$out" || fail "the run's model must be logged: $out"
grep -q 'from label model-opus on #9' <<<"$out" || fail "the note must cite the label + ticket: $out"
[ ! -s "$NOTIFY_LOG" ] || fail "a resolvable model must post nothing"
pass=$((pass+1))

: > "$NOTIFY_LOG"; SWARM_EXIT_REASON=""
RC=0
preflight_model_gate Acme/widget '[{"number":9,"model":"nope"}]' >/dev/null 2>&1 || RC=$?
[ "$RC" = 1 ] || fail "an unknown model must abort, never silently default, got $RC"
[ "$SWARM_EXIT_REASON" = "unknown-model" ] || fail "the reason must be named, got '$SWARM_EXIT_REASON'"
grep -q 'unknown model' "$NOTIFY_LOG" || fail "an unknown model must alarm: $(cat "$NOTIFY_LOG")"
grep -q '`nope`' "$NOTIFY_LOG" || fail "the alarm must quote the offending label so it can be fixed"
pass=$((pass+1))

# The gate EXPORTS the resolved model — main.mts reads it from the environment.
# Each case runs in a FRESH shell: the gate fires once per run, and resolving an
# unlabelled ticket reads SWARM_MODEL (model-lib's fleet default), so a second
# call in the same shell would compound the first's answer.
gate_model() { # gate_model <ready-json> -> the SWARM_MODEL a fresh run would export
  bash -c ". '$sc/verdict-lib.sh'; . '$sc/model-lib.sh'; . '$sc/policy-lib.sh'
           . '$sc/schedule-lib.sh'; . '$sc/preflight-lib.sh'
           preflight_model_gate Acme/widget '$1' >/dev/null
           bash -c 'printf %s \"\${SWARM_MODEL:-}\"'"   # the inner shell proves it is EXPORTED
}
[ "$(gate_model '[{"number":9,"model":"sonnet"}]')" = "$(swarm_resolve_model sonnet)" ] \
  || fail "the gate must export the LABEL's model id, got '$(gate_model '[{"number":9,"model":"sonnet"}]')'"
[ "$(gate_model '[{"number":9,"model":null}]')" = "$SWARM_MODEL_DEFAULT_PIN" ] \
  || fail "an unlabelled first ticket must export the fleet default"
pass=$((pass+1))

echo "preflight-lib: $pass groups passed"
