#!/usr/bin/env bash
# Offline test for execute-lib.sh — the EXECUTE seam of run-swarm.sh (#2): the
# `pnpm run sandcastle` worker loop and the four distinct shapes its failure can
# take. limit-lib.sh and cancel-lib.sh own the DETECTORS (and their own tests);
# what lived inline in run-swarm.sh — and lives here now — is the LOOP that
# classifies, fails over once, notices with an hourly dedupe, and picks one of
# three exits:
#
#   operator cancel (#612)  → clean stop, exit 0, never paged to the healer
#   auth-dead (#632)        → failover once, then a NAMED halt, never a red
#   usage limit (#510)      → failover once, then the quiet hourly park
#   anything else           → the generic red, log left for the verdict
#
# The ordering matters and is asserted: cancel is checked FIRST, auth BEFORE
# limit (a dead token must never wait out a "reset" that will never come).
#
# Run: bash .sandcastle/tests/execute-lib-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sc="$here/.."

fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"

# Pin every host-global marker at a per-test path BEFORE sourcing limit-lib, so
# this test can never read or write the real host's park/active-account state.
export CLAUDE_LIMIT_MARKER="$tmp/limit-marker"
export CLAUDE_ACTIVE_MARKER="$tmp/active-marker"
export EXECUTE_AUTH_MARKER="$tmp/auth-marker"
. "$sc/limit-lib.sh"
. "$sc/cancel-lib.sh"
. "$sc/verdict-lib.sh"
. "$sc/execute-lib.sh"

# Notify + swarm.db shims: record what the loop announced, so "posts ONE line"
# and "never pages the healer" are assertable.
export EXECUTE_NOTIFY="$tmp/bin/notify.sh"
cat > "$EXECUTE_NOTIFY" <<'SH'
#!/usr/bin/env bash
printf '%s\n---\n' "$1" >> "${NOTIFY_LOG:?}"
SH
chmod +x "$EXECUTE_NOTIFY"
export NOTIFY_LOG="$tmp/notify.log"
swarmdb_event() { printf '%s|%s\n' "$3" "$4" >> "$tmp/db.log"; }

# A `pnpm` that replays canned sandcastle output per attempt: attempt N reads
# $tmp/attempt-N (falling back to $tmp/attempt-default) and exits with the rc on
# its first line. Attempts are counted in a file so the loop's retry is visible.
cat > "$tmp/bin/pnpm" <<'SH'
#!/usr/bin/env bash
n=$(( $(cat "$ATTEMPTS" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$ATTEMPTS"
f="$FIXTURES/attempt-$n"; [ -f "$f" ] || f="$FIXTURES/attempt-default"
rc="$(head -1 "$f")"; tail -n +2 "$f"
exit "$rc"
SH
chmod +x "$tmp/bin/pnpm"
export PATH="$tmp/bin:$PATH" FIXTURES="$tmp" ATTEMPTS="$tmp/attempts"

reset() { rm -f "$tmp"/attempt-* "$tmp/attempts" "$NOTIFY_LOG" "$tmp/db.log" \
                "$CLAUDE_LIMIT_MARKER" "$CLAUDE_ACTIVE_MARKER" "$EXECUTE_AUTH_MARKER"
          SWARM_EXIT_REASON=""; }
fixture() { printf '%s\n' "$2" > "$tmp/attempt-$1"; }   # fixture <n> <rc\ntext>
run() { # run -> sets RC; never aborts the test
  RC=0
  execute_sandcastle_run "$tmp/sandcastle.log" run-1 Acme/widget Acme-widget >"$tmp/out" 2>&1 || RC=$?
}

# ── 1. the happy path ──────────────────────────────────────────────────────
reset; fixture default '0
iteration 1 done'
run
[ "$RC" = 0 ] || fail "a successful sandcastle run must return 0, got $RC"
[ "$(cat "$tmp/attempts")" = 1 ] || fail "success must not retry"
[ ! -f "$tmp/sandcastle.log" ] || fail "a successful run must clean up its log"
[ ! -s "$NOTIFY_LOG" ] || fail "a successful run must announce nothing: $(cat "$NOTIFY_LOG")"
pass=$((pass+1))

# ── 2. operator cancel (#612) — clean stop, unalarmed, never a red ─────────
reset; fixture default '1
SANDCASTLE_CANCELLED run=run-1 reason=operator pressed cancel'
run
[ "$RC" = "$EXECUTE_RC_STOP" ] || fail "a cancel must be a CLEAN stop (rc $EXECUTE_RC_STOP), got $RC"
[ "$SWARM_EXIT_REASON" = "cancelled:operator" ] \
  || fail "a cancel's verdict must be distinct from 'completed', got '$SWARM_EXIT_REASON'"
grep -q 'Swarm run cancelled' "$NOTIFY_LOG" || fail "a cancel must post its own notice: $(cat "$NOTIFY_LOG")"
grep -qi 'rotating_light' "$NOTIFY_LOG" && fail "a deliberate cancel must NOT be alarmed"
[ ! -f "$tmp/sandcastle.log" ] || fail "a cancel must clean up its log (no verdict is written)"
[ "$(cat "$tmp/attempts")" = 1 ] || fail "a cancel must never be retried"
pass=$((pass+1))

# cancel is checked FIRST: a log that carries a cancel line AND a limit line is
# a cancel, never a limit park.
reset; fixture default '1
SANDCASTLE_CANCELLED run=run-1 reason=stop
Claude AI usage limit reached|1970-01-01'
run
[ "$SWARM_EXIT_REASON" = "cancelled:operator" ] || fail "cancel must be classified before the limit guard"
pass=$((pass+1))

# ── 3. auth-dead (#632) — failover once, then a NAMED halt, never a red ────
reset
CLAUDE_CODE_OAUTH_TOKEN_B=standby-token
fixture 1 '1
Failed to authenticate: OAuth session expired'
fixture 2 '0
iteration 1 done'
CLAUDE_CODE_OAUTH_TOKEN_B=standby-token run
[ "$RC" = 0 ] || fail "an auth-dead first attempt must retry on the standby and succeed, got $RC"
[ "$(cat "$tmp/attempts")" = 2 ] || fail "auth-dead must retry exactly ONCE on the standby"
grep -q 'Swarm failover' "$NOTIFY_LOG" || fail "the failover must be announced: $(cat "$NOTIFY_LOG")"
grep -q 'auth-failover' "$tmp/db.log" || fail "the failover must be traced in swarm.db"
pass=$((pass+1))

# both accounts dead: a named halt at exit 0 — never the generic red, which
# would page the healer on a signature that degrades to the workflow name alone
reset
fixture default '1
Not logged in · Please run /login'
CLAUDE_CODE_OAUTH_TOKEN_B=standby-token run
[ "$RC" = "$EXECUTE_RC_STOP" ] || fail "both-accounts-dead must halt cleanly (rc $EXECUTE_RC_STOP), got $RC"
[ "$SWARM_EXIT_REASON" = "claude-auth-dead" ] || fail "the reason must name the auth death, got '$SWARM_EXIT_REASON'"
grep -q 'BOTH Claude accounts auth-dead' "$NOTIFY_LOG" || fail "the halt must name both accounts: $(cat "$NOTIFY_LOG")"
grep -q 'not logged in\|Not logged in' "$NOTIFY_LOG" || fail "the halt must quote the refusal line"
[ ! -f "$tmp/sandcastle.log" ] || fail "an auth halt must clean up its log (no verdict, no healer page)"
pass=$((pass+1))

# single-account host: same clean halt, notice names the ONE account
reset
fixture default '1
Not logged in · Please run /login'
env -u CLAUDE_CODE_OAUTH_TOKEN_B bash >/dev/null 2>&1 -c ':' || true
CLAUDE_CODE_OAUTH_TOKEN_B="" run
[ "$RC" = "$EXECUTE_RC_STOP" ] || fail "a single-account auth death must still halt cleanly"
grep -q 'BOTH Claude accounts' "$NOTIFY_LOG" && fail "a single-account host must not claim BOTH are dead"
grep -q 'Claude account A auth-dead' "$NOTIFY_LOG" || fail "the notice must name the account: $(cat "$NOTIFY_LOG")"
[ "$(cat "$tmp/attempts")" = 1 ] || fail "with no standby there is nothing to fail over to"
pass=$((pass+1))

# the hourly notice-dedupe: a queued-trigger burst against a dead token must not
# become its own storm (the 2026-07-25 shape)
reset
fixture default '1
Not logged in · Please run /login'
CLAUDE_CODE_OAUTH_TOKEN_B="" run
first="$(grep -c 'rotating_light' "$NOTIFY_LOG" || true)"
[ "$first" -ge 1 ] || fail "the FIRST auth death must alarm once"
rm -f "$tmp/attempts"; SWARM_EXIT_REASON=""
CLAUDE_CODE_OAUTH_TOKEN_B="" run
[ "$(grep -c 'rotating_light' "$NOTIFY_LOG" || true)" = "$first" ] \
  || fail "a second death inside the hour must NOT re-alarm: $(cat "$NOTIFY_LOG")"
touch -d '@1' "$EXECUTE_AUTH_MARKER"; rm -f "$tmp/attempts"; SWARM_EXIT_REASON=""
CLAUDE_CODE_OAUTH_TOKEN_B="" run
[ "$(grep -c 'rotating_light' "$NOTIFY_LOG" || true)" -gt "$first" ] \
  || fail "a stale marker must let the next outage alarm again"
pass=$((pass+1))

# ── 4. usage limit (#510) — failover once, then the quiet park ─────────────
reset
fixture 1 '1
Claude AI usage limit reached|1799999999'
fixture 2 '0
iteration 1 done'
CLAUDE_CODE_OAUTH_TOKEN_B=standby-token run
[ "$RC" = 0 ] || fail "a limited first account must retry on the standby, got $RC"
[ "$(cat "$tmp/attempts")" = 2 ] || fail "the limit failover must retry exactly ONCE"
grep -q 'limit-failover' "$tmp/db.log" || fail "the limit failover must be traced"
pass=$((pass+1))

reset
fixture default '1
Claude AI usage limit reached|1799999999'
CLAUDE_CODE_OAUTH_TOKEN_B=standby-token run
[ "$RC" = "$EXECUTE_RC_STOP" ] || fail "both windows exhausted must PARK (exit 0), never red — got $RC"
[ "$SWARM_EXIT_REASON" = "claude-limit-parked" ] || fail "reason should be claude-limit-parked, got '$SWARM_EXIT_REASON'"
grep -q 'BOTH Claude accounts limited' "$NOTIFY_LOG" || fail "the park must name both accounts: $(cat "$NOTIFY_LOG")"
grep -qi 'hourglass' "$NOTIFY_LOG" || fail "a limit park is a quiet notice, not an alarm"
[ -f "$CLAUDE_LIMIT_MARKER" ] || fail "the park must stamp the host-global limit marker"
# #100: the park edge is recorded per account — the marker names the exhausted
# account (B, after the failover) and swarm.db carries the paired park event.
[ "$(cat "$CLAUDE_LIMIT_MARKER")" = B ] || fail "the marker must carry the exhausted account letter"
grep -q 'limit-pause|park account=B' "$tmp/db.log" || fail "the park entry must record a per-account limit-pause event: $(cat "$tmp/db.log")"
# and the dedupe holds — one repo hitting the limit suppresses the other's
# redundant first notice for the SAME outage (#238: the marker is repo-agnostic)
before="$(grep -c hourglass "$NOTIFY_LOG" || true)"
rm -f "$tmp/attempts"; SWARM_EXIT_REASON=""
CLAUDE_CODE_OAUTH_TOKEN_B=standby-token run
[ "$(grep -c hourglass "$NOTIFY_LOG" || true)" = "$before" ] \
  || fail "a second park inside the hour must not re-post"
pass=$((pass+1))

# auth is checked BEFORE limit: a log carrying both shapes is an auth death, so
# it never waits out a reset that will never come
reset
fixture default '1
Not logged in · Please run /login
Claude AI usage limit reached|1799999999'
CLAUDE_CODE_OAUTH_TOKEN_B="" run
[ "$SWARM_EXIT_REASON" = "claude-auth-dead" ] || fail "auth must be classified before the limit guard, got '$SWARM_EXIT_REASON'"
pass=$((pass+1))

# ── 5. anything else — the generic red, with the log LEFT for the verdict ──
reset; fixture default '1
Error: worktree fence refused the checkout'
run
[ "$RC" = 1 ] || fail "an unclassified failure must be a red (rc 1), got $RC"
[ "$SWARM_EXIT_REASON" = "sandcastle-run-failed" ] || fail "reason should be sandcastle-run-failed, got '$SWARM_EXIT_REASON'"
[ -s "$tmp/sandcastle.log" ] \
  || fail "the log must be LEFT in place — the EXIT trap's verdict_write reads it for the error lines (#235)"
grep -q 'worktree fence refused' "$tmp/sandcastle.log" || fail "the captured log must carry the real error"
[ ! -s "$NOTIFY_LOG" ] || fail "a red posts nothing here (the run's own failure path does): $(cat "$NOTIFY_LOG")"
pass=$((pass+1))

# ── 6. the classifier, in isolation ───────────────────────────────────────
c() { printf '%s\n' "$1" > "$tmp/c.log"; execute_classify "$tmp/c.log"; }
[ "$(c 'SANDCASTLE_CANCELLED run=x reason=y')" = cancel ] || fail "classify cancel"
[ "$(c 'Failed to authenticate: token bad')"   = auth ]   || fail "classify auth"
[ "$(c 'You have hit your weekly limit')"      = limit ]  || fail "classify limit (the 2026-07-29 WEEKLY wording)"
[ "$(c 'some unrelated crash')"                = failed ] || fail "classify fallthrough"
pass=$((pass+1))

# ── 7. the limit-park EXIT observer (#100) ─────────────────────────────────
# A worker tick that starts with a STALE park marker closes that window with a
# paired unpark event for the account the marker names, then clears the marker
# so a later hit re-parks cleanly. The run itself is unaffected.
reset; fixture default '0
iteration 1 done'
printf 'B' > "$CLAUDE_LIMIT_MARKER"; touch -d '2 hours ago' "$CLAUDE_LIMIT_MARKER"
run
[ "$RC" = 0 ] || fail "the run itself still succeeds while sweeping a stale park, got $RC"
grep -q 'limit-pause|unpark account=B' "$tmp/db.log" \
  || fail "the exit observer must record the paired unpark for the marker's account: $(cat "$tmp/db.log")"
[ ! -f "$CLAUDE_LIMIT_MARKER" ] || fail "the sweep must clear the stale marker so a later hit re-parks"
pass=$((pass+1))

echo "execute-lib: $pass groups passed"
