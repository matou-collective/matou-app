#!/usr/bin/env bash
# Scenario tests for ../claim-lib.sh against the fake Forgejo (fakebin/curl).
# No network. Covers the multi-host claim protocol from the 2026-08-11
# multihost-swarm design spec: comment-id arbitration, stale-claim
# (dead-run) filtering, and the janitor.
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$here/fakebin:$PATH"
export FORGEJO_TOKEN="ftok"
export FORGEJO_API="http://fj.test/api/v1/repos/Matou/idss"
. "$here/../claim-lib.sh"

# #1279: never actually sleep between the bounded retries under test.
CLAIM_ALIVE_RETRY_SLEEP=0

pass=0 fail=0
check() { if eval "$2"; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL: $1"; fi; }

setup() {
  FAKE_DIR="$(mktemp -d)"; export FAKE_DIR
  jq -n '[{"id":36,"name":"ready-for-agent"},{"id":50,"name":"agent-working"}]' >"$FAKE_DIR/labels.json"
  jq -n '{"workflow_runs":[{"name":"swarm","status":"running","run_number":512}]}' >"$FAKE_DIR/tasks.json"
  echo 1000 >"$FAKE_DIR/comment-counter"
  # #1279 hermetic seams: keep the verdict-log and absence-state reads inside the
  # per-test sandbox (the module defaults point at $HOME/swarm on a real host).
  # Plain globals — the claim-lib functions read them at call time.
  CLAIM_VERDICT_LOG="$FAKE_DIR/verdicts.log"
  CLAIM_ABSENCE_STATE_DIR="$FAKE_DIR/absence"
  # Legacy sweep tests below assert single-poll re-arm; the new default is 2 (a
  # dedicated test asserts that). Individual tests raise it to exercise N>1.
  CLAIM_ABSENCE_THRESHOLD=1
}

# T1: label id resolution
setup
check "label id resolves by name" '[ "$(claim_label_id agent-working)" = "50" ]'
check "missing label is rc 1" '! claim_label_id no-such-label'

# T2: alive runs come from the paged tasks API
setup
alive="$(claim_alive_runs)"
check "alive runs lists running swarm tasks" '[ "$(jq -c . <<<"$alive")" = "[512]" ]'
check "tasks API call is paged" 'grep -q "actions/tasks?limit=100&page=1" "$FAKE_DIR/calls.log"'

# T2b (#541): Forgejo names each matrix job "swarm (N)", not bare "swarm",
# once swarm.yml's `strategy.matrix.worker:[1,2]` is live (live-probed
# 2026-08-15 against the real /actions/tasks response — every current swarm
# task is literally named "swarm (1)"/"swarm (2)"; the matrix landed in
# 44fe333, after this exact-match filter was written in 39c5a23). An exact
# "swarm" match never matches either suffixed name, so claim_alive_runs
# always returned [] for the real fleet.
setup
jq -n '{"workflow_runs":[{"name":"swarm (1)","status":"running","run_number":601},{"name":"swarm (2)","status":"waiting","run_number":602}]}' >"$FAKE_DIR/tasks.json"
alive="$(claim_alive_runs)"
check "matrix-suffixed swarm jobs count as alive" '[ "$(jq -c "sort" <<<"$alive")" = "[601,602]" ]'

# T2c (#541 regression): the actual double-implementation bug. Two hosts race
# the same ticket under the matrix; each host's own alive-runs snapshot must
# recognize the OTHER's earlier claim as live, or the later host wrongly
# concludes it is the sole/lowest live claimant too — both hosts "win" and
# both fully implement the ticket (host=fd9d69e4d645 vs
# host=elitebook-distributed-server-03 duplicating #536). Before the fix this
# failed: claim_alive_runs()'s [] meant claim_won only ever recognized the
# caller's OWN id, so hostB's later claim also came back a "win".
setup
jq -n '{"workflow_runs":[{"name":"swarm (1)","status":"running","run_number":601},{"name":"swarm (2)","status":"running","run_number":602}]}' >"$FAKE_DIR/tasks.json"
c1="$(claim_post 536 fd9d69e4d645 601)"
c2="$(claim_post 536 elitebook-distributed-server-03 602)"
alive="$(claim_alive_runs)"
check "earlier claim wins under matrix-suffixed alive runs" 'claim_won 536 "$c1" "$alive"'
check "later claim correctly loses — no double-win" '! claim_won 536 "$c2" "$alive"'

# T3: first claim on a quiet issue wins
setup
cid="$(claim_post 431 eb03 513)"
check "claim comment id echoed" '[ "$cid" = "1001" ]'
check "claim body is machine-parsable" 'grep -q "swarm-claim host=eb03 run=513" "$FAKE_DIR/comments-431.json"'
check "sole claim wins" 'claim_won 431 "$cid" "[512,513]"'

# T4: comment-id arbitration — lowest ALIVE claim wins
setup
c1="$(claim_post 431 ws 512)"; c2="$(claim_post 431 eb03 513)"
check "lower id wins" 'claim_won 431 "$c1" "[512,513]"'
check "higher id loses" '! claim_won 431 "$c2" "[512,513]"'

# T5: a claim from a DEAD run is ignored by arbitration
setup
c1="$(claim_post 431 ws 400)"   # run 400 is not alive
c2="$(claim_post 431 eb03 513)"
check "stale lower claim is ignored" 'claim_won 431 "$c2" "[512,513]"'

# T6: release deletes the comment and the label
setup
claim_mark_working 431
c1="$(claim_post 431 eb03 513)"
claim_release 431 "$c1"
check "release deleted the comment" '! grep -q swarm-claim "$FAKE_DIR/comments-431.json"'
check "release removed agent-working" 'grep -q "DELETE .*issues/431/labels/50" "$FAKE_DIR/calls.log"'

# T6b (#20): a label write that returns non-2xx must fail LOUD, not silently
# continue. #19's swarm-bot had repo.code write but not repo.issues write, so
# the agent-working POST 403'd and the ticket was worked with no claim label —
# invisible to the janitor and every other host. A 2xx passes; a 403 pages.
setup
check "a 2xx label write succeeds quietly" 'claim_mark_working 431'
setup
echo 403 >"$FAKE_DIR/labels-post-fail"
check "a refused label write returns rc 1" '! claim_mark_working 431 2>/dev/null'
err="$(claim_mark_working 431 2>&1 >/dev/null || true)"
check "a refused label write pages with the HTTP code" 'grep -q "label write refused (HTTP 403)" <<<"$err"'

# T7: janitor re-arms a ticket whose claiming run died
setup
jq -n '[{number:77, labels:[{id:36,name:"ready-for-agent"},{id:50,name:"agent-working"}]}]' >"$FAKE_DIR/issues-agent-working.json"
c1="$(claim_post 77 ws 400)"    # dead run
rearmed="$(janitor_sweep)"
check "janitor names the re-armed issue" '[ "$rearmed" = "77" ]'
check "janitor removed the label" 'grep -q "DELETE .*issues/77/labels/50" "$FAKE_DIR/calls.log"'
check "janitor deleted the stale claim" '! grep -q swarm-claim "$FAKE_DIR/comments-77.json"'

# T8: janitor leaves a live claim alone
setup
jq -n '[{number:78, labels:[{id:50,name:"agent-working"}]}]' >"$FAKE_DIR/issues-agent-working.json"
c1="$(claim_post 78 ws 512)"    # run 512 IS alive
rearmed="$(janitor_sweep)"
check "live claim untouched" '[ -z "$rearmed" ] && grep -q swarm-claim "$FAKE_DIR/comments-78.json"'

# T9: 2026-08-11 review finding 1 — a tasks-API failure must NOT read as "nothing
# alive". claim_alive_runs must fail loud (rc nonzero), not degrade to `[]` at rc 0.
setup
touch "$FAKE_DIR/tasks-fail"
check "alive runs API failure is rc nonzero" '! claim_alive_runs >/dev/null 2>&1'

# T10: same finding, at the janitor: a tasks-API blip must re-arm NOTHING and
# leave a genuinely live claim intact (the reviewer's reproduced mass-re-arm).
setup
jq -n '[{number:78, labels:[{id:50,name:"agent-working"}]}]' >"$FAKE_DIR/issues-agent-working.json"
c1="$(claim_post 78 ws 512)"    # a genuinely live claim
touch "$FAKE_DIR/tasks-fail"
rearmed="$(janitor_sweep 2>/dev/null)"
check "janitor re-arms nothing on API failure" '[ -z "$rearmed" ]'
check "live claim survives an alive-runs API blip" 'grep -q swarm-claim "$FAKE_DIR/comments-78.json"'

# T11: 2026-08-11 review finding 2 — my own claim wins even when my own run
# hasn't shown up in the alive-runs snapshot yet (a just-started run racing a
# stale/empty snapshot). The own-id short-circuit in claim_won must hold.
setup
cid="$(claim_post 431 eb03 999999)"   # run 999999 is nowhere in the alive list below
check "own claim wins despite own run missing from alive list" 'claim_won 431 "$cid" "[512]"'

# T12: 2026-08-11 review finding 3 — janitor_sweep must page past the first 50
# agent-working issues, not silently stop at page 1.
setup
page1='[]'
for n in $(seq 101 150); do
  page1="$(jq --argjson n "$n" '. + [{number: $n, labels:[{id:50,name:"agent-working"}]}]' <<<"$page1")"
  jq -n --argjson id "$((900 + n))" \
    '[{id: $id, body: "swarm-claim host=ws run=512\n(automated multi-host claim)"}]' \
    >"$FAKE_DIR/comments-$n.json"    # page-1 issues are all validly claimed by the alive run — must stay untouched
done
echo "$page1" >"$FAKE_DIR/issues-agent-working-page1.json"
jq -n '[{number:200, labels:[{id:50,name:"agent-working"}]}]' >"$FAKE_DIR/issues-agent-working-page2.json"
c1="$(claim_post 200 ws 400)"   # dead run, only on page 2 — must still be caught
rearmed="$(janitor_sweep)"
check "janitor pages past page 1 and re-arms only the page-2 dead claim" '[ "$rearmed" = "200" ]'
check "issues API call reached page 2" 'grep -q "labels=agent-working&limit=50&page=2" "$FAKE_DIR/calls.log"'

# T-#470 M-3: a malformed hand-posted claim body must not blind arbitration.
# capture() on `run=abc` used to error MID-STREAM, dropping every later line
# with the rc swallowed by the trailing sort — the well-formed claims after
# the bad one vanished. Now a body failing the strict shape is skipped.
setup
jq -n '[{id:900, body:"swarm-claim host=ws run=abc\nhand-typed junk"},
        {id:901, body:"swarm-claim host=eb03 run=512\nx"},
        {id:902, body:"swarm-claim host=ws2 run=513\nx"}]' >"$FAKE_DIR/comments-431.json"
lines="$(_claim_comments 431)"
check "malformed claim is skipped, not fatal" '[ "$(wc -l <<<"$lines")" = "2" ]'
check "claims after the malformed one survive" 'grep -q "^902 513$" <<<"$lines"'
check "well-formed lower claim still first" '[ "$(head -1 <<<"$lines")" = "901 512" ]'

# T-#1412: claim_fresh_runs — a claim comment older than the TTL is a TOMBSTONE
# (a peer that died/was killed/timed out between claiming and finishing), not a
# live contender. No sweep reaps it once its ticket is back to ready-for-session
# (janitor_sweep and the session-runner #63 sweep both only visit agent-working),
# so the session-runner's arbitration must expire it by AGE — else one dead
# peer's lower-id claim wedges the ticket forever (#1373 sat ready-for-session an
# hour). `now` is injected so the test is hermetic (TTL=7500, now=2026-09-12T01Z).
setup
NOW=1789174800
jq -n '[
  {id:50, created_at:"2026-01-01T00:00:00Z", body:"swarm-claim host=deadpeer run=999\n(auto)"},
  {id:60, created_at:"2026-09-12T00:00:00Z", body:"swarm-claim host=live run=512\n(auto)"},
  {id:61, body:"swarm-claim host=nodt run=777\n(auto)"},
  {id:62, body:"just a normal comment, not a claim"},
  {id:63, created_at:"2026-01-01T00:00:00Z", body:"swarm-claim host=bad run=abc\njunk"}
]' >"$FAKE_DIR/comments-431.json"
fresh="$(claim_fresh_runs 431 7500 "$NOW")"
check "a tombstone (stale created_at) drops out of the fresh set" '! jq -e "index(999)" <<<"$fresh" >/dev/null'
check "a fresh claim stays in the fresh set"                      'jq -e "index(512)" <<<"$fresh" >/dev/null'
check "an un-ageable claim (no created_at) is kept fail-closed"   'jq -e "index(777)" <<<"$fresh" >/dev/null'
check "malformed + non-claim bodies are skipped, never fatal"     '[ "$(jq -c "sort" <<<"$fresh")" = "[512,777]" ]'

# T-#1412b: the wedge itself. `allruns` mirrors the OLD session-runner alive-set
# builder (every present claim counted live); `fresh` is the TTL-filtered one.
# Fed the unfiltered set, claim_won lets the stale LOWER-id tombstone (id 50) win
# and the live claim (id 60) lose — the exact wedge. TTL-filtered, the live claim
# wins because the tombstone's run is gone from the alive set. (arg2 is the
# CANDIDATE's own id; claim_won's own-id short-circuit is why we probe id 60, a
# real competing claimant, not id 50 which would look "alive by definition".)
allruns="$(_claim_comments 431 | awk 'NF>1{print $2}' | jq -Rn '[inputs|tonumber]')"
check "unfiltered: the stale lower-id tombstone wrongly wins (the #1412 wedge)" '! claim_won 431 60 "$allruns"'
check "TTL-filtered: the live claim wins, the tombstone is skipped"             'claim_won 431 60 "$fresh"'

# T-#1412c: TTL never steals a REAL race — a live LOWER-id claim still wins.
setup
NOW=1789174800
jq -n '[
  {id:50, created_at:"2026-09-12T00:30:00Z", body:"swarm-claim host=peer run=200\n(auto)"},
  {id:60, created_at:"2026-09-12T00:45:00Z", body:"swarm-claim host=me run=201\n(auto)"}
]' >"$FAKE_DIR/comments-431.json"
fresh="$(claim_fresh_runs 431 7500 "$NOW")"
check "a live lower-id claim still wins the race"    'claim_won 431 50 "$fresh"'
check "the live higher-id claim correctly loses"     '! claim_won 431 60 "$fresh"'

# T-#1412d: an API failure returns rc 1, never a degraded '[]' (finding 1) — a
# caller must not treat "could not read the claims" as "no live claim".
setup
touch "$FAKE_DIR/api-timeout"
check "a timed-out comments read fails rc 1, not a degraded []" '! claim_fresh_runs 431 7500 1789174800'


# T13 (#28): every claim API call carries a timeout. The tasks listing is the
# hottest reader in the harness (limit=100, once per claim and once per janitor
# sweep) and it is exactly the endpoint that went unanswerable on the big repos
# — `/actions/runs` stopped answering inside 60 s at ~8,900 runs (2026-08-22),
# and `/actions/tasks` is only cheap while it stays paged. Without `--max-time`
# curl waits on the socket indefinitely, so a degraded forge does not RED a
# tick, it silently stalls one: the worker's claim never returns, the run holds
# its host-capacity slot, and nothing on the ticket says why. schedule-backstop
# and heal already timed out; claim-lib did not.
setup
alive="$(claim_alive_runs)"
check "the tasks read carries a timeout" 'grep -q -- "--max-time" "$FAKE_DIR/argv.log"'
check "every claim API call carries a timeout" '[ "$(grep -c -- "--max-time" "$FAKE_DIR/argv.log")" = "$(wc -l <"$FAKE_DIR/argv.log")" ]'
setup
claim_mark_working 431 >/dev/null 2>&1
check "the label write carries a timeout too" 'grep -q -- "--max-time" "$FAKE_DIR/argv.log"'

# T13b: and a timed-out call must fail the way an API failure already does —
# rc nonzero from the readers (never a degraded `[]`, review finding 1) and a
# LOUD page from the label write (whose -w idiom reads `000` on a timeout, the
# same non-2xx path as #20's silent 403).
setup
touch "$FAKE_DIR/api-timeout"
check "a timed-out tasks read is rc nonzero" '! claim_alive_runs >/dev/null 2>&1'
check "a timed-out claim post is rc nonzero" '! claim_post 431 ws 513 >/dev/null 2>&1'
# The label write times out on its own leg (its label-id lookup got through):
# curl reports `000` to the -w idiom, which must page down the same non-2xx
# path as #20's silent 403 — never be read as a 2xx-ish success.
setup
echo 000 >"$FAKE_DIR/labels-post-fail"
check "a timed-out label write returns rc 1" '! claim_mark_working 431 2>/dev/null'
err="$(claim_mark_working 431 2>&1 >/dev/null || true)"
check "a timed-out label write pages with HTTP 000" 'grep -q "label write refused (HTTP 000)" <<<"$err"'

# T13c: the timeout is overridable (a caller on a slow link, or a test), and the
# default is the one the rest of the harness uses.
setup
( CLAIM_API_MAX_TIME=5 claim_alive_runs >/dev/null 2>&1 )
check "CLAIM_API_MAX_TIME overrides the default" 'grep -q -- "--max-time 5 " "$FAKE_DIR/argv.log"'
setup
alive="$(claim_alive_runs)"
check "default timeout matches the harness-wide 30s" 'grep -q -- "--max-time 30 " "$FAKE_DIR/argv.log"'

# ── #1279: stale-claim sweeper, liveness ≠ tracker-slow, budgets to p95 ──────

# T14: claim_run_terminal reads the host-side verdict log. A run with a recorded
# TERMINAL verdict is dead; the pre-merge `pr-opened` breadcrumb (written while
# the run is STILL alive) is NOT; an absent run / run 0 / a prefix collision are
# not; and a run that has both a breadcrumb AND a later terminal line is dead.
setup
printf '%s\n' \
  '2026-09-07T00:00:00Z repo=Matou/idss ready=[431] reason=completed exit=0 duration=100s run=700' \
  '2026-09-07T00:05:00Z repo=Matou/idss ready=[432] reason=pr-opened exit=- duration=5s run=701' \
  >"$CLAIM_VERDICT_LOG"
check "a recorded terminal verdict marks the run dead" 'claim_run_terminal 700'
check "a pre-merge pr-opened breadcrumb is NOT terminal" '! claim_run_terminal 701'
check "a run absent from the log is not terminal" '! claim_run_terminal 999'
check "run 0 and empty run are never terminal" '! claim_run_terminal 0 && ! claim_run_terminal ""'
check "a prefix run id does not false-match (700 vs 7000)" '! claim_run_terminal 7000'
printf '%s\n' '2026-09-07T00:06:00Z repo=Matou/idss ready=[432] reason=completed exit=0 duration=200s run=701' >>"$CLAIM_VERDICT_LOG"
check "a breadcrumb followed by a terminal verdict is terminal" 'claim_run_terminal 701'
setup
check "no verdict log on disk => not terminal (no crash)" '! claim_run_terminal 700'

# T15: liveness ≠ tracker-slow — a timed-out/5xx poll BACKS OFF and RETRIES
# (bounded) instead of concluding "run dead". Fail twice, then serve: the read
# recovers within the retry budget rather than surfacing a failure the caller
# would fail-closed on and churn a whole cron cycle over (#1246/#1247).
setup
echo 2 >"$FAKE_DIR/tasks-fail-count"
alive="$(CLAIM_ALIVE_RETRIES=2 claim_alive_runs)"
check "claim_alive_runs recovers from a transient slow tracker" '[ "$(jq -c . <<<"$alive")" = "[512]" ]'
check "it retried past the two transient failures (3 reads)" '[ "$(grep -c "actions/tasks" "$FAKE_DIR/calls.log")" = 3 ]'

# T16: the retry is BOUNDED — once exhausted it still fails LOUD (rc nonzero),
# never a degraded `[]` (review finding 1 holds through the retry path too).
setup
echo 9 >"$FAKE_DIR/tasks-fail-count"
check "retries exhausted is rc nonzero, not a laundered []" '! ( CLAIM_ALIVE_RETRIES=2 claim_alive_runs >/dev/null 2>&1 )'
check "it made exactly retries+1 attempts (1 + 2)" '[ "$(grep -c "actions/tasks" "$FAKE_DIR/calls.log")" = 3 ]'

# T17: CLAIM_ALIVE_RETRIES=0 (the in-sandbox prefetch's setting) is a single
# attempt — the 30s prompt-expansion budget must not be spent retrying.
setup
touch "$FAKE_DIR/tasks-fail"
( CLAIM_ALIVE_RETRIES=0 claim_alive_runs >/dev/null 2>&1 ) || true
check "CLAIM_ALIVE_RETRIES=0 makes exactly one attempt" '[ "$(grep -c "actions/tasks" "$FAKE_DIR/calls.log")" = 1 ]'

# T18: the optional latency log records one sample per read (with its rc), so the
# p95 the budgets are sized to can be measured off disk, not guessed (ask 3).
setup
( CLAIM_LATENCY_LOG="$FAKE_DIR/lat.log" claim_alive_runs >/dev/null )
check "a successful read logs one latency sample tagged rc=0" \
  '[ "$(wc -l <"$FAKE_DIR/lat.log")" = 1 ] && grep -q "dur=[0-9]*s rc=0" "$FAKE_DIR/lat.log"'
setup
echo 9 >"$FAKE_DIR/tasks-fail-count"
( CLAIM_LATENCY_LOG="$FAKE_DIR/lat.log" CLAIM_ALIVE_RETRIES=2 claim_alive_runs >/dev/null 2>&1 ) || true
check "every retry attempt logs a sample (3 rows)" '[ "$(wc -l <"$FAKE_DIR/lat.log")" = 3 ]'
check "a failed sample records the nonzero rc" 'grep -q "rc=22" "$FAKE_DIR/lat.log"'
check "latency log is OFF by default (unset => no file written)" \
  'setup; claim_alive_runs >/dev/null; [ ! -e "$FAKE_DIR/lat.log" ]'

# T19 (the #1247 core fix): the janitor sweeps a stale claim whose run has a
# recorded TERMINAL verdict EVEN WHEN THE TRACKER IS DOWN. On #1247 twelve stale
# claims had to be hand-deleted precisely because every alive poll timed out and
# the old janitor fail-closed to sweeping nothing — the verdict log is the
# tracker-independent proof of death that breaks that deadlock.
setup
jq -n '[{number:79, labels:[{id:50,name:"agent-working"}]}]' >"$FAKE_DIR/issues-agent-working.json"
c1="$(claim_post 79 ws 800)"
printf '%s\n' '2026-09-07T01:00:00Z repo=Matou/idss ready=[79] reason=completed exit=0 duration=300s run=800' >"$CLAIM_VERDICT_LOG"
touch "$FAKE_DIR/tasks-fail"           # tracker unreachable
rearmed="$(CLAIM_ALIVE_RETRIES=1 janitor_sweep 2>/dev/null)"
check "janitor sweeps a terminal-verdict claim with the tracker down" '[ "$rearmed" = "79" ]'
check "the stale claim comment was deleted" '! grep -q swarm-claim "$FAKE_DIR/comments-79.json"'
check "agent-working was removed" 'grep -q "DELETE .*issues/79/labels/50" "$FAKE_DIR/calls.log"'

# T20: but a LIVE run with NO verdict is NOT swept when the tracker is down — no
# proof of death means keep the claim (fail-closed, distinct from T10's mass
# case, scoped to the verdict-less path).
setup
jq -n '[{number:82, labels:[{id:50,name:"agent-working"}]}]' >"$FAKE_DIR/issues-agent-working.json"
c1="$(claim_post 82 ws 512)"
touch "$FAKE_DIR/tasks-fail"
rearmed="$(CLAIM_ALIVE_RETRIES=1 janitor_sweep 2>/dev/null)"
check "no verdict + tracker down => claim kept, not swept" '[ -z "$rearmed" ] && grep -q swarm-claim "$FAKE_DIR/comments-82.json"'

# T21: absence ≠ death on one poll. A run absent from a SUCCESSFUL poll is swept
# only after CLAIM_ABSENCE_THRESHOLD consecutive absent polls — one slow/partial
# 200 cannot false-sweep a live run. State is file-backed, so it survives the
# command-substitution subshell each janitor_sweep runs in.
setup
jq -n '[{number:80, labels:[{id:50,name:"agent-working"}]}]' >"$FAKE_DIR/issues-agent-working.json"
c1="$(claim_post 80 ws 404)"           # run 404 not in alive [512]
CLAIM_ABSENCE_THRESHOLD=2
r1="$(janitor_sweep)"
check "one absent successful poll does not sweep (threshold 2)" '[ -z "$r1" ] && grep -q swarm-claim "$FAKE_DIR/comments-80.json"'
r2="$(janitor_sweep)"
check "the second consecutive absent poll reaches threshold and sweeps" '[ "$r2" = "80" ]'
check "the stale claim was deleted on the threshold poll" '! grep -q swarm-claim "$FAKE_DIR/comments-80.json"'

# T22: the absence streak is CONSECUTIVE — a run reappearing alive resets it.
setup
jq -n '[{number:81, labels:[{id:50,name:"agent-working"}]}]' >"$FAKE_DIR/issues-agent-working.json"
c1="$(claim_post 81 ws 404)"
CLAIM_ABSENCE_THRESHOLD=2
janitor_sweep >/dev/null               # 404 absent -> streak 1
jq -n '{"workflow_runs":[{"name":"swarm","status":"running","run_number":404}]}' >"$FAKE_DIR/tasks.json"
janitor_sweep >/dev/null               # 404 alive -> streak cleared
check "a run reappearing alive is not swept" 'grep -q swarm-claim "$FAKE_DIR/comments-81.json"'
check "the absence streak was cleared on the live poll" '[ ! -f "$FAKE_DIR/absence/404" ]'

# T23: the new defaults are the ones the ticket sized (env-tunable, measured
# defaults) — assert them from a fresh source with the env unset.
d="$(env -u CLAIM_ABSENCE_THRESHOLD bash -c ". \"$here/../claim-lib.sh\"; printf %s \"\$CLAIM_ABSENCE_THRESHOLD\"")"
check "default absence threshold is 2 consecutive polls" '[ "$d" = 2 ]'
dr="$(env -u CLAIM_ALIVE_RETRIES bash -c ". \"$here/../claim-lib.sh\"; printf %s \"\$CLAIM_ALIVE_RETRIES\"")"
check "default alive-poll retries is 2" '[ "$dr" = 2 ]'

# T24 (#1717): claim_owned_by_run — the COMMIT-time gate helper. Distinct from
# claim_won (which arbitrates a race the caller entered); this asks the blunter
# "does a swarm-claim for THIS run exist on the issue at all?", with three rc so
# the commit-msg hook can fail OPEN on an unreachable tracker and CLOSED on a
# read that shows no claim.
setup
c1="$(claim_post 700 hostA 900)"
check "owned: rc 0 when a claim for this run exists" 'claim_owned_by_run 700 900'
check "not owned: rc 1 when the issue has claims but none for this run" 'claim_owned_by_run 700 901; [ "$?" -eq 1 ]'
# An issue this run never touched (no comments fixture) reads as an empty list —
# reachable, no claim: the real refusal (rc 1), exactly run 29782's #1713 case.
check "not owned: rc 1 on an issue with no claim comments at all" 'claim_owned_by_run 1713 29782; [ "$?" -eq 1 ]'
# A second host's claim on the same issue does not count as ours.
c2="$(claim_post 700 hostB 902)"
check "not owned: another host's claim on the same issue is not this run's" 'claim_owned_by_run 700 903; [ "$?" -eq 1 ]'
check "owned: still finds our own claim among several" 'claim_owned_by_run 700 900'
# Tracker unreachable (curl -sf faults) -> rc 3, so the caller FAILS OPEN.
setup
c1="$(claim_post 700 hostA 900)"
touch "$FAKE_DIR/api-timeout"
check "unreachable: rc 3 when the comments read faults (fail-open signal)" 'claim_owned_by_run 700 900; [ "$?" -eq 3 ]'
rm -f "$FAKE_DIR/api-timeout"
# run 0 / empty is never "owned" — a run-0 claim protects nothing (#468).
check "run 0 is never owned (rc 1)" 'claim_owned_by_run 700 0; [ "$?" -eq 1 ]'

echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
