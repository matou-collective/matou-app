#!/usr/bin/env bash
# Offline orchestrator test: stub agent, chat unset (posts go to stderr),
# fixture workdir. Run: bash .sandcastle/tests/heal-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail() { echo "FAIL: $1" >&2; exit 1; }
# Signature helpers, to assert WHICH signature a run keyed on (#235).
. "$here/../heal-lib.sh"

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
mkdir -p "$work/wd/.sandcastle/logs" "$work/state"
git init -q "$work/wd"
echo "boom: unmistakable error line 12345" > "$work/wd/.sandcastle/logs/x-worker.log"

run_heal() {
  # Pin the swarm verdict to a guaranteed-absent path so these scenarios degrade
  # deterministically and never read whatever /tmp verdict the host happens to
  # hold; the dedicated #235 block below exercises the present-verdict path.
  # Scrub the #510 two-account tokens from the baseline: the "without a standby"
  # scenario (line ~205) proves the healer DEFERS when no standby is configured,
  # but a workstation host running the two-account failover carries
  # CLAUDE_CODE_OAUTH_TOKEN_B in its ambient env — leaked in, it makes the healer
  # fail over instead of defer and reds that assertion (#586). The failover
  # scenario re-sets both explicitly (a later NAME=VALUE overrides -u), so this
  # only clears the ambient leak.
  env -u MATTERMOST_URL -u MATTERMOST_BOT_TOKEN -u MATTERMOST_CHANNEL_ID \
    -u CLAUDE_CODE_OAUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN_B \
    HEAL_MODE=hook WORKFLOW=swarm RUN_URL=http://x/runs/1 \
    HEAL_WORKDIR="$work/wd" HEALER_STATE="$work/state" \
    SWARM_VERDICT_PATH="$work/absent-swarm-verdict" \
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

# --- #197: a moved ci fault re-triggers investigation ------------------------
# ci has no readable log API; the seam script leaves a verdict at a well-known
# host path. Two consecutive ci failures with DIFFERENT faults must produce two
# investigations with distinct signatures — not a "still failing" one-liner (the
# 2026-07-30 masking). The same fault recurring stays unchanged (AC2). No
# readable verdict → degrade, but say so (AC3).
rm -f "$work/state/"*
verdict="$work/seam-verdict.txt"
run_heal_ci() {
  env -u MATTERMOST_URL -u MATTERMOST_BOT_TOKEN -u MATTERMOST_CHANNEL_ID \
    HEAL_MODE=hook WORKFLOW=ci RUN_URL=http://x/runs/9 \
    HEAL_WORKDIR="$work/wd" HEALER_STATE="$work/state" \
    SEAM_VERDICT_PATH="$verdict" \
    HEAL_AGENT_CMD="bash $here/fixtures/stub-agent.sh" \
    FORGEJO_TOKEN=dummy FORGEJO_API=http://127.0.0.1:9/api/v1/repos/x/y \
    "$@" bash "$here/../heal.sh" 2>&1
}
printf 'stage=Go: build/vet/test/lint\nexit=1\n--- error lines ---\nwiring_test.go:41:2: err shadows builtin (revive)\n' > "$verdict"
out="$(run_heal_ci)"
echo "$out" | grep -q "CLASS: harness-infra" || fail "first ci failure should investigate"
[ "$(ls "$work/state" | wc -l)" -eq 1 ] || fail "one ledger entry after the first ci failure"
# the stub marked this incident repaired=1; a DIFFERENT fault must NOT match it —
# a fresh investigation, a new signature, not escalate-repaired/reply-recurring.
printf 'stage=Go: build/vet/test/lint\nexit=1\n--- error lines ---\nconfig.go:88:3: this value of x is never used (SA4010) (staticcheck)\n' > "$verdict"
out="$(run_heal_ci)"
echo "$out" | grep -q "CLASS: harness-infra" || fail "a moved ci fault must re-investigate (post a fresh diagnosis)"
echo "$out" | grep -qiE "still failing|recurred after a repair" && fail "a moved ci fault must NOT be treated as the same incident"
[ "$(ls "$work/state" | wc -l)" -eq 2 ] || fail "a moved ci fault must create a second, distinct signature"
# the same fault recurring (already repaired) → escalate, unchanged, no new agent
out="$(run_heal_ci)"
echo "$out" | grep -qi "recurred after a repair" || fail "the same ci fault recurring must escalate as before"
echo "$out" | grep -q "CLASS: harness-infra" && fail "the same ci fault must not re-investigate"
[ "$(ls "$work/state" | wc -l)" -eq 2 ] || fail "the same ci fault must not create a new signature"
# no readable verdict at all → degrade, but say so in the post (AC3)
rm -f "$verdict" "$work/state/"*
out="$(run_heal_ci)"
echo "$out" | grep -qi "signature degraded to workflow name" || fail "a degraded ci signature must be flagged in the post"

# --- #235: swarm signatures are stage-aware, never worker-prose-derived -------
# The Sandcastle worker log is saturated with "error"/"failed" prose (a worker
# narrating an unrelated, already-closed ticket). Before #235, error_line grepped
# it and minted a phantom signature from whatever the newest stale log said. Now
# run-swarm.sh drops a stage/exit verdict and the signature keys on THAT; with no
# verdict it degrades to the workflow name and says so — never back to the prose.
rm -f "$work/state/"*
swarm_verdict="$work/swarm-verdict.txt"
printf 'thinking: no local Go to check — the error path failed, Failed again\nfatal: still narrating #198 which is already closed\n' \
  > "$work/wd/.sandcastle/logs/x-worker.log"
prosesig="$(compute_signature swarm "$(grep -hE 'error|Error|ERR|failed|Failed|timed out|fatal' "$work/wd/.sandcastle/logs/x-worker.log" | tail -1)")"
run_heal_swarm() {
  env -u MATTERMOST_URL -u MATTERMOST_BOT_TOKEN -u MATTERMOST_CHANNEL_ID \
    HEAL_MODE=hook WORKFLOW=swarm RUN_URL=http://x/runs/7 \
    HEAL_WORKDIR="$work/wd" HEALER_STATE="$work/state" \
    SWARM_VERDICT_PATH="$swarm_verdict" \
    HEAL_AGENT_CMD="bash $here/fixtures/stub-agent.sh" \
    FORGEJO_TOKEN=dummy FORGEJO_API=http://127.0.0.1:9/api/v1/repos/x/y \
    "$@" bash "$here/../heal.sh" 2>&1
}
# a stage marker present → the marker-derived signature, NOT the prose one
printf 'stage=pnpm install (frozen lockfile)\nexit=1\n--- error lines ---\nnpm error Missing: prettier from lock file\n' > "$swarm_verdict"
markersig="$(compute_signature swarm "$(seam_verdict_signal "$swarm_verdict")")"
out="$(run_heal_swarm)"
[ -f "$work/state/$markersig" ] || fail "swarm signature must key on the stage marker, not worker prose"
[ ! -f "$work/state/$prosesig" ] || fail "swarm signature must NOT be minted from worker chain-of-thought prose"
echo "$out" | grep -qi "signature degraded" && fail "a fresh swarm verdict must NOT flag the signature degraded"
[ "$markersig" != "$prosesig" ] || fail "test bug: marker and prose signatures must differ to be meaningful"

# prose alone (no verdict) → degrade to the workflow name, flagged degraded
rm -f "$swarm_verdict" "$work/state/"*
degraded="$(compute_signature swarm "")"
out="$(run_heal_swarm)"
[ -f "$work/state/$degraded" ] || fail "with no verdict the swarm signature must degrade to the workflow name alone"
[ ! -f "$work/state/$prosesig" ] || fail "the degrade path must NOT fall back to grepping worker prose"
echo "$out" | grep -qi "signature degraded to workflow name" || fail "a degraded swarm signature must be flagged in the post"

# a STALE verdict (older than the run window) is not this run's — degrade, say so
rm -f "$work/state/"*
printf 'stage=pnpm install (frozen lockfile)\nexit=1\n--- error lines ---\nnpm error Missing: prettier from lock file\n' > "$swarm_verdict"
touch -d '5 hours ago' "$swarm_verdict"
out="$(run_heal_swarm)"
[ -f "$work/state/$degraded" ] || fail "a stale swarm verdict must be ignored (degrade to the workflow name)"
echo "$out" | grep -qi "signature degraded to workflow name" || fail "a stale swarm verdict must flag the signature degraded"
rm -f "$swarm_verdict"

# --- #10: smoke-drive is a verdict-bearing workflow too ---------------------
# The reader half of matou-app#46: a consumer's smoke driver writes the same
# stage/exit marker run-swarm.sh does, at /tmp/matou-<tag>-smoke-drive-verdict.txt.
# verdict_path used to return empty for `smoke-drive`, so a red smoke lap fell
# through to the prose grep and minted a signature from an unrelated worker
# session. Pin: the marker keys the signature, and its absence degrades (never
# prose), exactly like swarm.
rm -f "$work/state/"*
smoke_verdict="$work/smoke-drive-verdict.txt"
run_heal_smoke() {
  env -u MATTERMOST_URL -u MATTERMOST_BOT_TOKEN -u MATTERMOST_CHANNEL_ID \
    HEAL_MODE=hook WORKFLOW=smoke-drive RUN_URL=http://x/runs/8 \
    HEAL_WORKDIR="$work/wd" HEALER_STATE="$work/state" \
    SMOKE_DRIVE_VERDICT_PATH="$smoke_verdict" \
    HEAL_AGENT_CMD="bash $here/fixtures/stub-agent.sh" \
    FORGEJO_TOKEN=dummy FORGEJO_API=http://127.0.0.1:9/api/v1/repos/x/y \
    "$@" bash "$here/../heal.sh" 2>&1
}
printf 'stage=registration\nexit=1\n--- error lines ---\n1) [chromium] › e2e-registration.spec.ts:732 › register and approve a second member\n' > "$smoke_verdict"
smokesig="$(compute_signature smoke-drive "$(seam_verdict_signal "$smoke_verdict")")"
smokeprose="$(compute_signature smoke-drive "$(grep -hE 'error|Error|ERR|failed|Failed|timed out|fatal' "$work/wd/.sandcastle/logs/x-worker.log" | tail -1)")"
out="$(run_heal_smoke)"
[ -f "$work/state/$smokesig" ] || fail "smoke-drive signature must key on the driver's verdict marker (#10)"
[ ! -f "$work/state/$smokeprose" ] || fail "smoke-drive signature must NOT be minted from worker prose"
echo "$out" | grep -qi "signature degraded" && fail "a fresh smoke-drive verdict must NOT flag the signature degraded"
rm -f "$work/state/"* "$smoke_verdict"
smokedeg="$(compute_signature smoke-drive "")"
out="$(run_heal_smoke)"
[ -f "$work/state/$smokedeg" ] || fail "with no smoke-drive verdict the signature must degrade to the workflow name"
[ ! -f "$work/state/$smokeprose" ] || fail "the smoke-drive degrade path must NOT grep worker prose"
echo "$out" | grep -qi "signature degraded to workflow name" || fail "a degraded smoke-drive signature must be flagged in the post"

# fresh state; agent that never writes diagnosis.md → healer posts plain alert
rm -f "$work/state/"* "$work/wd/.sandcastle/logs/"*.log
echo "boom: unmistakable error line 12345" > "$work/wd/.sandcastle/logs/x-worker.log"
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

# failover (#510): the agent's FIRST call answers the weekly-limit line; the
# SECOND — after the flip to the standby account — diagnoses normally. With a
# standby token configured the heal rides over: no deferral, diagnosis posted,
# the active-account marker names B, and the host is NOT parked. Markers point
# at temp paths so the scenario never touches the real /tmp markers.
flipstub="$work/flip-stub.sh"
cat > "$flipstub" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
n=$(( $(cat "${FLIP_COUNT:?}" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$FLIP_COUNT"
if [ "$n" = 1 ]; then
  echo "You've hit your weekly limit · resets Aug 15, 8am (UTC)"
  exit 1
fi
exec bash "${REAL_STUB:?}" "$1"
EOF
chmod +x "$flipstub"
rm -rf "$work/state"; mkdir -p "$work/state"
echo 0 > "$work/flip-count"
out="$(run_heal HEAL_AGENT_CMD="bash $flipstub" FLIP_COUNT="$work/flip-count" \
  REAL_STUB="$here/fixtures/stub-agent.sh" \
  CLAUDE_CODE_OAUTH_TOKEN=tok-A CLAUDE_CODE_OAUTH_TOKEN_B=tok-B \
  CLAUDE_ACTIVE_MARKER="$work/active-marker" CLAUDE_LIMIT_MARKER="$work/limit-marker")"
echo "$out" | grep -q "failed over to account B" || fail "a limit on A with a standby must fail over"
echo "$out" | grep -q "CLASS: harness-infra" || fail "the retried diagnosis must post after the failover"
[ "$(cat "$work/active-marker")" = "B" ] || fail "the active-account marker must name B after the failover"
[ -f "$work/limit-marker" ] && fail "a successful ride-over must NOT park the host"

# and WITHOUT a standby the same first answer defers exactly as before — the
# host parks, no diagnosis is forced.
rm -rf "$work/state"; mkdir -p "$work/state"
rm -f "$work/active-marker" "$work/limit-marker"
echo 0 > "$work/flip-count"
out="$(run_heal HEAL_AGENT_CMD="bash $flipstub" FLIP_COUNT="$work/flip-count" \
  REAL_STUB="$here/fixtures/stub-agent.sh" \
  CLAUDE_ACTIVE_MARKER="$work/active-marker" CLAUDE_LIMIT_MARKER="$work/limit-marker")"
echo "$out" | grep -qi "deferred — Claude usage limit" || fail "a limit without a standby must defer as before"
[ -f "$work/limit-marker" ] || fail "the deferral must park the host"

echo "heal.sh: 9 scenarios passed"
