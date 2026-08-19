#!/usr/bin/env bash
# Offline test for record-run-result.sh (#574): main.mts's ONLY path from a
# captured RunResult into swarm.db rows. Drives the REAL script + REAL
# swarm-db.py against a throwaway db. Run:
#   bash .sandcastle/tests/record-run-result-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
script="$root/record-run-result.sh"
py="$root/swarm-db.py"

fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0

command -v python3 >/dev/null 2>&1 || fail "python3 is required to run these tests"
command -v jq >/dev/null 2>&1 || fail "jq is required to run these tests"

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
export SWARM_DB="$tmp/swarm.db"

db() { python3 "$py" --db "$SWARM_DB" "$@"; }
val() { python3 - "$SWARM_DB" "$1" <<'PY'
import sqlite3, sys
row = sqlite3.connect(sys.argv[1]).execute(sys.argv[2]).fetchone()
print("" if row is None or row[0] is None else row[0])
PY
}
count() { val "SELECT count(*) FROM $1"; }

db migrate

# --- one issue closed successfully, one iteration never reached close-report -
payload='{
  "stdout": "some agent prose\nSANDCASTLE_ATTEMPT issue=574 outcome=success commits=abc123,def456\nmore prose",
  "logFilePath": "/logs/run.log",
  "iterations": [
    {"sessionId": "sess-1", "sessionFilePath": "/logs/1.jsonl",
     "usage": {"inputTokens": 1000, "cacheCreationInputTokens": 200, "cacheReadInputTokens": 50, "outputTokens": 300}},
    {"sessionId": "sess-2", "sessionFilePath": "/logs/2.jsonl",
     "usage": {"inputTokens": 500, "cacheCreationInputTokens": 0, "cacheReadInputTokens": 0, "outputTokens": 100}}
  ]
}'
printf '%s' "$payload" | bash "$script" RUN1
[ "$?" -eq 0 ] || fail "record-run-result must always exit 0"

[ "$(val "SELECT status FROM attempts WHERE run_id='RUN1' AND issue=574")" = success ] \
  || fail "issue 574's attempt must read status=success"
[ "$(val "SELECT close_outcome FROM attempts WHERE run_id='RUN1' AND issue=574")" = success ] \
  || fail "issue 574's close_outcome must be success"
[ "$(val "SELECT commits FROM attempts WHERE run_id='RUN1' AND issue=574")" = "abc123,def456" ] \
  || fail "issue 574's commits not recorded verbatim"
[ "$(count "attempts WHERE run_id='RUN1'")" = 1 ] \
  || fail "the marker-less second iteration must NOT get an attempts row"

[ "$(val "SELECT input_tokens FROM spend WHERE run_id='RUN1' AND issue=574")" = 1250 ] \
  || fail "issue 574's spend input must fold cache tokens in (1000+200+50)"
[ "$(val "SELECT output_tokens FROM spend WHERE run_id='RUN1' AND issue=574")" = 300 ] \
  || fail "issue 574's spend output wrong"
[ "$(val "SELECT count(*) FROM spend WHERE run_id='RUN1' AND issue IS NULL")" = 1 ] \
  || fail "the marker-less second iteration must STILL get a spend row, issue NULL"
[ "$(val "SELECT input_tokens FROM spend WHERE run_id='RUN1' AND issue IS NULL")" = 500 ] \
  || fail "the marker-less iteration's spend input wrong"

[ "$(val "SELECT count(*) FROM events WHERE run_id='RUN1' AND kind='iteration' AND issue=574")" = 1 ] \
  || fail "issue 574 must get an iteration event"
grep -q "sess-1" <<<"$(val "SELECT detail FROM events WHERE run_id='RUN1' AND issue=574")" \
  || fail "the iteration event must carry the sessionId"
[ "$(val "SELECT evidence FROM events WHERE run_id='RUN1' AND issue=574")" = "/logs/1.jsonl" ] \
  || fail "the iteration event must carry the sessionFilePath"
[ "$(val "SELECT count(*) FROM events WHERE run_id='RUN1' AND kind='iteration' AND issue IS NULL")" = 1 ] \
  || fail "the marker-less second iteration must STILL get an iteration event"
[ "$(val "SELECT count(*) FROM events WHERE run_id='RUN1' AND kind='run-log'")" = 1 ] \
  || fail "RunResult.logFilePath must land as a run-scoped event"
[ "$(val "SELECT evidence FROM events WHERE run_id='RUN1' AND kind='run-log'")" = "/logs/run.log" ] \
  || fail "the run-log event must carry RunResult.logFilePath verbatim"
pass=$((pass+1))

# --- close_outcome reflects the GATE's verdict (refused), never the agent's --
#     self-declared "success" claim (close-report.sh's own #574 wiring).
payload2='{
  "stdout": "SANDCASTLE_ATTEMPT issue=600 outcome=refused commits=",
  "iterations": [{"sessionId": "sess-3", "sessionFilePath": "/logs/3.jsonl",
    "usage": {"inputTokens": 10, "cacheCreationInputTokens": 0, "cacheReadInputTokens": 0, "outputTokens": 5}}]
}'
printf '%s' "$payload2" | bash "$script" RUN2
[ "$(val "SELECT status FROM attempts WHERE run_id='RUN2' AND issue=600")" = fail ] \
  || fail "a refused outcome must leave attempts.status at the DB default 'fail' (never earned)"
[ "$(val "SELECT close_outcome FROM attempts WHERE run_id='RUN2' AND issue=600")" = refused ] \
  || fail "close_outcome must record 'refused'"
pass=$((pass+1))

# --- a retry within one iteration (two markers, same issue) dedupes to ONE ---
#     attempts row, keyed on the LAST (final) outcome — never two rows, never
#     the stale first-attempt outcome.
payload3='{
  "stdout": "SANDCASTLE_ATTEMPT issue=700 outcome=refused commits=\nagent fixes it and retries\nSANDCASTLE_ATTEMPT issue=700 outcome=success commits=feed00d",
  "iterations": [{"sessionId": "sess-4", "sessionFilePath": "/logs/4.jsonl",
    "usage": {"inputTokens": 10, "cacheCreationInputTokens": 0, "cacheReadInputTokens": 0, "outputTokens": 5}}]
}'
printf '%s' "$payload3" | bash "$script" RUN3
[ "$(count "attempts WHERE run_id='RUN3' AND issue=700")" = 1 ] \
  || fail "a same-issue retry must dedupe to exactly one attempts row"
[ "$(val "SELECT status FROM attempts WHERE run_id='RUN3' AND issue=700")" = success ] \
  || fail "the dedup must keep the LAST (final) outcome, not the first refusal"
[ "$(val "SELECT commits FROM attempts WHERE run_id='RUN3' AND issue=700")" = "feed00d" ] \
  || fail "the dedup must keep the LAST commits, not the empty first attempt's"
pass=$((pass+1))

# --- malformed stdin: never crashes, records nothing, exits 0 ----------------
printf 'not json {' | bash "$script" RUN4 || fail "malformed stdin must still exit 0"
[ "$(count "attempts WHERE run_id='RUN4'")" = 0 ] || fail "malformed stdin must record nothing"
pass=$((pass+1))

# --- no run-id argument: refuses cleanly, exits 0, records nothing -----------
printf '{}' | bash "$script" || fail "a missing run-id must still exit 0"
pass=$((pass+1))

echo "record-run-result: $pass groups passed"
