#!/usr/bin/env bash
# Offline orchestrator test: stub agent, chat unset (posts go to stderr),
# fixture workdir. Run: bash .sandcastle/tests/heal-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail() { echo "FAIL: $1" >&2; exit 1; }

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
mkdir -p "$work/wd/.sandcastle/logs" "$work/state"
git init -q "$work/wd"
echo "boom: unmistakable error line 12345" > "$work/wd/.sandcastle/logs/x-worker.log"

run_heal() {
  env -u MATTERMOST_URL -u MATTERMOST_BOT_TOKEN -u MATTERMOST_CHANNEL_ID \
    HEAL_MODE=hook WORKFLOW=swarm RUN_URL=http://x/runs/1 \
    HEAL_WORKDIR="$work/wd" HEALER_STATE="$work/state" \
    HEAL_AGENT_CMD="bash $here/fixtures/stub-agent.sh" \
    FORGEJO_TOKEN=dummy FORGEJO_API=http://127.0.0.1:9/api/v1/repos/x/y \
    "$@" bash "$here/../heal.sh" 2>&1
}

# 1st hook: new signature → stub agent runs, diagnosis posted, ledger written
out="$(run_heal)"
echo "$out" | grep -q "CLASS: harness-infra" || fail "first run should post the diagnosis"
[ "$(ls "$work/state" | wc -l)" -eq 1 ] || fail "one ledger entry expected"
sig="$(ls "$work/state")"
grep -q "repaired=1" "$work/state/$sig" || fail "ACTION-TAKEN != none should mark repaired=1"

# 2nd hook, same fault, still in cooldown, already repaired → escalate, NO agent
out="$(run_heal)"
echo "$out" | grep -qi "recurred after a repair" || fail "repaired recurrence should escalate"
echo "$out" | grep -q "stub agent ran" && fail "escalation must not re-run the agent"

# fresh state; dry-run flows through to the report path, and must NOT mark
# the incident repaired (a dry run changes nothing, so the loop-breaker must
# stay armed for a real attempt later)
rm -f "$work/state/$sig"
out="$(run_heal HEAL_DRY_RUN=1)"
echo "$out" | grep -q "\[dry-run\]" || fail "dry-run posts must be prefixed"
grep -q "repaired=1" "$work/state/$sig" && fail "dry-run must not mark repaired=1"

# The 2026-07-29 storm, end to end: a fault that recurs forever in DRY-RUN.
# `repaired` stays 0 (asserted above), so escalate-repaired can never fire —
# the reply cap is the only brake. It must reply HEAL_MAX_REPLIES times, then
# escalate exactly once, then say nothing at all. Before the cap, this loop
# posted "still failing" on every single run: 70 times in 92 minutes.
rm -f "$work/state/"*
replies=0; escalations=0; silences=0
for _ in 1 2 3 4 5 6 7 8; do
  out="$(run_heal HEAL_DRY_RUN=1 HEAL_MAX_REPLIES=3)"
  echo "$out" | grep -q "still failing"        && replies=$((replies+1))
  echo "$out" | grep -q "going quiet on it"    && escalations=$((escalations+1))
  echo "$out" | grep -q "already escalated and silenced" && silences=$((silences+1))
done
# run 1 investigates (posts the diagnosis), runs 2-4 reply, run 5 escalates,
# runs 6-8 are silent.
[ "$replies" -eq 3 ]     || fail "expected exactly 3 capped replies, got $replies"
[ "$escalations" -eq 1 ] || fail "expected exactly ONE escalation, got $escalations"
[ "$silences" -eq 3 ]    || fail "expected the last 3 runs to post nothing, got $silences"
sig2="$(ls "$work/state" | head -1)"
grep -q "repaired=1" "$work/state/$sig2" && fail "the storm path must never mark a dry run repaired"

# fresh state; agent that never writes diagnosis.md → healer posts plain alert
rm -f "$work/state/"*
out="$(run_heal HEAL_AGENT_CMD=true)"
echo "$out" | grep -qi "healer could not produce a diagnosis" || fail "agent failure must fall back to a plain alert"

# 5th: watchdog-mode exit-status regression, locking in the fix to the
# `[ "$found" -eq 0 ] && echo ...` tail (was the script's last-executed
# command, so its failure leaked as heal.sh's own exit code — see the task-4
# report). This offline harness's FORGEJO_API is unreachable, so a real
# watchdog run always trips the api-latency incident (found=1) — exercise
# that path for real. The found=0 "all healthy" tail isn't reachable offline
# without a live 2xx endpoint, so its exact line shape is regressed directly.
rm -f "$work/state/"*
if out="$(run_heal HEAL_MODE=watchdog)"; then ec=0; else ec=$?; fi
[ "$ec" -eq 0 ] || fail "watchdog run that handles an incident (found=1) must exit 0, got $ec"
echo "$out" | grep -q "incident wf=forgejo-api" || fail "expected the offline harness's unreachable API to trip the api-latency incident"

if out2="$(bash -c 'set -euo pipefail; found=0; if [ "$found" -eq 0 ]; then echo "heal: watchdog — all healthy"; fi')"; then ec=0; else ec=$?; fi
[ "$ec" -eq 0 ] || fail "found=0 watchdog tail pattern must exit 0"
echo "$out2" | grep -q "watchdog — all healthy" || fail "found=0 watchdog tail pattern must print the healthy message"

echo "heal.sh: 6 scenarios passed"
