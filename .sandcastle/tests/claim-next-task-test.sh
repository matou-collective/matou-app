#!/usr/bin/env bash
# claim-next-task.sh: emits exactly ONE verified-claimed ticket (or []).
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$here/fakebin:$PATH"
export FORGEJO_TOKEN="ftok"
export FORGEJO_API="http://fj.test/api/v1/repos/Matou/idss"
export SWARM_HOST="eb03" SWARM_RUN_ID="513"
script="$here/../claim-next-task.sh"

pass=0 fail=0
check() { if eval "$2"; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL: $1"; fi; }

# The wrapper consumes list-ready-tasks.sh; fake its output by pointing the
# wrapper at a stub lister via CLAIM_LISTER (test seam, defaults to the real one).
mklister() { # mklister <json>
  printf '#!/usr/bin/env bash\nprintf %%s \x27%s\x27\n' "$1" >"$FAKE_DIR/lister"
  chmod +x "$FAKE_DIR/lister"
  export CLAIM_LISTER="$FAKE_DIR/lister"
}
setup() {
  FAKE_DIR="$(mktemp -d)"; export FAKE_DIR
  jq -n '[{"id":36,"name":"ready-for-agent"},{"id":50,"name":"agent-working"}]' >"$FAKE_DIR/labels.json"
  jq -n '{"workflow_runs":[{"name":"swarm","status":"running","run_number":513}]}' >"$FAKE_DIR/tasks.json"
  echo 1000 >"$FAKE_DIR/comment-counter"
}

# T1: empty queue -> []
setup; mklister '[]'
check "empty queue emits []" '[ "$(bash "$script")" = "[]" ]'

# T2: head claimed cleanly -> exactly that ticket, marked working
setup; mklister '[{"number":431,"title":"a","body":"b","url":"u"},{"number":433,"title":"c","body":"d","url":"u2"}]'
out="$(bash "$script")"
check "emits exactly one ticket" '[ "$(jq length <<<"$out")" = "1" ]'
check "emits the head" '[ "$(jq -r ".[0].number" <<<"$out")" = "431" ]'
check "claim comment posted" 'grep -q "swarm-claim host=eb03 run=513" "$FAKE_DIR/comments-431.json"'
check "agent-working added" 'grep -q "POST .*issues/431/labels" "$FAKE_DIR/calls.log"'
# #13: the landing instruction line — default (no policy file) is push-to-main,
# on stderr so the JSON stdout contract stays clean.
setup; mklister '[{"number":431,"title":"a","body":"b","url":"u"}]'
bash "$script" >"$FAKE_DIR/lstdout" 2>"$FAKE_DIR/lstderr"
check "push-mode landing line printed on stderr" 'grep -q "landing: push to main" "$FAKE_DIR/lstderr"'
check "landing line does NOT pollute the JSON stdout" \
  '[ "$(jq -r ".[0].number" < "$FAKE_DIR/lstdout")" = "431" ]'
check "landing line is stderr-only, never on stdout" '! grep -q "landing:" "$FAKE_DIR/lstdout"'

# T2b (#13): under a LANDING=pr policy the line names the PR branch.
setup; mklister '[{"number":431,"title":"a","body":"b","url":"u"}]'
printf '%s\n' 'LANDING=pr' > "$FAKE_DIR/swarm-policy.sh"
lerr="$(SWARM_POLICY_FILE="$FAKE_DIR/swarm-policy.sh" bash "$script" 2>&1 >/dev/null)"
check "pr-mode landing line names agent/issue-<N>" 'grep -q "landing: PR from agent/issue-431" <<<"$lerr"'

# T3: head already claimed by a LIVE lower id -> loser walks to next ticket
setup; mklister '[{"number":431,"title":"a","body":"b","url":"u"},{"number":433,"title":"c","body":"d","url":"u2"}]'
jq -n '{"workflow_runs":[{"name":"swarm","status":"running","run_number":512},{"name":"swarm","status":"running","run_number":513}]}' >"$FAKE_DIR/tasks.json"
jq -n '[{id:900, body:"swarm-claim host=ws run=512\nx"}]' >"$FAKE_DIR/comments-431.json"
out="$(bash "$script")"
check "loser takes the next ticket" '[ "$(jq -r ".[0].number" <<<"$out")" = "433" ]'
check "loser deleted its own claim" 'grep -q "DELETE .*issues/comments/1001" "$FAKE_DIR/calls.log"'

# T4: every ticket contested -> []
setup; mklister '[{"number":431,"title":"a","body":"b","url":"u"}]'
jq -n '{"workflow_runs":[{"name":"swarm","status":"running","run_number":512},{"name":"swarm","status":"running","run_number":513}]}' >"$FAKE_DIR/tasks.json"
jq -n '[{id:900, body:"swarm-claim host=ws run=512\nx"}]' >"$FAKE_DIR/comments-431.json"
check "all contested emits []" '[ "$(bash "$script")" = "[]" ]'

# T5: fail-closed — the alive-runs fetch itself fails (actions/tasks API blip,
# the tasks-fail seam). Blind arbitration is worse than skipping the round:
# claim_won's own-id short-circuit would make this host look like the sole
# live claimant of a ticket another host may already legitimately hold. The
# wrapper must emit [] AND post no claim comment at all this round (Ben's
# fail-closed ruling, 2026-08-11, review of commit 68fb911).
setup; mklister '[{"number":431,"title":"a","body":"b","url":"u"}]'
touch "$FAKE_DIR/tasks-fail"
check "alive-runs API failure emits []" '[ "$(bash "$script")" = "[]" ]'
check "no claim comment posted on API failure" '! grep -q swarm-claim "$FAKE_DIR/comments-431.json" 2>/dev/null'
check "no comment POST issued on API failure" '! grep -q "POST .*issues/431/comments" "$FAKE_DIR/calls.log"'

# T-#468: SWARM_RUN_ID unset/0 refuses to claim — a run-0 claim looks
# protective but every other host arbitrates over it and the janitor sweeps
# it. Emit [] and post NOTHING; SWARM_CLAIM_FORCE=1 is the eyes-open override.
setup; mklister '[{"number":431,"title":"a","body":"b","url":"u"}]'
check "run-0 refuses: emits []" '[ "$(SWARM_RUN_ID= bash "$script" 2>/dev/null)" = "[]" ]'
check "run-0 refuses: no claim POST" '! grep -q "POST .*issues/431/comments" "$FAKE_DIR/calls.log"'
check "run-0 refuses: warns on stderr" 'SWARM_RUN_ID= bash "$script" 2>&1 >/dev/null | grep -q "SWARM_CLAIM_FORCE"'

setup; mklister '[{"number":431,"title":"a","body":"b","url":"u"}]'
jq -n '{"workflow_runs":[{"name":"swarm","status":"running","run_number":0}]}' >"$FAKE_DIR/tasks.json"
out="$(SWARM_RUN_ID= SWARM_CLAIM_FORCE=1 bash "$script" 2>/dev/null)"
check "forced run-0 claim goes through" '[ "$(jq -r ".[0].number" <<<"$out")" = "431" ]'
check "forced claim posted at run 0" 'grep -q "swarm-claim host=eb03 run=0" "$FAKE_DIR/comments-431.json"'

# T-#77a: an exhausted wall-clock budget stops the walk BEFORE the first claim.
# The whole script runs inside one Sandcastle 30s shell-expression; a large
# contested ready DAG would otherwise sum O(queue) sequential API calls past
# that budget and RED the tick. With the budget spent, emit [] gracefully (the
# same outcome as losing every race — no claim, no Claude tokens) and let the
# cron/backstop re-fire, rather than walk on and blow the outer timeout.
setup; mklister '[{"number":431,"title":"a","body":"b","url":"u"},{"number":433,"title":"c","body":"d","url":"u2"}]'
out="$(CLAIM_NEXT_BUDGET=0 bash "$script" 2>"$FAKE_DIR/berr")"
check "budget spent emits []" '[ "$out" = "[]" ]'
check "budget spent posts NO claim comment" '! grep -q "POST .*issues/431/comments" "$FAKE_DIR/calls.log"'
check "budget spent warns on stderr" 'grep -q "budget" "$FAKE_DIR/berr"'

# T-#77b: per-call --max-time is capped BELOW the 30s outer budget, so a single
# stalled call fails closed within budget instead of firing the outer timeout at
# the same instant (#28). claim-lib keeps its 30s default for the HOST-mode
# janitor, which runs under no such budget.
# idss#1195: the cap is no longer the flat 10s this used to assert — the WALK's cap
# is derived per candidate from the clock left (see T-idss#1195a/b), and the PREFETCH
# leg gets its own, larger, measurement-sized cap (T-idss#1195c). What must hold for
# every call on every leg is the #28 invariant itself: nothing is timed at or
# above the outer 30s budget.
setup; mklister '[{"number":431,"title":"a","body":"b","url":"u"}]'
bash "$script" >/dev/null 2>&1
check "no claim call uses the 30s outer-budget-equal timeout" '! grep -q -- "--max-time 30" "$FAKE_DIR/argv.log"'
check "every call carries SOME --max-time (#28: no unbounded reader)" \
  '[ "$(grep -c -- "--max-time" "$FAKE_DIR/argv.log")" = "$(wc -l < "$FAKE_DIR/argv.log")" ]'
check "every call is timed strictly under the 30s outer budget" \
  '[ -z "$(sed -n "s/.*--max-time \([0-9]*\).*/\1/p" "$FAKE_DIR/argv.log" | awk "\$1 >= 30")" ]'

# T-idss#1195a: the OVERSHOOT hole that REDed run 17201. The old guard tested the
# clock only at the top of a candidate, so a candidate admitted just under the
# budget then ran up to ~4 x CLAIM_API_MAX_TIME unchecked (21s + 10s > the 30s
# hard-coded PROMPT_EXPANSION_TIMEOUT_MS). A candidate must now be admitted ONLY
# when the clock left bounds ALL of its calls: cap x CLAIM_CANDIDATE_CALLS must
# fit in CLAIM_NEXT_DEADLINE - SECONDS. With a deadline too small to bound even
# one candidate at the floor, the walk must emit [] and post NOTHING — rather
# than start a candidate it cannot finish in time.
setup; mklister '[{"number":431,"title":"a","body":"b","url":"u"},{"number":433,"title":"c","body":"d","url":"u2"}]'
out="$(CLAIM_NEXT_DEADLINE=4 CLAIM_CANDIDATE_CALLS=5 CLAIM_CALL_FLOOR=2 bash "$script" 2>"$FAKE_DIR/derr")"
check "deadline too tight to bound a candidate emits []" '[ "$out" = "[]" ]'
check "deadline too tight posts NO claim comment" '! grep -q "POST .*issues/431/comments" "$FAKE_DIR/calls.log"'
check "deadline too tight says so on stderr" 'grep -q "deadline" "$FAKE_DIR/derr"'

# T-idss#1195b: the admitted candidate's per-call cap is DERIVED from the deadline,
# and the derivation is the safety property: cap x CLAIM_CANDIDATE_CALLS must
# never exceed the deadline, or a single candidate burning every cap runs past
# the outer 30s again. Assert the arithmetic on the real argv, not the intent.
setup; mklister '[{"number":431,"title":"a","body":"b","url":"u"}]'
CLAIM_NEXT_DEADLINE=20 CLAIM_CANDIDATE_CALLS=5 bash "$script" >/dev/null 2>&1
check "walk cap is deadline-derived (20/5 = 4s), not the old flat 10s" \
  'grep -q -- "--max-time 4 " "$FAKE_DIR/argv.log" || grep -q -- "--max-time 4$" "$FAKE_DIR/argv.log"'
check "worst-case candidate (calls x cap) fits inside the deadline" \
  '[ "$(sed -n "s/.*issues\/431\/comments.*//;s/.*--max-time \([0-9]*\).*/\1/p" "$FAKE_DIR/argv.log" | sort -n | tail -1)" -le 20 ]'
# The explicit override stays absolute — an operator/probe retune is eyes-open
# and is NOT clamped by the deadline derivation (the #77c seam, still honoured).
setup; mklister '[{"number":431,"title":"a","body":"b","url":"u"}]'
CLAIM_API_MAX_TIME=7 CLAIM_NEXT_DEADLINE=20 bash "$script" >/dev/null 2>&1
check "explicit override is absolute, not deadline-clamped" \
  '! grep -q -- "--max-time 4" "$FAKE_DIR/argv.log"'

# T-idss#1195c: the prefetch cap must sit OVER the measured actions/tasks tail, not
# under it. CLAIM_API_MAX_TIME=10 was below this forge's own latency for
# `actions/tasks?limit=100&page=1` (8.5-12.2s across 5 live samples, 3 of 5 over
# 10s), so claim_alive_runs' fail-closed arm fired on a HEALTHY-but-slow forge
# and the iteration claimed nothing at all. A cap under the tail turns the
# fail-closed safety net into a routine outcome — regression-guard the ordering.
setup; mklister '[{"number":431,"title":"a","body":"b","url":"u"}]'
bash "$script" >/dev/null 2>&1
check "alive-runs prefetch is capped over the measured 12.2s tail" \
  '[ "$(sed -n "/actions\/tasks/s/.*--max-time \([0-9]*\).*/\1/p" "$FAKE_DIR/argv.log")" -gt 12 ]'

# T-idss#1195d: the lister leg is bounded by WALL CLOCK from the outside.
# list-ready-tasks.sh retries each read with backoff at LIST_READY_MAX_TIME (30s)
# apiece — a worst case around 96s, unbounded relative to a 30s expansion. A
# lister that hangs must cost the tick a graceful [], not the whole run.
setup
cat >"$FAKE_DIR/lister" <<'EOF'
#!/usr/bin/env bash
sleep 30
printf '%s' '[{"number":431,"title":"a","body":"b","url":"u"}]'
EOF
chmod +x "$FAKE_DIR/lister"; export CLAIM_LISTER="$FAKE_DIR/lister"
lstart="$(date +%s)"
out="$(CLAIM_LISTER_MAX_TIME=2 bash "$script" 2>"$FAKE_DIR/lterr")"
lelapsed=$(( $(date +%s) - lstart ))
unset CLAIM_LISTER
check "a hanging lister emits [] instead of running past the outer budget" '[ "$out" = "[]" ]'
check "a hanging lister is cut off at its wall-clock bound, not left to run" '[ "$lelapsed" -lt 10 ]'
check "a hanging lister posts NO claim comment" '! grep -q "POST .*issues/431/comments" "$FAKE_DIR/calls.log"'
check "a hanging lister says so on stderr" 'grep -q "wall-clock" "$FAKE_DIR/lterr"'

# T-idss#1195e: a lister that FAILS (not hangs) must still fail LOUD. #52 gave the
# lister a retry schedule and let a persistent outage propagate under set -e, so
# run-swarm can re-key the death to the "list ready tasks" stage (GOTCHAS #7).
# The timeout wrapper must not launder that into a quiet "nothing to do".
setup
printf '#!/usr/bin/env bash\nexit 22\n' >"$FAKE_DIR/lister"
chmod +x "$FAKE_DIR/lister"; export CLAIM_LISTER="$FAKE_DIR/lister"
out="$(bash "$script" 2>/dev/null)"; frc=$?
unset CLAIM_LISTER
check "a FAILING lister still exits non-zero (fails loud, #52/GOTCHAS 7)" '[ "$frc" -ne 0 ]'
check "a FAILING lister does not emit a laundered []" '[ "$out" != "[]" ]'

# T-#77c: an explicit CLAIM_API_MAX_TIME override is honoured (a consumer or a
# probe can retune it) — the sandbox default only applies when unset.
setup; mklister '[{"number":431,"title":"a","body":"b","url":"u"}]'
CLAIM_API_MAX_TIME=7 bash "$script" >/dev/null 2>&1
check "explicit CLAIM_API_MAX_TIME override wins" 'grep -q -- "--max-time 7" "$FAKE_DIR/argv.log"'

# T-#120: the alive-runs fetch is dispatched CONCURRENTLY with the lister, not
# serially after it. The two reads share no data; running them back-to-back
# summed the lister's ~16-25s of ready-queue reads and the ~11s actions/tasks
# leg past Sandcastle's 30s prompt-expansion budget (matou-app run 11019). Prove
# overlap with a lister that sleeps then stamps its finish: the tasks fetch must
# have already happened (its stamp precedes the lister's). Under the old serial
# order the tasks fetch fired AFTER the lister returned, so its stamp would be
# LATER — this test fails on that code and passes on the concurrent code.
setup; touch "$FAKE_DIR/stamp-tasks"
cat >"$FAKE_DIR/lister" <<EOF
#!/usr/bin/env bash
sleep 1
date +%s%N >"$FAKE_DIR/lister-done.stamp"
printf '%s' '[{"number":431,"title":"a","body":"b","url":"u"}]'
EOF
chmod +x "$FAKE_DIR/lister"; export CLAIM_LISTER="$FAKE_DIR/lister"
out="$(bash "$script")"
unset CLAIM_LISTER
check "concurrent alive-runs still claims the head" '[ "$(jq -r ".[0].number" <<<"$out")" = "431" ]'
check "alive-runs fetched before the slow lister finished (concurrent, not serial)" \
  '[ "$(cat "$FAKE_DIR/tasks-hit.stamp")" -lt "$(cat "$FAKE_DIR/lister-done.stamp")" ]'

echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
