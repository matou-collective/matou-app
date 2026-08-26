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
# A claude whose stdout/exit we control, and which records the argv it was
# called with (CLAUDE_ARGV_LOG) so a test can assert what the PROMPT said.
# For the #510 failover tests it is also stateful: with CLAUDE_COUNT_FILE set
# it counts its calls, answers the SECOND call from CLAUDE_OUTPUT2/CLAUDE_EXIT2,
# and CLAUDE_TOKEN_LOG appends the CLAUDE_CODE_OAUTH_TOKEN each call ran with.
cat > "$tmp/bin/claude" <<'SH'
#!/usr/bin/env bash
[ -n "${CLAUDE_ARGV_LOG:-}" ] && printf '%s\n' "$*" > "$CLAUDE_ARGV_LOG"
[ -n "${CLAUDE_TOKEN_LOG:-}" ] && printf '%s\n' "${CLAUDE_CODE_OAUTH_TOKEN:-}" >> "$CLAUDE_TOKEN_LOG"
n=1
if [ -n "${CLAUDE_COUNT_FILE:-}" ]; then
  n="$(( $(cat "$CLAUDE_COUNT_FILE" 2>/dev/null || echo 0) + 1 ))"
  printf '%s' "$n" > "$CLAUDE_COUNT_FILE"
fi
if [ "$n" -ge 2 ] && [ -n "${CLAUDE_OUTPUT2+x}" ]; then
  printf '%s\n' "$CLAUDE_OUTPUT2"
  exit "${CLAUDE_EXIT2:-0}"
fi
printf '%s\n' "${CLAUDE_OUTPUT:-}"
exit "${CLAUDE_EXIT:-0}"
SH
chmod +x "$tmp/bin/curl" "$tmp/bin/claude"

active="$tmp/active-marker"           # #510 active-account marker, never the real /tmp one
db="$tmp/swarm.db"                    # #91 swarm.db trace mirror, never the real host one
logdir="$tmp/triage-logs"            # #91 durable host-side claude-log home

run_triage() {
  env -u MATTERMOST_URL -u MATTERMOST_BOT_TOKEN -u MATTERMOST_CHANNEL_ID \
    -u CLAUDE_CODE_OAUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN_B \
    PATH="$tmp/bin:$PATH" \
    FORGEJO_TOKEN=dummy FORGEJO_API=http://x/api/v1/repos/x/y \
    CLAUDE_LIMIT_MARKER="$marker" CLAUDE_ACTIVE_MARKER="$active" \
    TRIAGE_VERDICT_PATH="$verdict" \
    SWARM_DB="$db" TRIAGE_LOGDIR="$logdir" \
    HOST_CAPACITY_DRIVE_WANTED="$tmp/drive-wanted-absent-by-default" \
    TRIAGE_DRIVE_DEFER_COUNT="$tmp/triage-defer-count" \
    "$@" bash "$here/../run-triage.sh"
}

# swarm.db assertions (#91): the mirror is a plain SQLite file — read it back
# directly with python3 (the same engine swarm-db.py uses; the sqlite3 CLI is
# not guaranteed on every host). dbq <sql> prints tab-separated rows.
dbq() {
  python3 - "$db" "$1" <<'PY'
import sqlite3, sys
try:
    c = sqlite3.connect(sys.argv[1])
    for r in c.execute(sys.argv[2]):
        print("\t".join("" if x is None else str(x) for x in r))
except sqlite3.OperationalError:
    pass   # no db yet (a deferred tick wrote nothing) — no rows
PY
}
db_reset() { rm -f "$db" "$db-wal" "$db-shm" 2>/dev/null; rm -rf "$logdir" 2>/dev/null; }

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

# drive reservation (#663/#664/#30) — a FRESH reservation makes triage stand
# down before calling the /triage skill, exit 0, leave NO verdict, and climb its
# own consecutive-defer count; an EXPIRED (mtime > TTL) reservation does not.
drive="$tmp/drive-wanted"; defer="$tmp/triage-defer-count"
rm -f "$marker" "$verdict" "$defer"
: > "$drive"
out="$(run_triage HOST_CAPACITY_DRIVE_WANTED="$drive" CLAUDE_EXIT=0 \
  CLAUDE_OUTPUT="TRIAGE-SKILL-RAN" 2>&1)" \
  || fail "a drive-yield must exit 0 (got: $out)"
grep -q "yielding this run to a ready drive" <<<"$out" || fail "a standing reservation must be reported (got: $out)"
grep -q "skipped 1 consecutive tick(s)" <<<"$out" || fail "the first deferred tick must read skipped 1 (got: $out)"
grep -q "TRIAGE-SKILL-RAN" <<<"$out" && fail "a drive-yield must stop BEFORE the /triage skill runs (got: $out)"
[ ! -f "$verdict" ] || fail "a drive-yield is a clean exit — no verdict, got: $(cat "$verdict")"
[ "$(cat "$defer")" = 1 ] || fail "the first deferred tick must leave a defer count of 1, got: $(cat "$defer" 2>/dev/null)"
out2="$(run_triage HOST_CAPACITY_DRIVE_WANTED="$drive" CLAUDE_EXIT=0 CLAUDE_OUTPUT="TRIAGE-SKILL-RAN" 2>&1)"
grep -q "skipped 2 consecutive tick(s)" <<<"$out2" || fail "the count must climb on a second consecutive defer (got: $out2)"
# expired reservation (mtime older than the TTL) must NOT defer — the tick proceeds.
touch -d '@1' "$drive"
out3="$(run_triage HOST_CAPACITY_DRIVE_WANTED="$drive" CLAUDE_EXIT=0 CLAUDE_OUTPUT="TRIAGE-SKILL-RAN" 2>&1)"
grep -q "TRIAGE-SKILL-RAN" <<<"$out3" || fail "an expired reservation must let the tick proceed to the skill (got: $out3)"
[ -f "$defer" ] && fail "proceeding past the reservation must reset the consecutive-defer counter"
rm -f "$drive"
pass=$((pass+1))

# two-way-door POINTER (#42) — the /triage prompt tells the agent to rule
# judgement calls itself under ADR 0174, and used to hand it a literal
# `docs/adr/0174-*.md`: a path that exists only in Matou/idss and 404s in every
# other consumer. The pointer now comes from the per-repo POLICY layer, and an
# undeclared repo is told so IN WORDS rather than sent to a missing file.
argv="$tmp/claude-argv"
policy="$tmp/swarm-policy.sh"
rm -f "$marker" "$verdict" "$argv"
printf 'TWO_WAY_DOOR_DOC=docs/adr/0001-*.md\n' > "$policy"
run_triage CLAUDE_EXIT=0 CLAUDE_OUTPUT=ok CLAUDE_ARGV_LOG="$argv" \
  SWARM_POLICY_FILE="$policy" >/dev/null 2>&1 \
  || fail "a triage run with a declared TWO_WAY_DOOR_DOC must still exit 0"
grep -q "RULE it yourself under ADR 0174" "$argv" \
  || fail "the prompt must keep the inherited audit-trail vocabulary, got: $(cat "$argv")"
grep -qF 'docs/adr/0001-*.md' "$argv" \
  || fail "the repo's DECLARED two-way-door record must reach the prompt, got: $(cat "$argv")"
grep -qF 'docs/adr/0174-' "$argv" \
  && fail "no other repo's decision-record PATH may appear in the prompt, got: $(cat "$argv")"
pass=$((pass+1))

rm -f "$marker" "$verdict" "$argv"
run_triage CLAUDE_EXIT=0 CLAUDE_OUTPUT=ok CLAUDE_ARGV_LOG="$argv" \
  SWARM_POLICY_FILE="$tmp/no-such-policy.sh" >/dev/null 2>&1 \
  || fail "a triage run with no policy file must still exit 0"
grep -q 'docs/adr/' "$argv" \
  && fail "a repo declaring no record must get NO decision-record path, got: $(cat "$argv")"
grep -q "declares no local record" "$argv" \
  || fail "an undeclared repo must be told so in words, got: $(cat "$argv")"
grep -q "RULE it yourself under ADR 0174" "$argv" \
  || fail "the self-ruling instruction must survive an undeclared pointer, got: $(cat "$argv")"
pass=$((pass+1))

# FACTORY doc paths (#47) — the counterpart to the per-repo pointer above, and
# the reason this scenario asserts on `docs/` rather than `docs/adr/`. The
# prompt also carried `docs/agents/triage-labels.md` for the `## Why human`
# rule; `docs/**` is vendor-excluded, so that resolved only in a repo keeping
# its own copy (`matou-app` carries no `docs/agents/` at all). A factory doc is
# not a policy knob — the doctrine is already factory-owned and rendered
# (`policy_trigger_guidance one-way-door`) — so the prompt STATES the rule.
# judgement-call-prompts-test.sh greps the source; this asserts the ASSEMBLED
# prompt, the text a triage agent actually receives, under BOTH policy states.
rm -f "$marker" "$verdict" "$argv"
printf 'TWO_WAY_DOOR_DOC=docs/adr/0001-*.md\n' > "$policy"
run_triage CLAUDE_EXIT=0 CLAUDE_OUTPUT=ok CLAUDE_ARGV_LOG="$argv" \
  SWARM_POLICY_FILE="$policy" >/dev/null 2>&1 \
  || fail "a triage run must exit 0 while asserting the doc-path bar"
# The ONLY doc path allowed in the assembled prompt is the one this repo
# declared for itself two scenarios up; nothing the factory owns may be linked.
stray="$(grep -o 'docs/[0-9A-Za-z*_./-]*' "$argv" | sort -u | grep -vF 'docs/adr/0001-*.md' || true)"
[ -n "$stray" ] \
  && fail "the prompt handed a factory doc path to the triage agent (docs/** is vendor-excluded — state the doctrine, do not link it): $stray"
grep -q '## Why human' "$argv" \
  || fail "the one-way-door bar must still require a \`## Why human\` line, got: $(cat "$argv")"
grep -q 'human residue' "$argv" \
  || fail "the prompt must state what that line carries, mirroring policy_trigger_guidance one-way-door, got: $(cat "$argv")"

rm -f "$marker" "$verdict" "$argv"
run_triage CLAUDE_EXIT=0 CLAUDE_OUTPUT=ok CLAUDE_ARGV_LOG="$argv" \
  SWARM_POLICY_FILE="$tmp/no-such-policy.sh" >/dev/null 2>&1 \
  || fail "an undeclared triage run must exit 0 while asserting the doc-path bar"
grep -q 'docs/' "$argv" \
  && fail "an undeclared repo must receive a prompt with NO doc path at all, got: $(cat "$argv")"
grep -q '## Why human' "$argv" \
  || fail "the one-way-door bar must survive an undeclared pointer, got: $(cat "$argv")"
pass=$((pass+1))

# ── two-account failover (#510) ────────────────────────────────────────────
# Triage was the ONE claude caller without it: with only the primary (A) token
# it refused on A's exhausted window and — worse — claude_limit_park'd the
# HOST-GLOBAL marker, parking every caller on the host (workers holding a
# perfectly good standby token included) for another TTL. It now rides
# claude_select_token + claude_failover exactly like heal.sh.

# a limit refusal on A with a standby configured fails over to B, retries
# once, succeeds — exit 0, host NOT parked, second call on the B token.
count="$tmp/claude-count"; toklog="$tmp/token-log"
rm -f "$marker" "$verdict" "$active" "$count" "$toklog"
out="$(run_triage CLAUDE_CODE_OAUTH_TOKEN=tokA CLAUDE_CODE_OAUTH_TOKEN_B=tokB \
  CLAUDE_COUNT_FILE="$count" CLAUDE_TOKEN_LOG="$toklog" \
  CLAUDE_EXIT=1 CLAUDE_OUTPUT="You've hit your weekly limit · resets Aug 1, 8am (UTC)" \
  CLAUDE_EXIT2=0 CLAUDE_OUTPUT2="triaged everything" 2>&1)" \
  || fail "a limit refusal with a standby must fail over and exit 0 (got: $out)"
grep -q "failed over to account B" <<<"$out" || fail "the failover must be reported (got: $out)"
[ ! -f "$marker" ] || fail "a successful failover must NOT park the host (marker exists)"
[ "$(cat "$active")" = "B" ] || fail "the active-account marker must read B after failover, got: $(cat "$active" 2>/dev/null)"
[ "$(printf '%s\n' tokA tokB)" = "$(cat "$toklog")" ] \
  || fail "the retry must run on the standby token (calls: $(tr '\n' ' ' < "$toklog"))"
[ ! -f "$verdict" ] || fail "a failover retry that succeeds must leave no verdict, got: $(cat "$verdict")"
pass=$((pass+1))

# a fresh B marker steers the FIRST call to the standby token (select, not just
# failover) — the account the rest of the host already failed over to.
rm -f "$marker" "$verdict" "$count" "$toklog"
printf 'B' > "$active"
run_triage CLAUDE_CODE_OAUTH_TOKEN=tokA CLAUDE_CODE_OAUTH_TOKEN_B=tokB \
  CLAUDE_TOKEN_LOG="$toklog" CLAUDE_EXIT=0 CLAUDE_OUTPUT=ok >/dev/null 2>&1 \
  || fail "a clean run under a fresh B marker must exit 0"
[ "$(cat "$toklog")" = "tokB" ] || fail "a fresh B marker must select the standby token, got: $(cat "$toklog")"
pass=$((pass+1))

# BOTH windows exhausted: the second refusal parks the host and exits clean —
# the pre-#510 behaviour, now only after both accounts were tried.
rm -f "$marker" "$verdict" "$active" "$count" "$toklog"
out="$(run_triage CLAUDE_CODE_OAUTH_TOKEN=tokA CLAUDE_CODE_OAUTH_TOKEN_B=tokB \
  CLAUDE_COUNT_FILE="$count" \
  CLAUDE_EXIT=1 CLAUDE_OUTPUT="You've hit your weekly limit · resets Aug 1, 8am (UTC)" \
  CLAUDE_EXIT2=1 CLAUDE_OUTPUT2="You've hit your weekly limit · resets Aug 1, 8am (UTC)" 2>&1)" \
  || fail "both windows exhausted must still exit clean (got: $out)"
[ -f "$marker" ] || fail "both windows exhausted must park the host"
[ "$(cat "$count")" = 2 ] || fail "both accounts must have been tried, got $(cat "$count" 2>/dev/null) call(s)"
pass=$((pass+1))

# no standby configured: today's single-account behaviour is unchanged — one
# refusal, quiet park, clean exit.
rm -f "$marker" "$verdict" "$active" "$count"
out="$(run_triage CLAUDE_COUNT_FILE="$count" \
  CLAUDE_EXIT=1 CLAUDE_OUTPUT="You've hit your weekly limit · resets Aug 1, 8am (UTC)" 2>&1)" \
  || fail "a single-account limit refusal must exit clean (got: $out)"
[ -f "$marker" ] || fail "a single-account limit refusal must park the host"
[ "$(cat "$count")" = 1 ] || fail "with no standby there is nothing to retry, got $(cat "$count" 2>/dev/null) call(s)"
pass=$((pass+1))

# ── swarm.db trace + durable claude log (#91) ──────────────────────────────
# A triage that reaches the claude call opens a run row (trigger `triage`) and a
# process row (kind `triage`); both close on exit with the run's verdict, the
# captured claude log is MOVED to the durable logdir (never rm -f'd) and its
# path recorded as a run-scoped event. A deferred/yielded tick records NOTHING.

# happy path — a clean triage records a finalised run + process row, verdict
# `triaged`, repo-scoped; the log lands in the durable logdir with an event.
db_reset; rm -f "$marker" "$verdict"
run_triage CLAUDE_EXIT=0 CLAUDE_OUTPUT="TRIAGE-LOG-BODY triaged everything" >/dev/null 2>&1 \
  || fail "91a: a healthy triage must exit 0"
[ "$(dbq "SELECT trigger FROM runs")" = triage ] \
  || fail "91a: the run row must carry trigger 'triage' (got: $(dbq "SELECT trigger FROM runs"))"
[ "$(dbq "SELECT verdict FROM runs")" = triaged ] \
  || fail "91a: a clean triage must record verdict 'triaged' (got: $(dbq "SELECT verdict FROM runs"))"
[ "$(dbq "SELECT ended_at IS NOT NULL FROM runs")" = 1 ] \
  || fail "91a: the run row must be finalised on exit (ended_at set)"
[ -n "$(dbq "SELECT repo FROM runs WHERE repo IS NOT NULL")" ] \
  || fail "91a: the run row must be repo-scoped (the fleet monitor filters by runs.repo)"
[ "$(dbq "SELECT kind FROM processes")" = triage ] \
  || fail "91a: the live process row must be kind 'triage' (got: $(dbq "SELECT kind FROM processes"))"
[ "$(dbq "SELECT ended_at IS NOT NULL FROM processes")" = 1 ] \
  || fail "91a: the process row must be finalised on exit (ended_at set)"
[ "$(dbq "SELECT kind FROM events WHERE kind='triage_log'")" = triage_log ] \
  || fail "91a: the moved claude log must be recorded as a run-scoped 'triage_log' event"
moved="$(dbq "SELECT detail FROM events WHERE kind='triage_log'")"
[ -n "$moved" ] && [ -f "$moved" ] \
  || fail "91a: the event detail must be the durable log path, and the file must exist there (got: $moved)"
case "$moved" in "$logdir"/*) ;; *) fail "91a: the log must move UNDER the durable logdir (got: $moved)" ;; esac
grep -q "TRIAGE-LOG-BODY" "$moved" \
  || fail "91a: the durable log must carry the captured claude output (got: $(cat "$moved" 2>/dev/null))"
pass=$((pass+1))

# real fault — a non-limit claude failure still finalises both rows (verdict
# derived, exit recorded) AND preserves the log as evidence; verdict still lands.
db_reset; rm -f "$marker" "$verdict"
run_triage CLAUDE_EXIT=1 CLAUDE_OUTPUT="fatal: triage exploded at line-91" >/dev/null 2>&1 \
  && fail "91b: a real fault must red (non-zero exit)"
[ "$(dbq "SELECT exit_code FROM runs")" = 1 ] \
  || fail "91b: a faulted run must record its non-zero exit (got: $(dbq "SELECT exit_code FROM runs"))"
[ "$(dbq "SELECT ended_at IS NOT NULL FROM runs")" = 1 ] \
  || fail "91b: the run row must be finalised even on the failure path"
[ "$(dbq "SELECT ended_at IS NOT NULL FROM processes")" = 1 ] \
  || fail "91b: the process row must be finalised even on the failure path"
[ -f "$verdict" ] \
  || fail "91b: the #18 verdict must still land (recording must not swallow it)"
moved="$(dbq "SELECT detail FROM events WHERE kind='triage_log'")"
[ -n "$moved" ] && [ -f "$moved" ] \
  || fail "91b: a faulted run's log must be preserved as evidence (got: $moved)"
grep -qF "fatal: triage exploded at line-91" "$moved" \
  || fail "91b: the preserved log must carry the fault's error lines (got: $(cat "$moved" 2>/dev/null))"
pass=$((pass+1))

# limit-parked AFTER a refusal — recorded (the claude call was reached), verdict
# `limit-parked`, both rows finalised, clean exit.
db_reset; rm -f "$marker" "$verdict" "$active"
run_triage CLAUDE_EXIT=1 CLAUDE_OUTPUT="You've hit your weekly limit · resets Aug 1, 8am (UTC)" >/dev/null 2>&1 \
  || fail "91c: a single-account limit refusal must exit clean"
[ "$(dbq "SELECT verdict FROM runs")" = limit-parked ] \
  || fail "91c: a limit-parked triage must record verdict 'limit-parked' (got: $(dbq "SELECT verdict FROM runs"))"
[ "$(dbq "SELECT ended_at IS NOT NULL FROM runs")" = 1 ] \
  || fail "91c: the run row must be finalised on the limit-park path"
[ "$(dbq "SELECT ended_at IS NOT NULL FROM processes")" = 1 ] \
  || fail "91c: the process row must be finalised on the limit-park path"
pass=$((pass+1))

# a deferred/yielded tick records NO run row: nothing untriaged, a fresh
# limit-park marker, and a standing drive reservation each return before the
# claude call — none may open a run.
db_reset; rm -f "$marker" "$verdict"
cat > "$tmp/bin/curl" <<'SH'
#!/usr/bin/env bash
url="${*: -1}"
case "$url" in
  *labels=*) echo '[]' ;;
  *state=open*) echo '[]' ;;                                          # nothing untriaged
  */repos/x/y) echo '{"permissions":{"push":true}}' ;;
  *) echo '[]' ;;
esac
SH
chmod +x "$tmp/bin/curl"
run_triage CLAUDE_EXIT=0 CLAUDE_OUTPUT=ok >/dev/null 2>&1 \
  || fail "91d: a nothing-to-triage tick must exit 0"
[ -z "$(dbq "SELECT run_id FROM runs")" ] \
  || fail "91d: a nothing-to-triage tick must open NO run row (got: $(dbq "SELECT run_id FROM runs"))"
# restore the one-untriaged-issue curl for the parked/drive checks below.
cat > "$tmp/bin/curl" <<'SH'
#!/usr/bin/env bash
url="${*: -1}"
case "$url" in
  *labels=*) echo '[]' ;;
  *state=open*) echo '[{"number":999,"title":"t","html_url":"http://x/999","labels":[]}]' ;;
  */repos/x/y) echo '{"permissions":{"push":true}}' ;;
  *) echo '[]' ;;
esac
SH
chmod +x "$tmp/bin/curl"
db_reset
: > "$marker"   # a fresh limit-park marker → the pre-claude limit gate yields
run_triage CLAUDE_EXIT=0 CLAUDE_OUTPUT=ok >/dev/null 2>&1 \
  || fail "91d: a limit-parked (pre-claude) tick must exit 0"
[ -z "$(dbq "SELECT run_id FROM runs")" ] \
  || fail "91d: a pre-claude limit-parked tick must open NO run row (got: $(dbq "SELECT run_id FROM runs"))"
rm -f "$marker"
db_reset
: > "$tmp/drive-wanted"
run_triage HOST_CAPACITY_DRIVE_WANTED="$tmp/drive-wanted" CLAUDE_EXIT=0 CLAUDE_OUTPUT=ok >/dev/null 2>&1 \
  || fail "91d: a drive-yield tick must exit 0"
[ -z "$(dbq "SELECT run_id FROM runs")" ] \
  || fail "91d: a drive-yielded tick must open NO run row (got: $(dbq "SELECT run_id FROM runs"))"
rm -f "$tmp/drive-wanted"
pass=$((pass+1))

echo "run-triage: $pass scenarios passed"
