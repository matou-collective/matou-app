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
# #2112: model main.mts's real exit ordering when a case wires MOUNT_ATTEMPTS_DIR —
# PERSIST the captured mount sink to the host path execute-lib reads post-run
# (SWARM_HOST_ATTEMPTS_SINK, which run-swarm also points EXECUTE_ATTEMPTS_SINK at),
# THEN rmSync the run-scoped mount dir (driveMirrorStop). Proves the post-run sink
# read survives the worker's own teardown of the mount it was written into.
if [ -n "${MOUNT_ATTEMPTS_DIR:-}" ]; then
  cat "$MOUNT_ATTEMPTS_DIR/attempts.log" > "${SWARM_HOST_ATTEMPTS_SINK:?}" 2>/dev/null || true
  rm -rf "$MOUNT_ATTEMPTS_DIR"
fi
exit "$rc"
SH
chmod +x "$tmp/bin/pnpm"
export PATH="$tmp/bin:$PATH" FIXTURES="$tmp" ATTEMPTS="$tmp/attempts"

reset() { rm -f "$tmp"/attempt-* "$tmp/attempts" "$NOTIFY_LOG" "$tmp/db.log" \
                "$CLAUDE_LIMIT_MARKER" "$CLAUDE_ACTIVE_MARKER" "$EXECUTE_AUTH_MARKER"
          SWARM_EXIT_REASON=""; EXECUTE_YIELDED_TO_DRIVE=""; }
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
[ -z "$EXECUTE_YIELDED_TO_DRIVE" ] || fail "a plain success must not read as a drive yield"
pass=$((pass+1))

# ── 1c. the SANDCASTLE_ATTEMPT capture for the false-green reconcile (#283) ──
# On success the log is cleaned, but the host's land-rollback reconcile needs the
# run's close-report attempt lines AFTER this returns. When EXECUTE_ATTEMPTS_FILE
# is wired, the attempt protocol lines are preserved into it — and ONLY those, not
# the worker's ordinary stdout.
reset; fixture default '0
iteration 1 done
SANDCASTLE_ATTEMPT issue=444 outcome=success commits=deadbee
some other chatter'
EXECUTE_ATTEMPTS_FILE="$tmp/attempts-capture.log" run
[ "$RC" = 0 ] || fail "the capture case is still a success, got $RC"
[ ! -f "$tmp/sandcastle.log" ] || fail "the log is still cleaned when attempts are captured"
grep -qxE 'SANDCASTLE_ATTEMPT issue=444 outcome=success commits=deadbee' "$tmp/attempts-capture.log" \
  || fail "#283: the SANDCASTLE_ATTEMPT line must be preserved for the reconcile: $(cat "$tmp/attempts-capture.log" 2>/dev/null)"
! grep -q 'other chatter' "$tmp/attempts-capture.log" \
  || fail "#283: only the attempt protocol lines are preserved, not ordinary stdout"
EXECUTE_ATTEMPTS_FILE=""
pass=$((pass+1))

# ── 1d. #2106: the attempt record survives a worker that `| tail`'d close-report ─
# Run 57327: a worker invoked `close-report.sh 2099 … 2>&1 | tail -40`, so the
# SANDCASTLE_ATTEMPT line was pushed out of the tail window and NEVER reached the
# sandcastle log — the log grep came up empty and #283's reconcile could not fire
# on a genuinely stranded close. close-report ALSO appends the line to the
# host-mounted sink (EXECUTE_ATTEMPTS_SINK), a channel no trailing pipe on its
# stdout can drop; the capture must recover it from there even though the log
# never carried it.
reset; fixture default '0
iteration 1 done
(the close-report line was piped through | tail -40 and truncated away)'
printf 'SANDCASTLE_ATTEMPT issue=2099 outcome=success commits=cafe123\n' > "$tmp/sink.log"
EXECUTE_ATTEMPTS_FILE="$tmp/attempts-capture.log" EXECUTE_ATTEMPTS_SINK="$tmp/sink.log" run
[ "$RC" = 0 ] || fail "the sink case is still a success, got $RC"
grep -qxE 'SANDCASTLE_ATTEMPT issue=2099 outcome=success commits=cafe123' "$tmp/attempts-capture.log" \
  || fail "#2106: a tail-swallowed attempt line must be recovered from the host sink: $(cat "$tmp/attempts-capture.log" 2>/dev/null)"
EXECUTE_ATTEMPTS_FILE=""; EXECUTE_ATTEMPTS_SINK=""
pass=$((pass+1))

# ── 1e. #2106: a line on BOTH channels is deduped (sort -u), never doubled ──────
# The ordinary case — the worker did NOT munge stdout, so the line reaches both the
# log AND the sink. The union must collapse the identical line to one row, or the
# reconcile would read (and comment on) the same stranded close twice.
reset; fixture default '0
iteration 1 done
SANDCASTLE_ATTEMPT issue=2099 outcome=success commits=cafe123'
printf 'SANDCASTLE_ATTEMPT issue=2099 outcome=success commits=cafe123\n' > "$tmp/sink.log"
EXECUTE_ATTEMPTS_FILE="$tmp/attempts-capture.log" EXECUTE_ATTEMPTS_SINK="$tmp/sink.log" run
[ "$(grep -c 'issue=2099' "$tmp/attempts-capture.log")" = 1 ] \
  || fail "#2106: a line on BOTH channels must dedupe to one row, got: $(cat "$tmp/attempts-capture.log")"
EXECUTE_ATTEMPTS_FILE=""; EXECUTE_ATTEMPTS_SINK=""
pass=$((pass+1))

# ── 1f. #2112: the sink survives main.mts's driveMirrorStop teardown ───────
# #2106's sink read is defeated in production unless the sink OUTLIVES the worker
# process: main.mts's driveMirrorStop() rmSync's the run-scoped attempts mount on
# EVERY exit, and execute-lib reads EXECUTE_ATTEMPTS_SINK only AFTER `pnpm run
# sandcastle` (main.mts) returns. So the sink execute-lib reads must be a host path
# main.mts PERSISTED before teardown (#2112), NOT a file inside the torn-down mount —
# or the union degrades right back to the truncatable log grep. Model the real
# ordering: the worker's close-report line reached the host ONLY via the mounted sink
# (its stdout log was `| tail`'d away), main.mts copies that to the persisted sink and
# THEN removes the mount, and only after `pnpm` returns does execute-lib read. The
# earlier sink cases pre-wrote a sink and deleted nothing, so they stayed green even
# with the sink inside the doomed mount; this one removes it and still must recover.
reset; fixture default '0
iteration 1 done
(the close-report line was piped through | tail -40 and truncated away)'
mkdir -p "$tmp/attempts-mount"
printf 'SANDCASTLE_ATTEMPT issue=2112 outcome=success commits=beef456\n' > "$tmp/attempts-mount/attempts.log"
EXECUTE_ATTEMPTS_FILE="$tmp/attempts-capture.log" \
  SWARM_HOST_ATTEMPTS_SINK="$tmp/persist-sink.log" \
  EXECUTE_ATTEMPTS_SINK="$tmp/persist-sink.log" \
  MOUNT_ATTEMPTS_DIR="$tmp/attempts-mount" run
[ "$RC" = 0 ] || fail "the teardown-ordering case is still a success, got $RC"
[ ! -d "$tmp/attempts-mount" ] || fail "#2112: the shim must model driveMirrorStop removing the run-scoped mount dir"
grep -qxE 'SANDCASTLE_ATTEMPT issue=2112 outcome=success commits=beef456' "$tmp/attempts-capture.log" \
  || fail "#2112: the attempt must survive the mount teardown via the persisted sink: $(cat "$tmp/attempts-capture.log" 2>/dev/null)"
EXECUTE_ATTEMPTS_FILE=""; EXECUTE_ATTEMPTS_SINK=""
rm -f "$tmp/persist-sink.log"
pass=$((pass+1))

# ── 1b. success that stood down for a drive mid-run (#111) ────────────────
# main.mts's marker line on an otherwise successful run: still rc 0 (the work
# lands as usual), log cleaned, but the flag run-swarm turns into
# reason=yielded-to-drive is set. Never a retry, never a notice here.
reset; fixture default '0
iteration 1 done
SANDCASTLE_YIELDED_TO_DRIVE run=run-1'
run
[ "$RC" = 0 ] || fail "a drive-yielded run is a SUCCESS (rc 0), got $RC"
[ "$EXECUTE_YIELDED_TO_DRIVE" = 1 ] || fail "the marker line must set EXECUTE_YIELDED_TO_DRIVE"
[ "$(cat "$tmp/attempts")" = 1 ] || fail "a yield must not retry"
[ ! -f "$tmp/sandcastle.log" ] || fail "a yielded success must clean up its log"
grep -q 'finished its current task and claimed nothing more' "$tmp/out" || fail "the yield must be narrated on stdout: $(cat "$tmp/out")"
[ ! -s "$NOTIFY_LOG" ] || fail "a yield posts nothing here: $(cat "$NOTIFY_LOG")"
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

# ── 3c. the #198 Claude-secret rewrite on failover ────────────────────────
# A worker reads its token through the mounted file its claude-fence shim reads,
# not the host env. So a failover must REWRITE that file to the account it just
# flipped to, before the retry — otherwise the retry's worker runs on the same
# dead/limited token. _execute_failover delegates the 0600 write to provision-
# lib (wired in via EXECUTE_SECRETS_DIR); here a recording stub proves the call
# ran with the flipped-to token. The write is OPTIONAL — a bare run with no
# secrets dir (the cases above) must not require it.
reset
mkdir -p "$tmp/sc/secrets"
EXECUTE_SECRETS_DIR="$tmp/sc"
provision_write_claude_secret() { printf '%s' "${CLAUDE_CODE_OAUTH_TOKEN:-}" > "$1/secrets/claude_oauth_token"; }
fixture 1 '1
Failed to authenticate: OAuth session expired'
fixture 2 '0
iteration 1 done'
CLAUDE_CODE_OAUTH_TOKEN=tok-A CLAUDE_CODE_OAUTH_TOKEN_B=tok-B run
[ "$RC" = 0 ] || fail "the auth failover must retry on the standby and succeed, got $RC"
[ "$(cat "$tmp/sc/secrets/claude_oauth_token")" = tok-B ] \
  || fail "#198: the failover must rewrite the mounted secret to the standby token, got '$(cat "$tmp/sc/secrets/claude_oauth_token" 2>/dev/null)'"
unset -f provision_write_claude_secret
EXECUTE_SECRETS_DIR=""
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
# #200: the limit marker is keyed by the exhausted account's token fingerprint
# (B, after the failover), not a single host-global path.
fpB="$(printf '%s' standby-token | sha256sum | cut -c1-12)"
[ -f "${CLAUDE_LIMIT_MARKER}-${fpB}" ] || fail "the park must stamp the fingerprinted limit marker"
# #100: the park edge is recorded per account — the marker names the exhausted
# account (B, after the failover) and swarm.db carries the paired park event.
[ "$(cat "${CLAUDE_LIMIT_MARKER}-${fpB}")" = B ] || fail "the marker must carry the exhausted account letter"
grep -q "limit-pause|park account=B fp=${fpB}" "$tmp/db.log" || fail "the park entry must record a per-account, fingerprinted limit-pause event: $(cat "$tmp/db.log")"
# and the dedupe holds — a re-hit of an ALREADY-parked account inside the hour
# posts no redundant notice (#238 dedupe, now keyed per account/fingerprint
# #200). Force the active account back to A so this run flips A→B and lands on
# B's still-fresh marker (in production the run-swarm limit gate stops the
# re-entry before execute-lib even runs; here we drive the path directly).
before="$(grep -c hourglass "$NOTIFY_LOG" || true)"
printf 'A' > "$CLAUDE_ACTIVE_MARKER"
rm -f "$tmp/attempts"; SWARM_EXIT_REASON=""
CLAUDE_CODE_OAUTH_TOKEN_B=standby-token run
[ "$(grep -c hourglass "$NOTIFY_LOG" || true)" = "$before" ] \
  || fail "a second park of the same (already-parked) account inside the hour must not re-post"
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

# ── 5b. #328: the generic red STILL captures the close-report attempt lines ──
# A worker can close its issue against the pushed worker branch and THEN red this
# stage — LANDING=push's post-run merge-to-head SyncError is exactly that: the
# agent's close-report ran (SANDCASTLE_ATTEMPT on stdout), then the lifecycle merge
# threw and `pnpm run sandcastle` exited non-zero. That red reaches run-swarm two
# stages before landing_stage, so the ONLY way its #283 reconcile can reopen the
# stranded close is if execute-lib preserved the attempt lines on the red path too.
# The log is STILL left in place (the verdict reads it) — the capture must not clean it.
reset; fixture default '1
iteration 1 done
SANDCASTLE_ATTEMPT issue=324 outcome=success commits=8903a50
Git sync failed: Merge of ... onto main failed.
SyncError  (_tag: '"'"'Fail'"'"')'
EXECUTE_ATTEMPTS_FILE="$tmp/attempts-red.log" run
[ "$RC" = 1 ] || fail "#328: the merge-to-head SyncError is still a generic red (rc 1), got $RC"
[ "$SWARM_EXIT_REASON" = "sandcastle-run-failed" ] || fail "#328: the red keeps its reason, got '$SWARM_EXIT_REASON'"
[ -s "$tmp/sandcastle.log" ] || fail "#328: the log must STILL be left for the verdict on a red that also captures attempts"
grep -q 'SyncError' "$tmp/sandcastle.log" || fail "#328: the captured log must carry the real error"
grep -qxE 'SANDCASTLE_ATTEMPT issue=324 outcome=success commits=8903a50' "$tmp/attempts-red.log" \
  || fail "#328: the red path must preserve the close-report attempt line for the #283 reconcile: $(cat "$tmp/attempts-red.log" 2>/dev/null)"
! grep -q 'iteration 1 done' "$tmp/attempts-red.log" \
  || fail "#328: only the attempt protocol lines are preserved on the red path, not ordinary stdout"
EXECUTE_ATTEMPTS_FILE=""
pass=$((pass+1))

# ── 5c. #328: the red-path capture also recovers from the host sink ─────────
# Same tail-swallowed-stdout failure mode as #2106, but on the red path: the
# close-report line reached the host ONLY via the mounted sink, and the stage still
# reds. The capture must union the sink even when the log never carried the line.
reset; fixture default '1
(close-report was | tail'"'"'d away)
SyncError  (_tag: '"'"'Fail'"'"')'
printf 'SANDCASTLE_ATTEMPT issue=324 outcome=success commits=8903a50\n' > "$tmp/red-sink.log"
EXECUTE_ATTEMPTS_FILE="$tmp/attempts-red.log" EXECUTE_ATTEMPTS_SINK="$tmp/red-sink.log" run
[ "$RC" = 1 ] || fail "#328: still a red, got $RC"
grep -qxE 'SANDCASTLE_ATTEMPT issue=324 outcome=success commits=8903a50' "$tmp/attempts-red.log" \
  || fail "#328: the red path must recover a tail-swallowed attempt line from the host sink: $(cat "$tmp/attempts-red.log" 2>/dev/null)"
EXECUTE_ATTEMPTS_FILE=""; EXECUTE_ATTEMPTS_SINK=""
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

# ── 8. #329: execute_adopt_worker_branch — the push-mode post-run adoption ──
# branch-strategy.mts now pins a NAMED worker branch for LANDING=push too, so
# Sandcastle performs NO post-run merge onto `main`. The host adopts the branch
# onto HEAD with a conflict-free `git reset` so verify fingerprints the worker's
# tree and landing owns the only rebase (the ladder, where a stale base parks).
# Real git fixture (no docker, no network): a worker branch off the run's base
# carrying a machinery edit; adopting it must move HEAD onto the worker tip.
wb_repo="$tmp/wb-repo"
git init -q "$wb_repo"
git -C "$wb_repo" config user.email t@t; git -C "$wb_repo" config user.name t
mkdir -p "$wb_repo/.sandcastle"
printf 'base\n' > "$wb_repo/README"; git -C "$wb_repo" add -A
git -C "$wb_repo" commit -qm base
base_sha="$(git -C "$wb_repo" rev-parse HEAD)"
# the worker's work lives on a per-run named branch forked from the base (as
# Sandcastle's branch mode leaves it), including a machinery edit under .sandcastle/
git -C "$wb_repo" branch sandcastle/worker/testwb
git -C "$wb_repo" switch -q sandcastle/worker/testwb
printf 'edit\n' >> "$wb_repo/README"; printf 'x\n' > "$wb_repo/.sandcastle/touched"
git -C "$wb_repo" add -A; git -C "$wb_repo" commit -qm 'worker commit'
wb_tip="$(git -C "$wb_repo" rev-parse HEAD)"
git -C "$wb_repo" switch -q --detach "$base_sha"   # HEAD back at the run's base, as the host left it

RC=0; ( cd "$wb_repo" && execute_adopt_worker_branch sandcastle/worker/testwb ) || RC=$?
[ "$RC" = 0 ] || fail "#329: adopting an existing worker branch must succeed, got $RC"
[ "$(git -C "$wb_repo" rev-parse HEAD)" = "$wb_tip" ] \
  || fail "#329: adopt must move HEAD onto the worker tip (so verify/land see the worker's commits)"
[ -f "$wb_repo/.sandcastle/touched" ] \
  || fail "#329: the worker's machinery edit must be present in the tree after adoption (verify_protected_paths can then attribute it)"
pass=$((pass+1))

# a branch that was never created (worker committed nothing / died) is a no-op,
# rc 0, HEAD left exactly where it was — landing then finds nothing to push
git -C "$wb_repo" switch -q --detach "$base_sha"
RC=0; ( cd "$wb_repo" && execute_adopt_worker_branch sandcastle/worker/absent ) || RC=$?
[ "$RC" = 0 ] || fail "#329: an absent worker branch must be a silent no-op (rc 0), got $RC"
[ "$(git -C "$wb_repo" rev-parse HEAD)" = "$base_sha" ] \
  || fail "#329: an absent branch must leave HEAD at the run's base"
# and an empty branch name (a bare run / old pin that exported nothing) no-ops too
RC=0; ( cd "$wb_repo" && execute_adopt_worker_branch "" ) || RC=$?
[ "$RC" = 0 ] || fail "#329: an empty branch name must be a no-op, got $RC"
pass=$((pass+1))

# fail-loud: the branch EXISTS but the reset cannot run — the caller must get the
# generic red (so run-swarm's #283 reconcile reopens the stranded close), never a
# silent pass that verifies/lands a tree that is not the worker's. Shim git so the
# ref check passes but `reset` fails.
mkdir -p "$tmp/gitfail"
cat > "$tmp/gitfail/git" <<'SH'
#!/usr/bin/env bash
case "$1" in
  "rev-parse") exit 0 ;;   # the branch "exists"
  "reset")     exit 1 ;;   # ...but the reset cannot run
esac
exit 0
SH
chmod +x "$tmp/gitfail/git"
RC=0; SWARM_EXIT_REASON=""
PATH="$tmp/gitfail:$PATH" execute_adopt_worker_branch sandcastle/worker/testwb 2>"$tmp/adopt.err" || RC=$?
[ "$RC" = 1 ] || fail "#329: a branch that exists but cannot be adopted must fail LOUD (rc 1), got $RC"
[ "$SWARM_EXIT_REASON" = "worker-branch-adopt-failed" ] \
  || fail "#329: the fail-loud path must name the reason, got '$SWARM_EXIT_REASON'"
grep -q 'refusing to verify/land a tree that is not the worker' "$tmp/adopt.err" \
  || fail "#329: the fail-loud path must say why on stderr: $(cat "$tmp/adopt.err")"
pass=$((pass+1))

# ── 9. #329: execute_sandcastle_run WIRES the adoption + branch-name export ──
# The adoption is a sub-step of the run seam (it needs the host-side git lifecycle
# BEFORE verify), so it is proven here by structure: the run exports the per-run
# branch name for main.mts, and adopts it on the success tail under push mode only.
grep -q 'export SWARM_WORKER_BRANCH' "$sc/execute-lib.sh" \
  || fail "#329: execute_sandcastle_run must export SWARM_WORKER_BRANCH so main.mts and the host agree on the ref"
grep -q 'execute_adopt_worker_branch "\$SWARM_WORKER_BRANCH"' "$sc/execute-lib.sh" \
  || fail "#329: the success tail must adopt the worker branch"
grep -q 'SWARM_POLICY_LANDING:-}" = push' "$sc/execute-lib.sh" \
  || fail "#329: the adoption must be gated on LANDING=push (pr lands via the worker's PR; unset keeps merge-to-head)"
pass=$((pass+1))

echo "execute-lib: $pass groups passed"
