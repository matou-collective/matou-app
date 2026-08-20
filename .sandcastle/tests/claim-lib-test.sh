#!/usr/bin/env bash
# Scenario tests for ../claim-lib.sh against the fake Forgejo (fakebin/curl).
# No network. Covers the multi-host claim protocol from the 2026-08-11
# multihost-swarm design spec: comment-id arbitration, stale-claim
# (dead-run) filtering, and the janitor.
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$here/fakebin:$PATH"
export FORGEJO_TOKEN="ftok"
export FORGEJO_API="http://fj.test/api/v1/repos/Matou/ourcloud"
. "$here/../claim-lib.sh"

pass=0 fail=0
check() { if eval "$2"; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL: $1"; fi; }

setup() {
  FAKE_DIR="$(mktemp -d)"; export FAKE_DIR
  jq -n '[{"id":36,"name":"ready-for-agent"},{"id":50,"name":"agent-working"}]' >"$FAKE_DIR/labels.json"
  jq -n '{"workflow_runs":[{"name":"swarm","status":"running","run_number":512}]}' >"$FAKE_DIR/tasks.json"
  echo 1000 >"$FAKE_DIR/comment-counter"
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

echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
