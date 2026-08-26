#!/usr/bin/env bash
# Offline test for the claude-call guards (#253): run-triage.sh and heal.sh must
# ride the host-global limit marker like the swarm workers already do, instead of
# reddening (triage) or going blind and burning ledger attempts (the healer) on a
# limit window. Drives the REAL scripts with a fake claude/agent emitting limit
# signatures across the marker fresh/stale/absent matrix.
# Run: bash .sandcastle/tests/claude-call-guards-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
marker="$tmp/limit-marker"            # per-test global marker (never the real /tmp one)
mkdir -p "$tmp/bin"

# --- shims on PATH: a curl that feeds preflight one untriaged issue and answers
#     the human_gated queries empty, and a claude whose output/exit we control
#     and that records the fact it was invoked at all. ---
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
cat > "$tmp/bin/claude" <<'SH'
#!/usr/bin/env bash
echo "called" >> "$CLAUDE_CALLED_LOG"
printf '%s\n' "${CLAUDE_OUTPUT:-}"
exit "${CLAUDE_EXIT:-0}"
SH
chmod +x "$tmp/bin/curl" "$tmp/bin/claude"

run_triage() {
  : > "$tmp/claude-called"
  env -u MATTERMOST_URL -u MATTERMOST_BOT_TOKEN -u MATTERMOST_CHANNEL_ID \
    PATH="$tmp/bin:$PATH" \
    FORGEJO_TOKEN=dummy FORGEJO_API=http://x/api/v1/repos/x/y \
    CLAUDE_LIMIT_MARKER="$marker" TRIAGE_VERDICT_PATH="$tmp/triage-verdict" \
    CLAUDE_CALLED_LOG="$tmp/claude-called" \
    "$@" bash "$here/../run-triage.sh"
}
claude_was_called() { [ -s "$tmp/claude-called" ]; }

# AC1 — fresh marker → yields 0 WITHOUT calling claude, and says so.
rm -f "$marker"; touch "$marker"
if out="$(run_triage 2>&1)"; then ec=0; else ec=$?; fi
[ "$ec" -eq 0 ]                          || fail "triage: a fresh marker must yield exit 0, got $ec"
claude_was_called                        && fail "triage: a fresh marker must NOT call claude"
echo "$out" | grep -qi "limit-parked"    || fail "triage: a fresh marker must log limit-parked, got: $out"
pass=$((pass+1))

# AC2a — no marker, claude refuses with a limit signature → writes the marker and
# exits CLEAN (never red).
rm -f "$marker"
if out="$(run_triage CLAUDE_EXIT=1 CLAUDE_OUTPUT="You've hit your weekly limit · resets Aug 1, 8am (UTC)" 2>&1)"; then ec=0; else ec=$?; fi
[ "$ec" -eq 0 ]                          || fail "triage: a limit refusal must exit clean (0), got $ec"
claude_was_called                        || fail "triage: this path must actually reach the claude call"
[ -f "$marker" ]                         || fail "triage: a classified limit refusal must PARK the host (write the marker)"
echo "$out" | grep -qi "limit-parked"    || fail "triage: a classified limit refusal must log limit-parked"
pass=$((pass+1))

# AC2b — no marker, claude fails with a NON-limit fault → still reddens honestly,
# and does NOT park the host.
rm -f "$marker"
if run_triage CLAUDE_EXIT=1 CLAUDE_OUTPUT="panic: nil pointer dereference in the triage skill" >/dev/null 2>&1; then ec=0; else ec=$?; fi
[ "$ec" -ne 0 ]  || fail "triage: a real (non-limit) claude failure must still red (non-zero exit)"
[ ! -f "$marker" ] || fail "triage: a real failure must NOT park the host"
pass=$((pass+1))

# happy path — no marker, claude succeeds → the guard is invisible, run proceeds 0.
rm -f "$marker"
if run_triage CLAUDE_EXIT=0 CLAUDE_OUTPUT="triaged everything" >/dev/null 2>&1; then ec=0; else ec=$?; fi
[ "$ec" -eq 0 ]   || fail "triage: a healthy claude run must still exit 0"
claude_was_called || fail "triage: the happy path must reach the claude call"
[ ! -f "$marker" ] || fail "triage: a healthy run must not park the host"
pass=$((pass+1))

# --- heal.sh: fixture workdir + agent stub, exactly like heal-test.sh ---
mkdir -p "$tmp/wd/.sandcastle/logs" "$tmp/state"
git init -q "$tmp/wd"
echo "boom: unmistakable error line 12345" > "$tmp/wd/.sandcastle/logs/x-worker.log"
# an agent stub whose stdout (→ agent-out.log) carries a limit signature
cat > "$tmp/bin/limit-agent.sh" <<'SH'
#!/usr/bin/env bash
echo "You've hit your weekly limit · resets Aug 1, 8am (UTC)"
exit 1
SH

run_heal() {
  env -u MATTERMOST_URL -u MATTERMOST_BOT_TOKEN -u MATTERMOST_CHANNEL_ID \
    HEAL_MODE=hook WORKFLOW=swarm RUN_URL=http://x/runs/1 \
    HEAL_WORKDIR="$tmp/wd" HEALER_STATE="$tmp/state" \
    SWARM_VERDICT_PATH="$tmp/absent-swarm-verdict" \
    CLAUDE_LIMIT_MARKER="$marker" \
    FORGEJO_TOKEN=dummy FORGEJO_API=http://127.0.0.1:9/api/v1/repos/x/y \
    "$@" bash "$here/../heal.sh" 2>&1
}
evidence_of() { sed -n 's/^heal: evidence at \([^ ]*\).*/\1/p' <<<"$1" | head -1; }

# AC3 — the healer wakes during a limit window (fresh marker) → DEFERS without
# consuming a ledger attempt, and the evidence dir records "deferred: limit window".
rm -f "$tmp/state/"*; rm -f "$marker"; touch "$marker"
if out="$(run_heal HEAL_AGENT_CMD="bash $tmp/bin/limit-agent.sh")"; then ec=0; else ec=$?; fi
[ "$ec" -eq 0 ]                                   || fail "heal: a limit window must defer with exit 0, got $ec"
[ "$(ls -A "$tmp/state")" = "" ]                  || fail "heal: a deferred incident must consume NO ledger attempt"
ev="$(evidence_of "$out")"
[ -n "$ev" ] && grep -qi "deferred: limit window" "$ev/deferred-limit.txt" \
  || fail "heal: the evidence dir must record 'deferred: limit window'"
pass=$((pass+1))

# AC3b — no marker, but the healer's OWN claude dies mid-diagnosis with a limit
# signature → it parks the host, defers, and consumes NO ledger attempt.
rm -f "$tmp/state/"*; rm -f "$marker"
if out="$(run_heal HEAL_AGENT_CMD="bash $tmp/bin/limit-agent.sh")"; then ec=0; else ec=$?; fi
[ "$ec" -eq 0 ]                     || fail "heal: a mid-diagnosis limit refusal must exit 0, got $ec"
[ -f "$marker" ]                    || fail "heal: a mid-diagnosis limit refusal must PARK the host"
[ "$(ls -A "$tmp/state")" = "" ]    || fail "heal: a mid-diagnosis limit refusal must consume NO ledger attempt"
pass=$((pass+1))

# AC4 — a real (non-limit) agent failure is unchanged: the healer still posts a
# diagnosis and writes its ledger (the storm brake stays armed).
rm -f "$tmp/state/"*; rm -f "$marker"
if out="$(run_heal HEAL_AGENT_CMD="bash $here/fixtures/stub-agent.sh")"; then ec=0; else ec=$?; fi
[ "$ec" -eq 0 ]                        || fail "heal: a normal incident must still exit 0"
echo "$out" | grep -q "CLASS: harness-infra" || fail "heal: a normal incident must still investigate"
[ "$(ls "$tmp/state" | wc -l)" -eq 1 ] || fail "heal: a normal incident must still write its ledger"
[ ! -f "$marker" ]                     || fail "heal: a normal incident must not park the host"
pass=$((pass+1))

echo "claude-call-guards: $pass groups passed"
