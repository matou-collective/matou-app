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
# Hermetic to the host's active-account marker (limit-lib.sh reads this env):
# absent => claude_active_account defaults to A, so the suite never reads or
# depends on the real host's park/active state.
export CLAUDE_ACTIVE_MARKER="$tmp/active-marker"

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

# #96: the three token classes price ~10x apart — recorded SEPARATELY, never
# folded into one `input` number. input_tokens is FRESH input only.
[ "$(val "SELECT input_tokens FROM spend WHERE run_id='RUN1' AND issue=574")" = 1000 ] \
  || fail "issue 574's spend input must be FRESH input only (1000), not the folded total"
[ "$(val "SELECT cache_creation_tokens FROM spend WHERE run_id='RUN1' AND issue=574")" = 200 ] \
  || fail "issue 574's cache_creation_tokens must be recorded separately (200)"
[ "$(val "SELECT cache_read_tokens FROM spend WHERE run_id='RUN1' AND issue=574")" = 50 ] \
  || fail "issue 574's cache_read_tokens must be recorded separately (50)"
[ "$(val "SELECT output_tokens FROM spend WHERE run_id='RUN1' AND issue=574")" = 300 ] \
  || fail "issue 574's spend output wrong"
# The usage block here exposes neither a request count nor a model: requests
# falls back to 1 (no longer a hardcode — it reads .usage.requests first), model
# is left NULL rather than guessed.
[ "$(val "SELECT requests FROM spend WHERE run_id='RUN1' AND issue=574")" = 1 ] \
  || fail "issue 574's requests must fall back to 1 when the block exposes none"
[ -z "$(val "SELECT model FROM spend WHERE run_id='RUN1' AND issue=574")" ] \
  || fail "issue 574's model must read NULL when the block exposes none"
[ "$(val "SELECT count(*) FROM spend WHERE run_id='RUN1' AND issue IS NULL")" = 1 ] \
  || fail "the marker-less second iteration must STILL get a spend row, issue NULL"
[ "$(val "SELECT input_tokens FROM spend WHERE run_id='RUN1' AND issue IS NULL")" = 500 ] \
  || fail "the marker-less iteration's spend input wrong"
[ "$(val "SELECT cache_creation_tokens FROM spend WHERE run_id='RUN1' AND issue IS NULL")" = 0 ] \
  || fail "the marker-less iteration's cache_creation_tokens wrong (0)"
# #75: every spend row is stamped with the active account. No fresh B marker
# here => the default primary A on BOTH the attributed and the NULL-issue row.
[ "$(val "SELECT account FROM spend WHERE run_id='RUN1' AND issue=574")" = A ] \
  || fail "the attributed spend row must be stamped with the active account (A by default)"
[ "$(val "SELECT account FROM spend WHERE run_id='RUN1' AND issue IS NULL")" = A ] \
  || fail "the issue-less spend row must ALSO be stamped with the active account"

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

# --- #75: a fresh B active-account marker steers the stamp to B --------------
#     Proves record-run-result reads the LIVE host marker (limit-lib.sh), not a
#     hardcoded letter — the account the sandbox actually ran on.
printf 'B' > "$CLAUDE_ACTIVE_MARKER"
payloadB='{
  "stdout": "SANDCASTLE_ATTEMPT issue=800 outcome=success commits=cafe",
  "iterations": [{"sessionId": "sess-5", "sessionFilePath": "/logs/5.jsonl",
    "usage": {"inputTokens": 10, "cacheCreationInputTokens": 0, "cacheReadInputTokens": 0, "outputTokens": 5}}]
}'
printf '%s' "$payloadB" | bash "$script" RUNB
[ "$(val "SELECT account FROM spend WHERE run_id='RUNB' AND issue=800")" = B ] \
  || fail "a fresh B active-account marker must stamp the spend row with B"
rm -f "$CLAUDE_ACTIVE_MARKER"
pass=$((pass+1))

# --- #96: when the usage block exposes a real request count and model, they --
#     are recorded verbatim instead of the fallbacks (the #98 enrichment path).
payload96='{
  "stdout": "SANDCASTLE_ATTEMPT issue=960 outcome=success commits=b1ade",
  "iterations": [{"sessionId": "sess-9", "sessionFilePath": "/logs/9.jsonl",
    "usage": {"inputTokens": 40, "cacheCreationInputTokens": 8, "cacheReadInputTokens": 800,
              "outputTokens": 20, "requests": 7, "model": "claude-opus-4-8"}}]
}'
printf '%s' "$payload96" | bash "$script" RUN96
[ "$(val "SELECT requests FROM spend WHERE run_id='RUN96' AND issue=960")" = 7 ] \
  || fail "a usage block exposing requests=7 must record 7, not the hardcoded 1"
[ "$(val "SELECT model FROM spend WHERE run_id='RUN96' AND issue=960")" = "claude-opus-4-8" ] \
  || fail "a usage block exposing a model must record it verbatim"
[ "$(val "SELECT input_tokens FROM spend WHERE run_id='RUN96' AND issue=960")" = 40 ] \
  || fail "RUN96 fresh input wrong (40)"
[ "$(val "SELECT cache_read_tokens FROM spend WHERE run_id='RUN96' AND issue=960")" = 800 ] \
  || fail "RUN96 cache_read_tokens wrong (800)"
pass=$((pass+1))

# --- #99: queue-wait event from the tracker timeline (ready→claimed) ----------
# record-run-result runs host-side and knows the issue, so it — not the sandbox
# claim path, which has no swarm.db — reads the ready-for-agent and agent-working
# ADD times from the timeline and writes their delta as a `queue-wait` event.
# Shim curl so forgejo-lib's timeline GET answers per-issue fixtures offline.
t0iso="$(jq -rn '1600000000 | todateiso8601')"       # ready-for-agent applied
t1iso="$(jq -rn '1600000120 | todateiso8601')"       # agent-working applied (+120s)
qwbin="$tmp/qwbin"; mkdir -p "$qwbin"
# issue 111: a full timeline → a 120s queue-wait. issue 222: ready but NEVER
# claimed (no agent-working) → the graceful-degradation case, NO event.
cat > "$qwbin/tl-111.json" <<JSON
[
  {"type":"label","body":"1","label":{"name":"ready-for-agent"},"created_at":"$t0iso"},
  {"type":"label","body":"1","label":{"name":"agent-working"},"created_at":"$t1iso"}
]
JSON
cat > "$qwbin/tl-222.json" <<JSON
[
  {"type":"label","body":"1","label":{"name":"ready-for-agent"},"created_at":"$t0iso"}
]
JSON
cat > "$qwbin/curl" <<SH
#!/usr/bin/env bash
url=""
for a in "\$@"; do case "\$a" in http*) url="\$a" ;; esac; done
case "\$url" in
  */issues/111/timeline*) cat "$qwbin/tl-111.json" ;;
  */issues/222/timeline*) cat "$qwbin/tl-222.json" ;;
  *) exit 22 ;;
esac
SH
chmod +x "$qwbin/curl"
qwpayload='{
  "stdout": "SANDCASTLE_ATTEMPT issue=111 outcome=success commits=aa\nSANDCASTLE_ATTEMPT issue=222 outcome=blocked commits=",
  "iterations": [
    {"sessionId": "q-1", "sessionFilePath": "/logs/q1.jsonl",
     "usage": {"inputTokens": 1, "cacheCreationInputTokens": 0, "cacheReadInputTokens": 0, "outputTokens": 1}},
    {"sessionId": "q-2", "sessionFilePath": "/logs/q2.jsonl",
     "usage": {"inputTokens": 1, "cacheCreationInputTokens": 0, "cacheReadInputTokens": 0, "outputTokens": 1}}
  ]
}'
printf '%s' "$qwpayload" | \
  PATH="$qwbin:$PATH" FORGEJO_API="http://fj.test/api/v1/repos/Matou/dev-factory" FORGEJO_TOKEN=t \
  bash "$script" RUNQW
[ "$(val "SELECT detail FROM events WHERE run_id='RUNQW' AND kind='queue-wait' AND issue=111")" = 120 ] \
  || fail "issue 111 must get a queue-wait event of 120s (agent-working − ready-for-agent)"
[ "$(val "SELECT count(*) FROM events WHERE run_id='RUNQW' AND kind='queue-wait' AND issue=222")" = 0 ] \
  || fail "issue 222 (never claimed → no agent-working) must get NO queue-wait event (graceful)"
# The write is best-effort: a shim that fails the timeline GET must still exit 0
# and simply record no queue-wait event.
cat > "$qwbin/curl" <<'SH'
#!/usr/bin/env bash
exit 22
SH
chmod +x "$qwbin/curl"
printf '%s' "$qwpayload" | \
  PATH="$qwbin:$PATH" FORGEJO_API="http://fj.test/api/v1/repos/Matou/dev-factory" FORGEJO_TOKEN=t \
  bash "$script" RUNQW2 || fail "a failing timeline GET must still exit 0"
[ "$(val "SELECT count(*) FROM events WHERE run_id='RUNQW2' AND kind='queue-wait'")" = 0 ] \
  || fail "a failing timeline GET must record no queue-wait event"
pass=$((pass+1))

# --- #98: a REAL session jsonl on disk is ingested into PER-REQUEST spend -----
#     rows + per-tool-call events, and those REPLACE the single aggregate row
#     (no double count). The nonexistent /logs/*.jsonl paths above all fell back
#     to the aggregate — here the file EXISTS, so the ingest path fires.
sess="$tmp/iter.jsonl"
cat > "$sess" <<'JSONL'
{"type":"assistant","timestamp":"2026-08-26T02:00:00.000Z","message":{"model":"claude-opus-4-8","usage":{"input_tokens":100,"cache_creation_input_tokens":200,"cache_read_input_tokens":50,"output_tokens":30},"content":[{"type":"tool_use","id":"toolu_a","name":"Bash","input":{"command":"ls"}}]}}
{"type":"user","timestamp":"2026-08-26T02:00:03.000Z","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_a","content":"ok"}]}}
{"type":"assistant","timestamp":"2026-08-26T02:00:05.000Z","message":{"model":"claude-opus-4-8","usage":{"input_tokens":40,"cache_creation_input_tokens":0,"cache_read_input_tokens":800,"output_tokens":12},"content":[]}}
JSONL
payload98="{
  \"stdout\": \"SANDCASTLE_ATTEMPT issue=980 outcome=success commits=feed\",
  \"iterations\": [{\"sessionId\": \"sess-98\", \"sessionFilePath\": \"$sess\",
    \"usage\": {\"inputTokens\": 140, \"cacheCreationInputTokens\": 200, \"cacheReadInputTokens\": 850, \"outputTokens\": 42}}]
}"
printf '%s' "$payload98" | bash "$script" RUN98
# TWO per-request spend rows (one per assistant usage block), NOT the single
# aggregate — the ingest replaced the fallback.
[ "$(count "spend WHERE run_id='RUN98'")" = 2 ] \
  || fail "a real session file must yield PER-REQUEST spend rows (2), replacing the aggregate"
[ "$(val "SELECT input_tokens FROM spend WHERE run_id='RUN98' AND cache_read_tokens=50")" = 100 ] \
  || fail "the first request's fresh input (100) / cache_read (50) must be recorded per-request"
[ "$(val "SELECT model FROM spend WHERE run_id='RUN98' AND input_tokens=40")" = "claude-opus-4-8" ] \
  || fail "each per-request row must carry the model read from the session jsonl"
[ "$(val "SELECT issue FROM spend WHERE run_id='RUN98' AND input_tokens=100")" = 980 ] \
  || fail "the per-request rows must inherit the iteration's attributed issue"
# the aggregate 140-token row must NOT exist (no double count).
[ "$(val "SELECT count(*) FROM spend WHERE run_id='RUN98' AND input_tokens=140")" = 0 ] \
  || fail "the aggregate fallback row must be SKIPPED when per-request ingest succeeds"
# per-tool-call event with tool name + duration derived from the timestamps.
[ "$(val "SELECT detail FROM events WHERE run_id='RUN98' AND kind='tool-call'")" = Bash ] \
  || fail "the tool_use must land as a tool-call event named Bash"
[ "$(val "SELECT evidence FROM events WHERE run_id='RUN98' AND kind='tool-call'")" = "duration_ms=3000" ] \
  || fail "the tool-call duration must be the 3000ms gap to its tool_result"
# the iteration event (session path harvest record) is still written alongside.
[ "$(val "SELECT count(*) FROM events WHERE run_id='RUN98' AND kind='iteration'")" = 1 ] \
  || fail "the iteration event (session-path record) must still be written"
pass=$((pass+1))

# --- #95: per-iteration started_at/ended_at stamped from the session file -----
#     first/last message timestamps, so per-iteration duration is recoverable.
sess95="$tmp/iter95.jsonl"
cat > "$sess95" <<'JSONL'
{"type":"assistant","timestamp":"2026-08-26T02:00:00.000Z","message":{"model":"claude-opus-4-8","usage":{"input_tokens":10,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":5},"content":[]}}
{"type":"assistant","timestamp":"2026-08-26T02:00:42.000Z","message":{"model":"claude-opus-4-8","usage":{"input_tokens":5,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":2},"content":[]}}
JSONL
t95_start="$(jq -rn '"2026-08-26T02:00:00Z" | fromdateiso8601')"
t95_end="$(jq -rn '"2026-08-26T02:00:42Z" | fromdateiso8601')"
payload95="{
  \"stdout\": \"SANDCASTLE_ATTEMPT issue=950 outcome=success commits=t1me\",
  \"iterations\": [{\"sessionId\": \"sess-95\", \"sessionFilePath\": \"$sess95\",
    \"usage\": {\"inputTokens\": 15, \"cacheCreationInputTokens\": 0, \"cacheReadInputTokens\": 0, \"outputTokens\": 7}}]
}"
printf '%s' "$payload95" | bash "$script" RUN95
[ "$(val "SELECT started_at FROM attempts WHERE run_id='RUN95' AND issue=950")" = "$t95_start" ] \
  || fail "issue 950's attempt started_at must be the session's FIRST message timestamp"
[ "$(val "SELECT ended_at FROM attempts WHERE run_id='RUN95' AND issue=950")" = "$t95_end" ] \
  || fail "issue 950's attempt ended_at must be the session's LAST message timestamp"
pass=$((pass+1))

# --- #95: no readable session file → no per-iteration timing, so ended_at stays
#     NULL and the run-end MASS FINALISER (kills-finalise invariant 2) closes it,
#     exactly as before. The /logs/*.jsonl path below does not exist on disk.
payload95b='{
  "stdout": "SANDCASTLE_ATTEMPT issue=951 outcome=success commits=none",
  "iterations": [{"sessionId": "sess-95b", "sessionFilePath": "/logs/nope.jsonl",
    "usage": {"inputTokens": 3, "cacheCreationInputTokens": 0, "cacheReadInputTokens": 0, "outputTokens": 1}}]
}'
printf '%s' "$payload95b" | bash "$script" RUN95B
[ -z "$(val "SELECT ended_at FROM attempts WHERE run_id='RUN95B' AND issue=951")" ] \
  || fail "with no session timing, ended_at must stay NULL for the mass finaliser to close"
# the run-end finaliser closes the still-open attempt, unchanged.
db run-end --run RUN95B --verdict ok --source test --exit 0 --ended 1790000000
[ "$(val "SELECT ended_at FROM attempts WHERE run_id='RUN95B' AND issue=951")" = 1790000000 ] \
  || fail "the run-end mass finaliser must close the open attempt (invariant 2 intact)"
pass=$((pass+1))

# --- malformed stdin: never crashes, records nothing, exits 0 ----------------
printf 'not json {' | bash "$script" RUN4 || fail "malformed stdin must still exit 0"
[ "$(count "attempts WHERE run_id='RUN4'")" = 0 ] || fail "malformed stdin must record nothing"
pass=$((pass+1))

# --- no run-id argument: refuses cleanly, exits 0, records nothing -----------
printf '{}' | bash "$script" || fail "a missing run-id must still exit 0"
pass=$((pass+1))

echo "record-run-result: $pass groups passed"
