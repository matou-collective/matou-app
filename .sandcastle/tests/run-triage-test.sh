#!/usr/bin/env bash
# Offline test for run-triage.sh's failure verdict (#18): when the `/triage`
# claude call dies with a REAL (non-limit) fault, the EXIT-trap verdict must
# record the claude error lines — run 19 reddened with an EMPTY
# `--- error lines ---` block because `run-triage.sh` did `rm -f "$triage_log"`
# BEFORE `exit 1`, so `verdict_write` (fired by the EXIT trap, AFTER the rm) read
# a deleted file. The fix moves the log cleanup into the trap, after the verdict.
# Run: bash .sandcastle/tests/run-triage-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
marker="$tmp/limit-marker"            # per-test global marker (never the real /tmp one)
verdict="$tmp/triage-verdict"
mkdir -p "$tmp/bin"

# A curl that feeds preflight one untriaged issue and answers the human_gated
# queries empty (same shape as claude-call-guards-test.sh).
cat > "$tmp/bin/curl" <<'SH'
#!/usr/bin/env bash
url="${*: -1}"
case "$url" in
  *labels=*) echo '[]' ;;                                             # human_gated: nothing gated
  *state=open*) echo '[{"number":999,"title":"t","html_url":"http://x/999","labels":[]}]' ;;
  */repos/x/y) echo '{"permissions":{"push":true}}' ;;                # #20 repo-root issue-write probe
  *) echo '[]' ;;
esac
SH
# A claude whose stdout/exit we control.
cat > "$tmp/bin/claude" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "${CLAUDE_OUTPUT:-}"
exit "${CLAUDE_EXIT:-0}"
SH
chmod +x "$tmp/bin/curl" "$tmp/bin/claude"

run_triage() {
  env -u MATTERMOST_URL -u MATTERMOST_BOT_TOKEN -u MATTERMOST_CHANNEL_ID \
    PATH="$tmp/bin:$PATH" \
    FORGEJO_TOKEN=dummy FORGEJO_API=http://x/api/v1/repos/x/y \
    CLAUDE_LIMIT_MARKER="$marker" TRIAGE_VERDICT_PATH="$verdict" \
    "$@" bash "$here/../run-triage.sh"
}

# AC — a shimmed failing `/triage` (a REAL, non-limit fault) leaves the verdict
# on disk with the shim's error line, NOT an empty error block.
errline="fatal: the triage skill exploded at unmistakable-line-77"
rm -f "$marker" "$verdict"
if run_triage CLAUDE_EXIT=1 CLAUDE_OUTPUT="$errline" >/dev/null 2>&1; then
  fail "a real (non-limit) claude failure must red (non-zero exit)"
fi
[ -f "$verdict" ]                      || fail "a failing triage must leave a verdict on disk"
grep -q "stage=triage skill" "$verdict" || fail "the verdict must key the failing stage, got: $(cat "$verdict")"
grep -q "exit=1" "$verdict"            || fail "the verdict must record the non-zero exit, got: $(cat "$verdict")"
grep -qF "$errline" "$verdict"         || fail "the verdict's error lines must carry the claude error, got: $(cat "$verdict")"
# The captured log itself is cleaned up (the trap removes it AFTER the verdict).
pass=$((pass+1))

# happy path — a healthy triage exits 0 and leaves NO verdict behind (a clean
# run must never mint a red marker).
rm -f "$marker" "$verdict"
if ! run_triage CLAUDE_EXIT=0 CLAUDE_OUTPUT="triaged everything" >/dev/null 2>&1; then
  fail "a healthy triage run must exit 0"
fi
[ ! -f "$verdict" ] || fail "a clean run must leave no verdict, got: $(cat "$verdict")"
pass=$((pass+1))

echo "run-triage: $pass scenarios passed"
