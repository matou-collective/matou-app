#!/usr/bin/env bash
# Offline tests for ../policy-lib.sh — the per-repo POLICY layer (#12, ADR 0002).
# Run: bash .sandcastle/tests/policy-lib-test.sh
#
# The hazard this closes: per-repo behaviour (landing, merge authority, the
# loop-in human-label state machine) used to be prose in prompt.md or hardcoded
# in the harness. It becomes declarative knobs in swarm-policy.sh, and a bad
# knob must fail LOUD before any worker spawns (like swarm_resolve_model), never
# a silent misconfiguration. curl is shimmed for the one tracker call (the
# label-minted check); no docker, no network.
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sc="$here/.."
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

# --- shim curl: answer GET /labels with a fixture that has the core loop-in
#     labels minted (ready-for-human / agent-blocked / needs-info) but NOT an
#     arbitrary custom name — so the label-minted check can reject one. ---
mkdir -p "$tmp/bin"
cat > "$tmp/bin/curl" <<'SH'
#!/usr/bin/env bash
url=""
for a in "$@"; do case "$a" in http*) url="$a" ;; esac; done
case "$url" in
  */labels*) echo '[{"id":1,"name":"ready-for-human"},{"id":2,"name":"agent-blocked"},{"id":3,"name":"needs-info"},{"id":4,"name":"escalate"}]' ;;
  *) echo "fake curl: unhandled url $url" >&2; exit 22 ;;
esac
SH
chmod +x "$tmp/bin/curl"
export PATH="$tmp/bin:$PATH"
export FORGEJO_API="https://git.example/api/v1/repos/Owner/repo"
export FORGEJO_TOKEN="x"

. "$sc/policy-lib.sh"

fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0
eq() { [ "$1" = "$2" ] || fail "$3: expected [$2], got [$1]"; pass=$((pass+1)); }

# reject <file> <expected-stderr-substring> <desc>
reject() {
  local err rc
  policy_load "$1"
  err="$(policy_validate "$1" 2>&1)"; rc=$?
  [ "$rc" -ne 0 ] || fail "$3: expected reject, got accept"
  case "$err" in *"$2"*) : ;; *) fail "$3: stderr [$err] missing [$2]" ;; esac
  pass=$((pass+1))
}
# accept <file> <desc>
accept() {
  policy_load "$1"
  if ! policy_validate "$1" 2>"$tmp/err"; then fail "$2: expected accept, got reject ($(cat "$tmp/err"))"; fi
  pass=$((pass+1))
}

# --- absent file -> defaults (byte-identical behaviour for idss + the factory) ---
policy_load "$tmp/does-not-exist.sh"
eq "$SWARM_POLICY_FILE_PRESENT" "false" "absent file -> FILE_PRESENT=false"
eq "$SWARM_POLICY_LANDING" "push" "absent file -> LANDING=push"
eq "$SWARM_POLICY_MERGE_AUTHORITY" "human" "absent file -> MERGE_AUTHORITY=human"
eq "$SWARM_POLICY_HUMAN_LABELS" \
   "ready-for-human:one-way-door agent-blocked:cannot-proceed needs-info:missing-context" \
   "absent file -> core loop-in label set with today's triggers"
eq "$SWARM_POLICY_PROTECTED_PATHS" ".sandcastle .forgejo" "absent file -> today's protected dirs"
# the absent-file path is network-free (no custom label to check) — validate accepts
accept "$tmp/does-not-exist.sh" "absent file validates (defaults, no network)"

# --- a full valid custom file loads OVER the defaults and validates ---
cat > "$tmp/ok.sh" <<'CFG'
LANDING=pr
MERGE_AUTHORITY=agent-after-green
HUMAN_LABELS="ready-for-human:one-way-door escalate:cannot-proceed"
PROTECTED_PATHS=".sandcastle .forgejo docs"
CFG
policy_load "$tmp/ok.sh"
eq "$SWARM_POLICY_FILE_PRESENT" "true" "present file -> FILE_PRESENT=true"
eq "$SWARM_POLICY_LANDING" "pr" "custom LANDING loads over default"
eq "$SWARM_POLICY_MERGE_AUTHORITY" "agent-after-green" "custom MERGE_AUTHORITY loads over default"
eq "$SWARM_POLICY_PROTECTED_PATHS" ".sandcastle .forgejo docs" "custom PROTECTED_PATHS loads over default"
accept "$tmp/ok.sh" "a valid custom policy validates (labels minted)"

# --- each enum: accepted values ---
printf 'LANDING=push\n'                    > "$tmp/l-push.sh"; accept "$tmp/l-push.sh" "LANDING=push accepted"
printf 'LANDING=pr\n'                       > "$tmp/l-pr.sh";  accept "$tmp/l-pr.sh"  "LANDING=pr accepted"
printf 'MERGE_AUTHORITY=human\n'            > "$tmp/m-h.sh";   accept "$tmp/m-h.sh"   "MERGE_AUTHORITY=human accepted"
printf 'MERGE_AUTHORITY=agent-after-green\n'> "$tmp/m-a.sh";   accept "$tmp/m-a.sh"   "MERGE_AUTHORITY=agent-after-green accepted"
printf 'SESSION_RUNNER=on\n'                > "$tmp/s-on.sh";  accept "$tmp/s-on.sh"  "SESSION_RUNNER=on accepted"
printf 'SESSION_RUNNER=off\n'               > "$tmp/s-off.sh"; accept "$tmp/s-off.sh" "SESSION_RUNNER=off accepted"

# --- SESSION_RUNNER: on by default for EVERY factory repo (Ben, 2026-08-22) ---
# The ready-for-session drainer is a standing deliverable of enrolment, with a
# per-repo opt-out asked once at setup; the host's kill-switch file stays the
# separate, temporary, operational pause.
policy_load "$tmp/does-not-exist.sh"
eq "$SWARM_POLICY_SESSION_RUNNER" "on" "absent file -> SESSION_RUNNER=on (the drainer is on by default)"
policy_load "$tmp/s-off.sh"
eq "$SWARM_POLICY_SESSION_RUNNER" "off" "custom SESSION_RUNNER=off loads over the default"
printf 'SESSION_RUNNER=maybe\n' > "$tmp/s-bad.sh"
reject "$tmp/s-bad.sh" "policy: SESSION_RUNNER must be on|off (got maybe)" "SESSION_RUNNER=maybe rejected"

# --- TWO_WAY_DOOR_DOC: the per-repo two-way-door RECORD (#42, ADR 0002) -------
# "ADR 0174" is the factory's inherited audit-trail vocabulary and cannot 404,
# but the record it names sits at a different path in every repo — a literal
# path in a vendored prompt string sent every consumer's triage agent to a
# missing file. Default EMPTY: no cross-repo path is honest, and a repo with no
# local record is told so in words (CLAUDE.md's "never default a per-repo value
# to any product").
policy_load "$tmp/does-not-exist.sh"
eq "$SWARM_POLICY_TWO_WAY_DOOR_DOC" "" "absent file -> TWO_WAY_DOOR_DOC empty (no cross-repo default)"
accept "$tmp/does-not-exist.sh" "an undeclared pointer is a valid policy, not a hole"
printf 'TWO_WAY_DOOR_DOC=docs/adr/0001-*.md\n' > "$tmp/twd.sh"
policy_load "$tmp/twd.sh"
eq "$SWARM_POLICY_TWO_WAY_DOOR_DOC" "docs/adr/0001-*.md" "a declared record loads verbatim (glob intact)"
accept "$tmp/twd.sh" "a repo-relative record path validates"
# The value is read by an agent running in the repo CHECKOUT, so it must be a
# repo-relative path: an absolute one is a host fact (#37/#43's defect family)
# and a `..` escape leaves the repo the prompt is about.
printf 'TWO_WAY_DOOR_DOC=/home/dev/swarm/idss/docs/adr/0174-x.md\n' > "$tmp/twd-abs.sh"
reject "$tmp/twd-abs.sh" "TWO_WAY_DOOR_DOC must be a path relative to the repo checkout root" \
  "an absolute host path is rejected"
printf 'TWO_WAY_DOOR_DOC=../idss/docs/adr/0174-x.md\n' > "$tmp/twd-esc.sh"
reject "$tmp/twd-esc.sh" "TWO_WAY_DOOR_DOC must stay inside the repo" "a .. escape is rejected"
# One path, not prose — a quoted multi-word value would render as a broken
# pointer in the prompt (and unquoted it truncates silently, GOTCHAS 15).
printf 'TWO_WAY_DOOR_DOC="docs/adr/0001-*.md and also the rules"\n' > "$tmp/twd-ws.sh"
reject "$tmp/twd-ws.sh" "TWO_WAY_DOOR_DOC must be ONE path" "a multi-word value is rejected"

# --- each enum: rejected values, with the exact acceptance-criteria message ---
printf 'LANDING=merge\n' > "$tmp/l-bad.sh"
reject "$tmp/l-bad.sh" "policy: LANDING must be push|pr (got merge)" "LANDING=merge rejected (exact message)"
printf 'MERGE_AUTHORITY=auto\n' > "$tmp/m-bad.sh"
reject "$tmp/m-bad.sh" "policy: MERGE_AUTHORITY must be human|agent-after-green (got auto)" "MERGE_AUTHORITY=auto rejected"

# --- unknown key rejected, offending key named ---
printf 'BOGUS=1\n' > "$tmp/unk.sh"
reject "$tmp/unk.sh" "unknown key BOGUS" "unknown key rejected and named"

# --- HUMAN_LABELS: bad shape and unknown trigger rejected ---
printf 'HUMAN_LABELS="ready-for-human"\n' > "$tmp/hl-shape.sh"
reject "$tmp/hl-shape.sh" "must be name:trigger" "HUMAN_LABELS entry without a trigger rejected"
printf 'HUMAN_LABELS="ready-for-human:someday"\n' > "$tmp/hl-trig.sh"
reject "$tmp/hl-trig.sh" "trigger someday unknown" "HUMAN_LABELS unknown trigger rejected"

# --- label-not-minted rejected (the shimmed curl label list has no such name) ---
printf 'HUMAN_LABELS="not-a-real-label:one-way-door"\n' > "$tmp/hl-missing.sh"
reject "$tmp/hl-missing.sh" "label not-a-real-label is not minted" "HUMAN_LABELS naming an unminted label rejected"

# --- policy_human_labels emits name<TAB>trigger for renderers ---
policy_load "$tmp/does-not-exist.sh"
hl="$(policy_human_labels)"
eq "$(printf '%s\n' "$hl" | head -1)" "$(printf 'ready-for-human\tone-way-door')" "human_labels line 1 is name<TAB>trigger"
eq "$(printf '%s\n' "$hl" | wc -l | tr -d ' ')" "3" "human_labels emits one line per default label"

# --- policy_trigger_guidance: one sentence per trigger, the prose the prompt
#     renderer (#14) prints beside each hand-off label. The vocabulary and its
#     guidance live TOGETHER here — a renderer that invents its own wording
#     would let the two drift. ---
for trig in one-way-door cannot-proceed missing-context product-decision; do
  g="$(policy_trigger_guidance "$trig")" || fail "trigger_guidance $trig: expected exit 0"
  [ -n "$g" ] || fail "trigger_guidance $trig: empty guidance"
  pass=$((pass+1))
done
eq "$(policy_trigger_guidance one-way-door | grep -c 'one-way-door')" "1" \
  "trigger_guidance one-way-door names the door it must not rule"
case "$(policy_trigger_guidance one-way-door)" in
  *'## Why human'*) pass=$((pass+1)) ;;
  *) fail "trigger_guidance one-way-door must name the ## Why human line" ;;
esac
# Wrapped for the prompt, never one runaway line: no line over 68 DISPLAY
#     columns (68 + the renderer’s 5-space bullet indent keeps the prompt
#     under 74). Measure the width a reader sees, not bytes: this prose uses
#     em-dashes (U+2014, 3 bytes each), so a byte count overcharges them and
#     reds a line that fits. Display width == UTF-8 code points here (no wide
#     or combining chars), = total bytes minus continuation bytes (0x80–0xBF).
dispcols() {
  local bytes cont
  bytes="$(printf '%s' "$1" | wc -c)"
  cont="$(printf '%s' "$1" | LC_ALL=C tr -cd '\200-\277' | wc -c)"
  echo $(( bytes - cont ))
}
for trig in one-way-door cannot-proceed missing-context product-decision; do
  while IFS= read -r line; do
    [ "$(dispcols "$line")" -le 68 ] \
      || fail "trigger_guidance $trig: line over 68 display cols: [$line]"
  done < <(policy_trigger_guidance "$trig")
  pass=$((pass+1))
done
if policy_trigger_guidance not-a-trigger >/dev/null 2>&1; then
  fail "trigger_guidance must refuse a trigger outside the fixed vocabulary"
fi
pass=$((pass+1))
err="$(policy_trigger_guidance not-a-trigger 2>&1 >/dev/null)"
case "$err" in *not-a-trigger*) pass=$((pass+1)) ;; *) fail "trigger_guidance refusal must name the trigger" ;; esac

# --- product-decision joins the fixed vocabulary (#14, ADR 0002 amendment):
#     Ben's acceptance case is a repo adding `needs-product-owner`, and two
#     labels sharing one trigger would make the rendered routing ambiguous. ---
printf 'HUMAN_LABELS="ready-for-human:one-way-door agent-blocked:cannot-proceed escalate:product-decision"\n' > "$tmp/hl-prod.sh"
accept "$tmp/hl-prod.sh" "product-decision is an accepted trigger"
eq "$(policy_validate "$tmp/hl-prod.sh" 2>&1; echo rc=$?)" "rc=0" "product-decision policy validates clean"
# and the vocabulary is still CLOSED — the refusal message lists all four.
printf 'HUMAN_LABELS="ready-for-human:product-owner"\n' > "$tmp/hl-near.sh"
reject "$tmp/hl-near.sh" "one-way-door cannot-proceed missing-context product-decision" \
  "unknown trigger refusal lists the whole fixed vocabulary"

# NOTE: the onboard_write_policy writer cases (which need onboarding/onboard-lib.sh,
# a path deliberately excluded from every consumer's vendored .sandcastle/) live in
# onboarding/tests/onboard-lib-test.sh — this file sources ONLY policy-lib.sh +
# forgejo-lib.sh, both vendored, so it passes standalone in a consumer's tree (#23).

echo "policy-lib: $pass checks passed"
