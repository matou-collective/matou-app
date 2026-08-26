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

echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
