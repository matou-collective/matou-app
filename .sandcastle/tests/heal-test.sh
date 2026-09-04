#!/usr/bin/env bash
# Offline orchestrator test: stub agent, chat unset (posts go to stderr),
# fixture workdir. Run: bash .sandcastle/tests/heal-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail() { echo "FAIL: $1" >&2; exit 1; }
# Signature helpers, to assert WHICH signature a run keyed on (#235).
. "$here/../heal-lib.sh"

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
# #116: heal.sh mirrors a heal run row + limit-pause park edges into swarm.db;
# redirect every host-state path into $work and arm the leak tripwire at the seam
# (every per-invocation SWARM_DB below stays under $work, so it passes).
# shellcheck source=test-env.sh
. "$here/test-env.sh"; test_env_hermetic "$work"
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
  # Same lesson one level in (#79): limit-lib's markers are HOST-GLOBAL paths by
  # design, so a host that is genuinely limit-parked while the suite runs made
  # every agent-path scenario here bail at the #253 gate ("deferred — Claude
  # usage limit window") and read as a code red. Pin them into $work; the
  # failover scenarios still name their own.
  # Same class one file over (#90): HOST_CAPACITY_DRIVE_WANTED defaults to a
  # host-global path, so a real rehearsal drive waiting while the suite runs made
  # heal.sh yield at the #663 drive gate before ever reaching the stub agent. Pin
  # it (and the healer's own defer count) into $work too — run_heal_ci must too.
  # Same class again (#102): the per-repo-tag healer lock defaults to a
  # host-global /tmp path, so two suite runs on one box (two agents, two
  # worktrees, a cron tick beside a dev) contended for one file and the loser
  # exited "another healer holds the lock" with no diagnosis — a red that
  # depended on who else was on the host. Pin it into $work; the concurrent-lock
  # block below names its own.
  env -u MATTERMOST_URL -u MATTERMOST_BOT_TOKEN -u MATTERMOST_CHANNEL_ID \
    -u CLAUDE_CODE_OAUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN_B \
    CLAUDE_LIMIT_MARKER="$work/ambient-limit-marker" \
    CLAUDE_ACTIVE_MARKER="$work/ambient-active-marker" \
    HEAL_MODE=hook WORKFLOW=swarm RUN_URL=http://x/runs/1 \
    HEAL_WORKDIR="$work/wd" HEALER_STATE="$work/state" SWARM_DB="$work/swarm.db" \
    SWARM_VERDICT_PATH="$work/absent-swarm-verdict" \
    HEAL_AGENT_CMD="bash $here/fixtures/stub-agent.sh" \
    HEAL_PROMPT_FILE="$here/../.sandcastle/heal-prompt.md" \
    FORGEJO_TOKEN=dummy FORGEJO_API=http://127.0.0.1:9/api/v1/repos/x/y \
    HOST_CAPACITY_DRIVE_WANTED="$work/absent-drive-wanted" \
    HEALER_DRIVE_DEFER_COUNT="$work/healer-defer-count" \
    HEALER_LOCK="$work/healer.lock" \
    "$@" bash "$here/../heal.sh" 2>&1
}

# 1st hook: new signature → stub agent runs, diagnosis posted, ledger written
out="$(run_heal)"
echo "$out" | grep -q "CLASS: harness-infra" || fail "first run should post the diagnosis"
[ "$(ls "$work/state" | wc -l)" -eq 1 ] || fail "one ledger entry expected"
sig="$(ls "$work/state")"
grep -q "repaired=1" "$work/state/$sig" || fail "ACTION-TAKEN != none should mark repaired=1"

# 2nd hook, same fault, still in cooldown, already repaired → escalate, NO agent
out="$(run_heal SWARM_HOST=box1)"
echo "$out" | grep -qi "recurred after a repair" || fail "repaired recurrence should escalate"
echo "$out" | grep -q "stub agent ran" && fail "escalation must not re-run the agent"
# --- #79: the escalation names the host it actually RAN on, never a literal ---
# The 2026-08-24 pings all read "on matou-workstation" while the healer was
# running on another box in the pool, so every evidence path pointed at a
# directory that does not exist there (and a product's box was baked into a
# vendored harness file — CLAUDE.md's blast-radius rule).
echo "$out" | grep -q "evidence: .* on box1" || fail "the escalation must name the healer's own host (got: $out)"
echo "$out" | grep -q "matou-workstation" && fail "no hardcoded host may appear in healer post text (#79)"

# --- #79: escalate-repaired latches, exactly like escalate-noisy -------------
# It used to set NOTHING: `repaired=1` short-circuits ledger_decide ahead of the
# reply cap, so every later recurrence inside the cooldown re-pinged @ben — one
# ping per red run, one run every ~2 minutes, indefinitely (the storm this
# ticket closes). Say it once, then go quiet for the rest of the window.
grep -q "escalated=1" "$work/state/$sig" || fail "escalate-repaired must set the silence latch (#79)"
for n in 3 4 5; do
  out="$(run_heal)"
  echo "$out" | grep -q "already escalated and silenced" \
    || fail "recurrence $n after a repaired escalation must post nothing (#79), got: $out"
  echo "$out" | grep -q "@ben" && fail "recurrence $n must not re-ping @ben (#79)"
done

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

# --- #79: a filed ticket is an ACTION, but it is not a repair ----------------
# On 2026-08-24 the diagnosis's only action was "filed ready-for-agent ticket
# #77" — nothing on the host or in the repo changed, so the fault recurred on
# every run and each recurrence carried no new information. Marking it
# `repaired` put it on the loop-breaker path (one @ben ping per recurrence back
# then); it belongs on the normal reply-cap ladder: three thread replies, ONE
# escalation, then silence — and the replies say a ticket is already filed.
rm -f "$work/state/"*
replies=0; escalations=0; pings=0; silences=0; repaired_recur=0
for _ in 1 2 3 4 5 6 7 8; do
  out="$(run_heal HEAL_MAX_REPLIES=3 STUB_ACTION='filed ready-for-agent ticket #77')"
  echo "$out" | grep -q "still failing"        && replies=$((replies+1))
  echo "$out" | grep -q "going quiet on it"    && escalations=$((escalations+1))
  echo "$out" | grep -q "already escalated and silenced" && silences=$((silences+1))
  echo "$out" | grep -q "@ben"                 && pings=$((pings+1))
  echo "$out" | grep -qi "recurred after a repair" && repaired_recur=$((repaired_recur+1))
done
tsig="$(ls "$work/state" | head -1)"
grep -q "repaired=1" "$work/state/$tsig" && fail "filing a ticket must NOT mark the signature repaired (#79)"
grep -q "ticketed=1" "$work/state/$tsig" || fail "a filed-ticket outcome must be recorded as ticketed=<n> (#79)"
[ "$repaired_recur" -eq 0 ] || fail "a ticketed fault must never take the repaired path, got $repaired_recur"
[ "$replies" -eq 3 ]     || fail "a ticketed fault must ride the reply cap (3 replies), got $replies"
[ "$escalations" -eq 1 ] || fail "a ticketed fault must escalate exactly once, got $escalations"
[ "$silences" -eq 3 ]    || fail "a ticketed fault must then go silent, got $silences"
[ "$pings" -eq 1 ]       || fail "a ticketed fault must ping @ben exactly once per window, got $pings"
# the thread replies point at the ticket rather than repeating an unexplained
# "still failing" — the recurrence is expected until the fix lands
out="$(run_heal HEAL_MAX_REPLIES=99 STUB_ACTION='filed ready-for-agent ticket #77')"
echo "$out" | grep -qi "already escalated and silenced" || fail "the latch must still hold with a raised cap"
rm -f "$work/state/"*
run_heal STUB_ACTION='filed ready-for-agent ticket #77' >/dev/null
out="$(run_heal STUB_ACTION='filed ready-for-agent ticket #77')"
echo "$out" | grep -q "still failing" || fail "the second sighting of a ticketed fault must thread-reply"
echo "$out" | grep -qi "ticket" || fail "a ticketed fault's reply should say a ticket is already filed (#79)"

# a real repair (the default stub action) still takes the repaired path
rm -f "$work/state/"*
run_heal >/dev/null
rsig="$(ls "$work/state" | head -1)"
grep -q "repaired=1" "$work/state/$rsig" || fail "a genuine repair must still mark repaired=1"

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
    HEAL_WORKDIR="$work/wd" HEALER_STATE="$work/state" SWARM_DB="$work/swarm.db" \
    SEAM_VERDICT_PATH="$verdict" \
    CLAUDE_LIMIT_MARKER="$work/ambient-limit-marker" \
    CLAUDE_ACTIVE_MARKER="$work/ambient-active-marker" \
    HEAL_AGENT_CMD="bash $here/fixtures/stub-agent.sh" \
    HEAL_PROMPT_FILE="$here/../.sandcastle/heal-prompt.md" \
    FORGEJO_TOKEN=dummy FORGEJO_API=http://127.0.0.1:9/api/v1/repos/x/y \
    HOST_CAPACITY_DRIVE_WANTED="$work/absent-drive-wanted" \
    HEALER_DRIVE_DEFER_COUNT="$work/healer-defer-count" \
    HEALER_LOCK="$work/healer.lock" \
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
    HEAL_WORKDIR="$work/wd" HEALER_STATE="$work/state" SWARM_DB="$work/swarm.db" \
    SWARM_VERDICT_PATH="$swarm_verdict" \
    CLAUDE_LIMIT_MARKER="$work/ambient-limit-marker" \
    CLAUDE_ACTIVE_MARKER="$work/ambient-active-marker" \
    HEAL_AGENT_CMD="bash $here/fixtures/stub-agent.sh" \
    HEAL_PROMPT_FILE="$here/../.sandcastle/heal-prompt.md" \
    FORGEJO_TOKEN=dummy FORGEJO_API=http://127.0.0.1:9/api/v1/repos/x/y \
    HOST_CAPACITY_DRIVE_WANTED="$work/absent-drive-wanted" \
    HEALER_DRIVE_DEFER_COUNT="$work/healer-defer-count" \
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

# --- #34: a SIGKILL'd (probable OOM) heavy job leaves a breadcrumb, no verdict ---
# The verdict seam is EXIT-trap-driven and a SIGKILL is untrappable, so a
# resource-killed run writes no verdict — before this fix the healer degraded to
# the bare workflow name (`sha1("swarm|")`) and burned a full investigation on a
# NON-fault. Now verdict-lib.sh drops an eager breadcrumb at each stage; with a
# fresh breadcrumb but no verdict the healer keys the signature on the killed
# STAGE, DOWNGRADES (no investigation agent), and posts a low-severity note.
rm -f "$swarm_verdict" "$work/state/"*
bcrumb="$swarm_verdict.breadcrumb"
printf 'stage=sandcastle run (workers)\nstatus=running\n' > "$bcrumb"
killedsig="$(compute_signature swarm "killed mid-stage :: sandcastle run (workers)")"
out="$(run_heal_swarm)"
[ -f "$work/state/$killedsig" ] || fail "a killed run must key the signature on the breadcrumb's stage (#34)"
[ ! -f "$work/state/$degraded" ] || fail "a killed run must NOT mint the bare workflow-name signature (#34)"
echo "$out" | grep -qi "probable resource kill" || fail "a killed run must post a probable-resource-kill note (#34)"
echo "$out" | grep -q "stub agent ran" && fail "a killed run must NOT burn an investigation agent (#34)"

# a STALE breadcrumb (older than the run window) is a prior run's — it must NOT
# trigger the kill path; degrade to the bare workflow name exactly as before.
rm -f "$work/state/"*
touch -d '5 hours ago' "$bcrumb"
out="$(run_heal_swarm)"
[ -f "$work/state/$degraded" ] || fail "a stale breadcrumb must degrade to the workflow name, not the kill path (#34)"
[ ! -f "$work/state/$killedsig" ] || fail "a stale breadcrumb must NOT be read as this run's kill (#34)"
echo "$out" | grep -qi "signature degraded to workflow name" || fail "a stale breadcrumb must still flag the signature degraded (#34)"
rm -f "$bcrumb"

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
    HEAL_WORKDIR="$work/wd" HEALER_STATE="$work/state" SWARM_DB="$work/swarm.db" \
    SMOKE_DRIVE_VERDICT_PATH="$smoke_verdict" \
    CLAUDE_LIMIT_MARKER="$work/ambient-limit-marker" \
    CLAUDE_ACTIVE_MARKER="$work/ambient-active-marker" \
    HEAL_AGENT_CMD="bash $here/fixtures/stub-agent.sh" \
    HEAL_PROMPT_FILE="$here/../.sandcastle/heal-prompt.md" \
    FORGEJO_TOKEN=dummy FORGEJO_API=http://127.0.0.1:9/api/v1/repos/x/y \
    HOST_CAPACITY_DRIVE_WANTED="$work/absent-drive-wanted" \
    HEALER_DRIVE_DEFER_COUNT="$work/healer-defer-count" \
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

# --- #19: the healer exports the factory git identity to the agent ----------
# heal.sh's diagnosis clones ~/swarm/... into /tmp/heal-fix and commits there;
# without an explicit identity those commits inherit the host user's ~/.gitconfig
# (Cherese on matou-workstation). Assert the agent process sees GIT_AUTHOR_NAME
# naming the healer class + host, sourced from swarm-identity.sh — never the
# host gitconfig. SWARM_HOST/REPO_SLUG pinned so the assertion is host-agnostic.
rm -f "$work/state/"*
idcap="$work/heal-git-identity"
cat > "$work/id-agent.sh" <<'EOF'
#!/usr/bin/env bash
{ echo "GIT_AUTHOR_NAME=${GIT_AUTHOR_NAME:-}"
  echo "GIT_AUTHOR_EMAIL=${GIT_AUTHOR_EMAIL:-}"
  echo "GIT_COMMITTER_NAME=${GIT_COMMITTER_NAME:-}"
  echo "GIT_COMMITTER_EMAIL=${GIT_COMMITTER_EMAIL:-}"; } > "${IDCAP:?}"
EOF
chmod +x "$work/id-agent.sh"
run_heal HEAL_AGENT_CMD="bash $work/id-agent.sh" IDCAP="$idcap" \
  SWARM_HOST=box1 REPO_SLUG=Acme/widget >/dev/null 2>&1 || true
grep -q "^GIT_AUTHOR_NAME=Acme Swarm (healer@box1)$" "$idcap" \
  || fail "the healer must export GIT_AUTHOR_NAME naming the healer class + host (got: $(cat "$idcap" 2>/dev/null))"
grep -q "^GIT_COMMITTER_NAME=Acme Swarm (healer@box1)$" "$idcap" \
  || fail "the healer's committer identity must match the author"
grep -q "^GIT_AUTHOR_EMAIL=swarm@" "$idcap" || fail "the healer must export a factory author email"

# --- drive reservation (#663/#664/#30): the healer's investigation is a heavy
# (claude-calling) consumer, so a FRESH reservation makes it stand down — exit 0,
# no agent run, no ledger touched — and climb its own consecutive-defer count; an
# EXPIRED (mtime > TTL) reservation does not. ---
rm -rf "$work/state"; mkdir -p "$work/state"
drive="$work/drive-wanted"; hdefer="$work/healer-defer-count"
rm -f "$hdefer"; : > "$drive"
out="$(run_heal HOST_CAPACITY_DRIVE_WANTED="$drive" HEALER_DRIVE_DEFER_COUNT="$hdefer")"
echo "$out" | grep -qi "yielding this run to a ready drive" || fail "a standing reservation must make the healer yield (got: $out)"
echo "$out" | grep -q "skipped 1 consecutive tick(s)" || fail "the first deferred tick must read skipped 1 (got: $out)"
echo "$out" | grep -q "stub agent ran" && fail "a drive-yield must stop BEFORE the investigation agent runs (got: $out)"
[ "$(ls "$work/state" | wc -l)" -eq 0 ] || fail "a drive-yield must not touch the ledger"
[ "$(cat "$hdefer")" = 1 ] || fail "the first deferred tick must leave a defer count of 1, got: $(cat "$hdefer" 2>/dev/null)"
out="$(run_heal HOST_CAPACITY_DRIVE_WANTED="$drive" HEALER_DRIVE_DEFER_COUNT="$hdefer")"
echo "$out" | grep -q "skipped 2 consecutive tick(s)" || fail "the count must climb on a second consecutive defer (got: $out)"
# expired reservation → the healer proceeds (agent runs), and the counter resets.
touch -d '@1' "$drive"
out="$(run_heal HOST_CAPACITY_DRIVE_WANTED="$drive" HEALER_DRIVE_DEFER_COUNT="$hdefer")"
echo "$out" | grep -qi "yielding this run to a ready drive" && fail "an expired reservation must NOT make the healer yield (got: $out)"
echo "$out" | grep -q "CLASS: harness-infra" || fail "an expired reservation must let the investigation proceed (got: $out)"
[ -f "$hdefer" ] && fail "proceeding past the reservation must reset the consecutive-defer counter"

# --- #92: a heal that actually invokes claude is recorded as a run in swarm.db ---
# The investigation is a claude call — a pooled heavy slot up to 15 min — that
# used to leave swarm.db empty, so heal time was invisible to the machine
# timeline, the util bar, and any later reconstruction of host activity. A heal
# that reaches the agent must open a `heal`-trigger run row + a claude process
# row, close them on exit with the investigation's outcome as verdict, and write
# a `heal` event pointing at the evidence dir. A heal that never reaches claude
# (a downgraded kill) records NOTHING. swarm.db needs python3; skip cleanly when
# it is absent (the mirror is best-effort — the run must not depend on it).
if command -v python3 >/dev/null 2>&1; then
  db92="$work/heal-trace.db"
  # Robust to a db that was never created (the negative case writes nothing, so
  # the file / tables may not exist): a missing db or table reads as empty.
  sqval() { python3 - "$db92" "$1" <<'PY'
import sqlite3, sys, os
try:
    row = sqlite3.connect(sys.argv[1]).execute(sys.argv[2]).fetchone()
    print("" if row is None or row[0] is None else row[0])
except sqlite3.OperationalError:
    print("")
PY
  }
  rm -f "$db92"; rm -rf "$work/state"; mkdir -p "$work/state"
  echo "boom: unmistakable error line 12345" > "$work/wd/.sandcastle/logs/x-worker.log"
  run_heal SWARM_DB="$db92" >/dev/null
  [ "$(sqval "SELECT count(*) FROM runs WHERE trigger='heal'")" = 1 ] \
    || fail "an investigating heal must open exactly one heal-trigger run row (#92)"
  [ "$(sqval "SELECT verdict FROM runs WHERE trigger='heal'")" = diagnosed ] \
    || fail "a produced diagnosis must close the run with verdict 'diagnosed' (#92)"
  [ -n "$(sqval "SELECT ended_at FROM runs WHERE trigger='heal'")" ] \
    || fail "the heal run must be finalised on exit (ended_at set) (#92)"
  [ "$(sqval "SELECT count(*) FROM processes WHERE kind='claude'")" = 1 ] \
    || fail "an investigating heal must open a claude process row (#92)"
  [ -n "$(sqval "SELECT ended_at FROM processes WHERE kind='claude'")" ] \
    || fail "the claude process row must be closed on exit (#92)"
  [ "$(sqval "SELECT count(*) FROM events WHERE kind='heal'")" = 1 ] \
    || fail "an investigating heal must write exactly one heal event (#92)"
  ev92="$(sqval "SELECT evidence FROM events WHERE kind='heal'")"
  case "$ev92" in /tmp/matou-heal-x-y.*) ;; *) fail "the heal event must point at the evidence dir (got: $ev92) (#92)";; esac

  # a heal that never reaches claude (a downgraded SIGKILL, #34) records NOTHING:
  # the trace choke point is the claude call, not the script's entry.
  rm -f "$db92"; rm -rf "$work/state"; mkdir -p "$work/state"
  swarm_verdict="$work/heal92-verdict.txt"
  printf 'stage=sandcastle run (workers)\nstatus=running\n' > "$swarm_verdict.breadcrumb"
  run_heal_swarm SWARM_DB="$db92" >/dev/null
  [ "$(sqval "SELECT count(*) FROM runs")" = 0 ] || [ -z "$(sqval "SELECT count(*) FROM runs")" ] \
    || fail "a downgraded kill (no claude call) must open NO run row (#92)"
  [ "$(sqval "SELECT count(*) FROM events WHERE kind='heal'")" = 0 ] || [ -z "$(sqval "SELECT count(*) FROM events WHERE kind='heal'")" ] \
    || fail "a heal that never invokes claude must write NO heal event (#92)"
  rm -f "$swarm_verdict.breadcrumb" "$swarm_verdict"
fi

# --- #102: the healer lock path is env-overridable, so concurrent suite runs on
# one host stop contending for a single /tmp file. While one lock is HELD, a
# healer pointed at the SAME path bails with no diagnosis, but one pointed at a
# DISTINCT path proceeds and diagnoses — proving distinct paths don't collide.
# The default still keeps one-healer-per-repo-tag mutual exclusion (the point of
# the lock); this only makes the path pinnable, exactly like the marker paths.
rm -rf "$work/state"; mkdir -p "$work/state"
echo "boom: unmistakable error line 12345" > "$work/wd/.sandcastle/logs/x-worker.log"
held="$work/held.lock"
exec 9>"$held"; flock -n 9 || fail "test setup could not take the held lock (#102)"
out="$(run_heal HEALER_LOCK="$held")"
echo "$out" | grep -q "another healer holds the lock" \
  || fail "a healer sharing a held lock path must bail (#102, got: $out)"
echo "$out" | grep -q "CLASS:" && fail "a locked-out healer must post NO diagnosis (#102, got: $out)"
[ "$(ls "$work/state" | wc -l)" -eq 0 ] || fail "a locked-out healer must not touch the ledger (#102)"
out="$(run_heal HEALER_LOCK="$work/other.lock")"
echo "$out" | grep -q "CLASS: harness-infra" \
  || fail "a healer with a distinct lock path must proceed while another lock is held (#102, got: $out)"
exec 9>&-

# --- #123: every agent-issued docker run must be reapable -------------------
# The heal-prompt tells the agent to stamp `--label matou.factory=heal --label
# matou.run=<heal-run-id>` on every docker run it issues during a bisect, so
# #122's label reap fires at HEAL_REAP_CEILING instead of waiting out the 3h
# image belt. heal.sh hands it the concrete run id in the incident block and
# wraps the agent in `timeout --kill-after` so the agent's cleanup trap runs on
# SIGTERM before the hard kill. Assert the LIVE prompt carries the label
# instruction + a concrete `Heal run id`, and that the source uses --kill-after.
rm -rf "$work/state"; mkdir -p "$work/state"
echo "boom: unmistakable error line 12345" > "$work/wd/.sandcastle/logs/x-worker.log"
pcap="$work/heal-prompt-capture"
cat > "$work/prompt-agent.sh" <<'EOF'
#!/usr/bin/env bash
printf '%s' "$1" > "${PCAP:?}"
ev="$(printf '%s' "$1" | sed -n 's/^- Evidence directory: \([^ ]*\).*/\1/p' | head -1)"
cat > "$ev/diagnosis.md" <<'D'
CLASS: harness-infra
CONFIDENCE: high
ACTION-TAKEN: none
ESCALATE: no

**Root cause** — stub.
D
EOF
chmod +x "$work/prompt-agent.sh"
run_heal HEAL_AGENT_CMD="bash $work/prompt-agent.sh" PCAP="$pcap" >/dev/null 2>&1 || true
grep -q -- '--label matou.factory=heal --label matou.run=<heal-run-id>' "$pcap" \
  || fail "the heal prompt must instruct every docker run to carry matou.factory=heal + matou.run (#123)"
grep -qE '^- Heal run id: heal-.*-[0-9]+-[0-9]+$' "$pcap" \
  || fail "the incident block must hand the agent a concrete Heal run id for the matou.run label (#123, got: $(grep -i 'heal run id' "$pcap" 2>/dev/null))"
grep -q 'timeout --kill-after=30 900' "$here/../heal.sh" \
  || fail "heal.sh must wrap the agent timeout with --kill-after so a cleanup trap runs before the hard kill (#123)"

# --- #377: a failing leg that ran on the OTHER pool host leaves no local
# evidence — the healer must say so explicitly, not hand the agent empty files.
# swarm is a 2-host runner pool; when the fault ran elsewhere gather_evidence
# finds no fresh worker log and no fresh verdict locally. It must (a) stamp its
# OWN host into the bundle, and (b) write the explicit "ran on another pool host"
# line into worker-logs.txt / run-verdict.txt instead of leaving them empty.
rm -rf "$work/state"; mkdir -p "$work/state"
rm -f "$work/wd/.sandcastle/logs/"*.log        # no host-local worker log for this run
capdir="$work/ev-capture"
cat > "$work/capture-agent.sh" <<'EOF'
#!/usr/bin/env bash
ev="$(printf '%s' "$1" | sed -n 's/^- Evidence directory: \([^ ]*\).*/\1/p' | head -1)"
mkdir -p "${CAPDIR:?}"
cp "$ev/worker-logs.txt" "$ev/run-verdict.txt" "$ev/healer-host.txt" "$CAPDIR/" 2>/dev/null || true
cat > "$ev/diagnosis.md" <<'D'
CLASS: harness-infra
CONFIDENCE: high
ACTION-TAKEN: none
ESCALATE: no

**Root cause** — stub.
D
EOF
chmod +x "$work/capture-agent.sh"
rm -rf "$capdir"
run_heal HEAL_AGENT_CMD="bash $work/capture-agent.sh" CAPDIR="$capdir" SWARM_HOST=box9 >/dev/null 2>&1 || true
grep -q "ran on another swarm pool host" "$capdir/worker-logs.txt" 2>/dev/null \
  || fail "#377: worker-logs.txt must carry the explicit 'ran on another pool host' line when no local evidence exists (got: $(cat "$capdir/worker-logs.txt" 2>/dev/null))"
grep -q "ran on another swarm pool host" "$capdir/run-verdict.txt" 2>/dev/null \
  || fail "#377: run-verdict.txt must carry the explicit line instead of being empty/absent"
grep -q "^healer-host: box9$" "$capdir/healer-host.txt" 2>/dev/null \
  || fail "#377: the bundle must record the healer's own host (got: $(cat "$capdir/healer-host.txt" 2>/dev/null))"

# ...and a run WITH host-local worker logs (executed HERE) is UNCHANGED: no
# spurious remote line, but the healer-host stamp is still present.
rm -rf "$work/state"; mkdir -p "$work/state"
echo "boom: unmistakable error line 12345" > "$work/wd/.sandcastle/logs/x-worker.log"
rm -rf "$capdir"
run_heal HEAL_AGENT_CMD="bash $work/capture-agent.sh" CAPDIR="$capdir" SWARM_HOST=box9 >/dev/null 2>&1 || true
grep -q "ran on another swarm pool host" "$capdir/worker-logs.txt" 2>/dev/null \
  && fail "#377: a run with host-local worker logs must NOT be flagged as running on another host"
grep -q "^healer-host: box9$" "$capdir/healer-host.txt" 2>/dev/null \
  || fail "#377: the healer-host stamp must be present even on a local run"

echo "heal.sh: 19 scenarios passed"
