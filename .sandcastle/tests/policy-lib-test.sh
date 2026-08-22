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

# --- onboard.sh policy writes a VALIDATED file (round-trips through the loader) ---
. "$sc/onboarding/onboard-lib.sh"
onboard_write_policy "$tmp/written.sh" LANDING=pr MERGE_AUTHORITY=agent-after-green >/dev/null \
  || fail "onboard_write_policy: valid knobs should write"
grep -q '^LANDING=pr$' "$tmp/written.sh" || fail "written policy keeps LANDING=pr"
policy_load "$tmp/written.sh"; eq "$SWARM_POLICY_LANDING" "pr" "written file reloads LANDING=pr"
pass=$((pass+1))
if onboard_write_policy "$tmp/bad-written.sh" LANDING=merge >/dev/null 2>&1; then
  fail "onboard_write_policy: a bad enum must NOT write a file"
fi
[ ! -f "$tmp/bad-written.sh" ] || fail "onboard_write_policy: rejected file must not be left behind"
if onboard_write_policy "$tmp/bad-key.sh" NOPE=1 >/dev/null 2>&1; then
  fail "onboard_write_policy: an unknown key must NOT write a file"
fi
pass=$((pass+2))

echo "policy-lib: $pass checks passed"
