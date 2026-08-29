#!/usr/bin/env bash
# The swarm healer — deterministic orchestrator around one headless
# investigation (design: docs/superpowers/specs/2026-07-27-self-healing-swarm-design.md).
#
# Modes (HEAL_MODE): hook (default; a workflow's failure step calls us with
# WORKFLOW + RUN_URL) | watchdog (hourly healer.yml sweep).
# HEAL_DRY_RUN=1 → diagnose-only: the agent is told to change nothing and
# every post is prefixed [dry-run].
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HEAL_PROMPT_FILE="${HEAL_PROMPT_FILE:-$here/heal-prompt.md}"
. "$here/heal-lib.sh"
# shellcheck source=limit-lib.sh
. "$here/limit-lib.sh"
# shellcheck source=model-lib.sh
# The shared model config (#448): swarm.config is the ONE place naming what this
# healer runs on — no hardcoded id can drift from it. Since 2026-08-25 the healer
# rides its own SWARM_HEAL_MODEL (diagnosis quality beats cost), no longer the
# fleet's SWARM_MODEL the worker (main.mts) launches tickets on.
. "$here/model-lib.sh"
# shellcheck source=host-capacity-lib.sh
# The drive reservation predicate (#663/#664/#30): a waiting rehearsal drive
# declares it wants the host's heavy capacity; the healer's investigation is a
# heavy (claude-calling) consumer and stands down before taking a slot. Consumed
# by the drive-yield gate below.
. "$here/host-capacity-lib.sh"
# shellcheck source=swarm-db-lib.sh
# swarm.db trace mirror (#447/#92): the investigation is a claude call — a pooled
# heavy slot up to 15 min — that used to leave NO runs/processes/events rows, so
# heal time was invisible to the machine timeline and the util bar. run_agent
# opens a `heal`-trigger run + a claude process row and a `heal` event pointing
# at the evidence dir; the EXIT trap finalises them. Best-effort by construction
# (every writer swallows its exit), so a missing engine never reds a heal run.
. "$here/swarm-db-lib.sh"

# Secrets: env wins (the workflow provides the authoritative value);
# the bind-mounted secrets file is the fallback for host runs
# (same precedence as list-ready-tasks.sh).
[ -z "${FORGEJO_TOKEN:-}" ] && [ -f "$here/secrets/forgejo_token" ] && FORGEJO_TOKEN="$(cat "$here/secrets/forgejo_token")"
# shellcheck source=identity-lib.sh
. "$here/identity-lib.sh"     # identity_require — the contract seam (#31)
# shellcheck source=swarm-identity.sh
. "${SWARM_IDENTITY_FILE:-$here/swarm-identity.sh}"
# Identity contract seam (#31): the harness calls swarm_git_identity, defined in
# the consumer-owned (vendor-excluded) swarm-identity.sh. Fail LOUD with the
# regenerate command if a pin bump needs a newer identity layer than this
# consumer regenerated, instead of dying later on `command not found`.
identity_require || exit 2
# One runner serves TWO repos now (#238). Per-repo healer state must carry the
# repo slug or one repo's healer makes the other's skip its incident (the
# healer lock) and stomps its evidence dir. "Matou/idss" -> "Matou-idss"
# (slashes aren't valid in a path segment).
REPO_TAG="${FORGEJO_API##*/repos/}"; REPO_TAG="${REPO_TAG//\//-}"
MODE="${HEAL_MODE:-hook}"
WORKFLOW="${WORKFLOW:-unknown}"
# Which host the evidence dir SITS on, for the human reading the ping (#79 —
# it used to be one product's workstation, spelled out in this vendored file:
# every 2026-08-24 ping named that box while the healer was running on ANOTHER
# member of the pool, so every evidence path pointed at a directory that does
# not exist there). Unlike its rehearsal-report.sh sibling (#51) the probe
# comes BEFORE the identity layer's RUNNER_HOST here: heal.sh runs on the bare
# host, so `hostname` IS ground truth, while RUNNER_HOST declares the ONE host a
# repo nominates — exactly the value that misdirected those pings. SWARM_HOST
# (the pool-claim name) still wins when set, so the evidence line and the
# claim/commit identity agree.
HEAL_EVIDENCE_HOST="${HEAL_EVIDENCE_HOST:-${SWARM_HOST:-$(hostname 2>/dev/null || echo "the healer host")}}"
WORKDIR="$HEAL_WORKDIR"
HEALER_STATE="${HEALER_STATE:-$WORKDIR/.sandcastle/.state/healer}"
mkdir -p "$HEALER_STATE"
NOW="$(date +%s)"
# Where each failing workflow drops its on-failure verdict (failing stage + first
# error lines). The runner is host-mode on the workstation and ci has no readable
# log API, so a well-known host path is how a run's real fault reaches the healer:
# `ci` via scripts/seam-smoke.sh (#197), `swarm`/`triage` via verdict-lib.sh
# (#235), `smoke-drive` via the consumer's smoke driver (#10 — the reader half
# of matou-app#46; without it a red smoke lap degraded to stale worker prose).
# Same repo-tagged defaults those scripts write to (#574) — REPO_TAG is
# already computed above from FORGEJO_API, same formula seam-smoke.sh derives
# from `git remote get-url origin` and run-swarm.sh/run-triage.sh derive from
# REPO_SLUG, so reader and writers always agree on the path.
SEAM_VERDICT="${SEAM_VERDICT_PATH:-/tmp/matou-$REPO_TAG-seam-verdict.txt}"
SWARM_VERDICT="${SWARM_VERDICT_PATH:-/tmp/matou-$REPO_TAG-swarm-verdict.txt}"
TRIAGE_VERDICT="${TRIAGE_VERDICT_PATH:-/tmp/matou-$REPO_TAG-triage-verdict.txt}"
SMOKE_DRIVE_VERDICT="${SMOKE_DRIVE_VERDICT_PATH:-/tmp/matou-$REPO_TAG-smoke-drive-verdict.txt}"

# How fresh a verdict or worker log must be to count as evidence for THIS
# incident's run. Older artifacts (the stale 03:38 worker log that minted phantom
# #235 signatures) are context only, never the signature. Used as the relative
# `find -newermt "-$RUN_WINDOW"` cutoff — same "-N hours" form as the watchdog.
RUN_WINDOW="${HEAL_RUN_WINDOW:-2 hours}"

# verdict_path <workflow> — the on-failure verdict artifact for a workflow, empty
# for workflows that don't write one (the caller then keeps the legacy prose grep).
verdict_path() {
  case "$1" in
    ci)     printf '%s' "$SEAM_VERDICT" ;;
    swarm)  printf '%s' "$SWARM_VERDICT" ;;
    triage) printf '%s' "$TRIAGE_VERDICT" ;;
    smoke-drive) printf '%s' "$SMOKE_DRIVE_VERDICT" ;;
  esac
}

# verdict_is_fresh <file> — true iff it exists and was written within the run
# window. A verdict left by an earlier failed run (the workflow died before it
# could rewrite one) must NOT be trusted as this incident's fault (#235 AC2).
verdict_is_fresh() {
  [ -f "$1" ] && [ -n "$(find "$1" -newermt "-$RUN_WINDOW" 2>/dev/null)" ]
}

# One healer at a time PER REPO. Our OWN lock — never the swarm's — and
# per-repo (#238) so idss's healer never blocks matou-app's incident.
HEALER_LOCK="${HEALER_LOCK:-/tmp/matou-healer-$REPO_TAG.lock}"
exec 8>"$HEALER_LOCK"
flock -n 8 || { echo "heal: another healer holds the lock — exiting"; exit 0; }

# Yield to a ready rehearsal drive (#663 producer / #664 consumer / #30): a
# waiting drive needs EVERY host lock at once and loses to anything that takes a
# slot in the gap. The healer's investigation runs a claude call — a slot — so it
# stands down HERE, before gathering evidence or spending a ledger attempt, the
# same posture session-runner/swarm/triage take (yield, never camp). An abandoned
# reservation ages out (the TTL), and a genuine incident is re-detected by the
# next watchdog sweep once the drive clears — deferring costs nothing lasting. The
# healer's consecutive-defer count is its OWN (its own cadence, so a shared
# counter would conflate streaks — #664); the yield line carries the reservation's
# age so it and the executor's "skipped N ticks" line corroborate.
HEALER_DRIVE_DEFER_COUNT="${HEALER_DRIVE_DEFER_COUNT:-/tmp/matou-healer-drive-defer-count}"
if host_capacity_drive_wanted; then
  defer_n="$(host_capacity_consumer_defer_bump "$HEALER_DRIVE_DEFER_COUNT")"
  echo "heal: a rehearsal drive has reserved host capacity (#663) — yielding this run to a ready drive — reservation age $(host_capacity_drive_wanted_age)s — skipped $defer_n consecutive tick(s)"
  exit 0
fi
host_capacity_consumer_defer_reset "$HEALER_DRIVE_DEFER_COUNT"

# Per-repo evidence dir (#238): a repo-agnostic prefix left the two repos'
# incidents indistinguishable on disk.
EVIDENCE="$(mktemp -d "/tmp/matou-heal-$REPO_TAG.XXXXXX")"
echo "heal: evidence at $EVIDENCE (mode=$MODE workflow=$WORKFLOW)"

# swarm.db trace (#92): run_agent opens these when it actually invokes claude;
# the EXIT trap below finalises them on EVERY exit path (a clean return, a
# no-diagnosis, or the limit-park `exit 0` mid-diagnosis) with the
# investigation's real outcome as the run verdict — the SAME kills-finalise
# discipline session-runner/run-swarm use (swarm-db.py invariant 2). A heal that
# never reaches claude (drive-yield, limit gate, lock, a downgraded kill, or a
# dedup silence) opens NOTHING — heal_run_db_id stays empty and the trap is a
# no-op, so there is no per-non-investigation-tick noise. An untrappable
# SIGKILL/OOM cannot run the trap: its open process row is the wedge marker by
# design, exactly as everywhere else in the mirror.
heal_run_db_id=""
heal_run_verdict=""
heal_on_exit() {
  local ec=$?
  [ -n "$heal_run_db_id" ] || return 0
  local now; now="$(date +%s)"
  swarmdb proc-close --run "$heal_run_db_id" --ref "$$" --ended "$now"
  swarmdb_run_end "$heal_run_db_id" "${heal_run_verdict:-died-in:heal}" \
    "${heal_run_verdict:-died-in:heal}" "$ec" "$now"
}
trap heal_on_exit EXIT

api() { curl -sf --max-time 30 -H "Authorization: token $FORGEJO_TOKEN" "$@"; }

gather_evidence() {
  local t0=$SECONDS
  # Probe the endpoint the automation actually depends on, paged: Forgejo
  # ignores limit without page and dumps the whole task table (~30s+ at
  # 1100 tasks). This is the endpoint on purpose — its sibling
  # `/actions/runs` scales with the repo's whole run history and stopped
  # answering inside 60 s on the big repos (GOTCHAS 16; the pointer this
  # comment used to carry named a research doc that did not come across in
  # the ADR 0180 extraction).
  curl -sf --max-time 35 -o /dev/null \
    -H "Authorization: token $FORGEJO_TOKEN" \
    "$FORGEJO_API/actions/tasks?limit=1&page=1" \
    && echo "api_seconds=$((SECONDS - t0))" > "$EVIDENCE/api-timing.txt" \
    || echo "api_seconds=timeout" > "$EVIDENCE/api-timing.txt"
  api "$FORGEJO_API/actions/tasks?limit=50&page=1" > "$EVIDENCE/runs.json" 2>/dev/null \
    || echo '{"workflow_runs":[]}' > "$EVIDENCE/runs.json"
  # Scope worker logs to the triggering run (#235 AC2): only logs written within
  # the run window are evidence for THIS incident and feed the degrade-path grep.
  # Older worker chain-of-thought — the stale log that narrated an already-closed
  # ticket and minted phantom signatures — is kept only as a small, clearly
  # labelled tail of context, never mistaken for the current fault.
  : > "$EVIDENCE/worker-logs.txt"
  : > "$EVIDENCE/worker-logs-older.txt"
  local f nfresh=0 nolder=0
  for f in $(ls -t "$WORKDIR/.sandcastle/logs/"*.log 2>/dev/null); do
    if [ -n "$(find "$f" -newermt "-$RUN_WINDOW" 2>/dev/null)" ]; then
      [ "$nfresh" -lt 5 ] || continue
      { echo "===== ${f##*/} (tail, current run window)"; tail -c 20000 "$f"; echo; } >> "$EVIDENCE/worker-logs.txt"
      nfresh=$((nfresh + 1))
    else
      [ "$nolder" -lt 2 ] || continue
      { echo "===== ${f##*/} (tail, OLDER than the run window — context only, NOT the signature)"; tail -c 4000 "$f"; echo; } >> "$EVIDENCE/worker-logs-older.txt"
      nolder=$((nolder + 1))
    fi
  done
  journalctl -u forgejo-runner --since "-2 hours" --no-pager -q 2>/dev/null | tail -100 \
    > "$EVIDENCE/runner-journal.txt" || true
  {
    git -C "$WORKDIR" status --short 2>&1 | head -20
    git -C "$WORKDIR" log --oneline -5 2>&1
    ls "$WORKDIR/.git/rebase-merge" "$WORKDIR/.git/rebase-apply" 2>/dev/null || echo "no rebase in progress"
  } > "$EVIDENCE/workdir-git.txt" || true
  { df -h /; free -m; } > "$EVIDENCE/host.txt" 2>&1 || true
  # The triggering workflow's own verdict artifact (ci/swarm/triage), if the run
  # left a fresh one — so the diagnosis agent sees the same stage/fault the
  # signature keyed on. Copied only when fresh; a stale file is not this run's.
  local vf; vf="$(verdict_path "$WORKFLOW")"
  [ -n "$vf" ] && verdict_is_fresh "$vf" && cp "$vf" "$EVIDENCE/run-verdict.txt" 2>/dev/null || true
  # GLOBAL by design (#238): the swarm lock serializes one heavy worker per
  # host across both repos, so the healer probes the same shared lock.
  if flock -n /tmp/matou-swarm.lock -c true 2>/dev/null; then
    echo free > "$EVIDENCE/swarm-lock.txt"
  else
    echo held > "$EVIDENCE/swarm-lock.txt"
  fi
}

# The signature's raw material.
#
# For every workflow that drops a verdict artifact — `ci` (#197), `swarm` and
# `triage` (#235), `smoke-drive` (#10) — key the signature on the run's OWN
# failing stage + first error line, so the incident signature tracks the
# ACTUAL fault. A moved fault → a new signature → a fresh investigation,
# instead of collapsing every failure within the cooldown onto one degraded
# workflow-name-only signature (a moved fault masked as "still failing").
# Crucially, swarm/triage no longer grep the Sandcastle worker chain-of-thought
# (saturated with "error"/"failed" prose), so a stale worker log narrating an
# unrelated, already-closed ticket can no longer mint a phantom signature (the
# 2026-07-31 false positives this ticket fixes).
#
# With no fresh verdict, degrade to the workflow name alone (empty line) but
# leave a marker so every post says the "still failing" line is unverified (AC1).
#
# For any other workflow (e.g. a watchdog-detected name with no runner verdict):
# unchanged — the newest error-ish worker-log line, now already scoped to the
# run window by gather_evidence.
error_line() { # <workflow>
  local wf="${1:-$WORKFLOW}" vf sv bc bstage
  vf="$(verdict_path "$wf")"
  if [ -n "$vf" ]; then
    if verdict_is_fresh "$vf"; then
      sv="$(seam_verdict_signal "$vf")"
      if [ -n "$sv" ]; then printf '%s' "$sv"; return; fi
    fi
    # No fresh verdict, but a fresh breadcrumb (#34): the run reached a stage and
    # was then SIGKILL'd (probable OOM) BEFORE its EXIT trap could write a verdict
    # — a resource kill, not a code/harness fault. verdict_write erases the
    # breadcrumb on every trapped exit, so its survival next to an absent verdict
    # is unambiguous. Key the signature on the killed STAGE (never the bare
    # workflow name — that phantom `sha1("triage|")` incident is exactly what this
    # fixes) and flag it so handle_incident downgrades instead of investigating.
    bc="${vf}.breadcrumb"
    if verdict_is_fresh "$bc"; then
      bstage="$(sed -n 's/^stage=//p' "$bc" | head -1)"
      : > "$EVIDENCE/seam-killed"
      printf 'killed mid-stage :: %s' "${bstage:-unknown}"
      return 0
    fi
    : > "$EVIDENCE/seam-degraded"   # marker read by handle_incident's posts
    return 0
  fi
  grep -hE "error|Error|ERR|failed|Failed|timed out|fatal" "$EVIDENCE/worker-logs.txt" 2>/dev/null | tail -1 || true
}

post() { # post <msg> [thread_root] → echoes post id (empty when chat unset)
  local msg="$1" root="${2:-}"
  [ -n "${HEAL_DRY_RUN:-}" ] && msg="[dry-run] $msg"
  bash "$here/notify-mattermost.sh" "$msg" "$root" || true
}

run_agent() { # <sig> <workflow> <errline> — 0 iff diagnosis.md was produced
  local sig="$1" wf="$2" errline="$3" ctx="$EVIDENCE/prompt.txt"
  {
    cat "$HEAL_PROMPT_FILE"
    echo; echo "## This incident"
    echo "- Mode: $MODE"
    echo "- Workflow: $wf"
    echo "- Run: ${RUN_URL:-n/a}"
    echo "- Signature: $sig"
    echo "- Trigger error line: ${errline:-unknown}"
    echo "- Swarm workdir: $WORKDIR"
    echo "- Evidence directory: $EVIDENCE (read every file)"
    echo "- Write your report to: $EVIDENCE/diagnosis.md"
    [ -n "${HEAL_DRY_RUN:-}" ] && echo "- DRY RUN: diagnose only. Make NO commits, NO pushes, file NO tickets."
  } > "$ctx"
  rm -f "$EVIDENCE/diagnosis.md"
  local status=0 heal_attempt=1
  # Stamp the factory git identity (#19) so the /tmp/heal-fix clone's commits
  # carry "…(healer@<host>)", never the host user's ~/.gitconfig. Belt to the
  # identity_require seam's braces (#31).
  command -v swarm_git_identity >/dev/null || {
    echo "identity: swarm_git_identity missing from swarm-identity.sh — re-run: onboard.sh identity ${REPO_SLUG:-<owner/repo>} .sandcastle/swarm-identity.sh" >&2
    exit 2
  }
  swarm_git_identity healer
  claude_select_token
  # swarm.db trace (#92): THIS is the choke point where the investigation
  # actually invokes claude. Open one run row (trigger `heal`, repo-scoped so the
  # fleet monitor's per-repo reads attribute it), one claude process row (ref the
  # pid — ended_at NULL = believed alive), and one `heal` event pointing at the
  # evidence dir. The verdict is EARNED below and finalised by the EXIT trap.
  heal_run_db_id="heal-$REPO_TAG-$(date +%s)-$$"
  local heal_started; heal_started="$(date +%s)"
  swarmdb_run_start "$heal_run_db_id" "${REPO_SLUG:-$REPO_TAG}" heal "$heal_started"
  swarmdb proc-open --run "$heal_run_db_id" --kind claude --ref "$$" \
    --command "heal $wf ($sig)" --started "$heal_started"
  swarmdb_event "$heal_run_db_id" "" heal "investigating $wf ($sig)" "$EVIDENCE"
  while :; do
    status=0
    if [ -n "${HEAL_AGENT_CMD:-}" ]; then
      # Test seam: the stub receives the prompt as $1.
      timeout 900 ${HEAL_AGENT_CMD} "$(cat "$ctx")" > "$EVIDENCE/agent-out.log" 2>&1 || status=$?
    else
      ( cd "$WORKDIR" && timeout 900 claude -p --model "$SWARM_HEAL_MODEL" \
          --dangerously-skip-permissions "$(cat "$ctx")" ) > "$EVIDENCE/agent-out.log" 2>&1 || status=$?
    fi
    # Shared detector (limit-lib.sh) — see the note in run-swarm.sh's guard. Mid-
    # diagnosis the claude call can itself hit the limit (the 0-byte agent-out.log
    # of the 2026-08-01 incident). First try the standby account (#510) — the
    # SAME limit-lib predicate decided both the hit and the flip, no second grep
    # anywhere. Only when both windows are exhausted (or no standby exists):
    # PARK the host so every other caller yields on the same window (#253),
    # record the deferral, and exit 0 BEFORE the ledger attempt below is
    # consumed — a limit refusal is not a spent diagnosis.
    if claude_limit_hit "$EVIDENCE/agent-out.log"; then
      if [ "$heal_attempt" = 1 ] && claude_failover; then
        heal_attempt=2
        echo "heal: Claude account limited — failed over to account $(claude_active_account); retrying the diagnosis once"
        continue
      fi
      claude_limit_park
      echo "deferred: limit window (claude refused mid-diagnosis)" > "$EVIDENCE/deferred-limit.txt"
      echo "heal: deferred — Claude usage limit mid-diagnosis; parked the host, no ledger attempt consumed"
      heal_run_verdict="limit-parked"   # the EXIT trap finalises the run/process rows
      exit 0
    fi
    break
  done
  # Earn the run verdict from the investigation's real outcome (#92): a produced
  # diagnosis is `diagnosed`, anything else `no-diagnosis`. The EXIT trap stamps
  # whichever we set here onto the run row and closes the process row.
  if [ "$status" -eq 0 ] && [ -f "$EVIDENCE/diagnosis.md" ]; then
    heal_run_verdict="diagnosed"
    return 0
  fi
  heal_run_verdict="no-diagnosis"
  return 1
}

handle_incident() { # <workflow> <errline>
  local wf="$1" errline="$2" sig decision thread degraded=""
  sig="$(compute_signature "$wf" "$errline")"
  decision="$(ledger_decide "$sig" "$NOW")"
  thread="$(ledger_get "$sig" thread_id)"
  echo "heal: incident wf=$wf sig=$sig decision=$decision"
  # No readable seam evidence (error_line left the marker): the ci signature
  # degraded to the workflow name alone. Be honest about it on every post (AC3).
  [ -f "$EVIDENCE/seam-degraded" ] && degraded=$'\n:warning: signature degraded to workflow name (no fresh run verdict) — the recurrence status is unverified'

  case "$decision" in
    reply-recurring)
      # A fault whose diagnosis only FILED a ticket recurs until the fix lands,
      # so say so on the thread rather than repeating a bare "still failing"
      # that reads like new information (#79).
      local ticketed tnote=""
      ticketed="$(ledger_get "$sig" ticketed | grep -E '^[0-9]+$' || echo 0)"
      [ "${ticketed:-0}" -ge 1 ] && tnote=" · a ticket is already filed for this fault — recurrence expected until the fix lands"
      post ":arrows_counterclockwise: still failing (\`$sig\`, $wf) — ${RUN_URL:-watchdog}${tnote}${degraded}" "$thread" >/dev/null
      ledger_set "$sig" replies "$(( $(ledger_get "$sig" replies | grep -E '^[0-9]+$' || echo 0) + 1 ))"
      ;;
    escalate-noisy)
      # The reply cap is spent: say it once, with the operator action spelled
      # out, then go quiet for the rest of the cooldown. Silence here is the
      # point — the incident is already on the thread above.
      post "@ben :rotating_light: **$wf has failed ${HEAL_MAX_REPLIES}+ times with the same fault** (\`$sig\`) — the healer is going quiet on it until the cooldown expires or the fault changes. ${RUN_URL:-} · evidence: \`$EVIDENCE\` on $HEAL_EVIDENCE_HOST" "$thread" >/dev/null
      ledger_set "$sig" escalated 1
      ;;
    silent)
      echo "heal: $sig already escalated and silenced — posting nothing"
      ;;
    escalate-repaired)
      # Say it ONCE, then latch — exactly the brake escalate-noisy has always
      # had (#79). This branch used to set nothing, and `repaired=1` wins ahead
      # of the reply cap in ledger_decide, so every recurrence inside the
      # cooldown re-pinged @ben and refreshed last_seen: on 2026-08-24 that was
      # one ping per red run, a run every ~2 minutes, for a fault already
      # ticketed as a known product bug. The fault stays visible in the run
      # history and on the thread; only the PING is once per window.
      post "@ben :rotating_light: **$wf recurred after a repair attempt** (\`$sig\`) — the healer will not retry, and is going quiet on it until the cooldown expires or the fault changes. ${RUN_URL:-} · evidence: \`$EVIDENCE\` on $HEAL_EVIDENCE_HOST" "$thread" >/dev/null
      ledger_set "$sig" escalated 1
      ;;
    investigate|investigate-stale)
      local pid
      # A new cooldown window is a NEW incident: clear the previous window's
      # ladder state so both brakes start fresh (#79). Without this the latch
      # the escalate branches set would outlive its window — a signature that
      # escalated once would re-investigate on staleness and then go straight
      # to `silent` for every recurrence after it, i.e. once ever, not once
      # per window.
      if [ "$decision" = "investigate-stale" ]; then
        ledger_set "$sig" replies 0
        ledger_set "$sig" escalated 0
      fi
      if [ -f "$EVIDENCE/seam-killed" ]; then
        # Downgrade (#34): the run was SIGKILL'd mid-stage (probable OOM) and left
        # a breadcrumb but no verdict — its heavy work had typically already
        # succeeded (the triage claude call in the ticket completed, then the
        # wrapper was killed ~4 s later). This is a host-capacity event, not a
        # fault: do NOT spend an (expensive) investigation. Post a low-severity,
        # un-pinged note; the dedup ladder still owns recurrence, so a host that
        # keeps OOM-killing jobs escalates to @ben on its own via the reply cap.
        pid="$(post ":zzz: **$wf was killed mid-stage — probable resource kill / OOM, not a fault** (\`$sig\`) — no run verdict was written (a SIGKILL cannot run the EXIT trap; the last running stage was recovered from the breadcrumb). Not investigating. ${RUN_URL:-watchdog} · evidence: \`$EVIDENCE\` on $HEAL_EVIDENCE_HOST" "$thread")"
        [ -z "$thread" ] && [ -n "$pid" ] && ledger_set "$sig" thread_id "$pid"
        [ -z "$(ledger_get "$sig" repaired)" ] && ledger_set "$sig" repaired 0
      elif run_agent "$sig" "$wf" "$errline"; then
        local head_lines act
        head_lines="$(head -c 3500 "$EVIDENCE/diagnosis.md")"
        act="$(sed -n 's/^ACTION-TAKEN: *//p' "$EVIDENCE/diagnosis.md" | head -1)"
        local esc; esc="$(sed -n 's/^ESCALATE: *//p' "$EVIDENCE/diagnosis.md" | head -1)"
        local ping=""; [ "$esc" = "yes" ] && ping="@ben "
        pid="$(post "${ping}:stethoscope: **Healer — $wf** (\`$sig\`) ${RUN_URL:-}${degraded}
$head_lines" "$thread")"
        [ -z "$thread" ] && [ -n "$pid" ] && ledger_set "$sig" thread_id "$pid"
        if [ -n "$act" ] && [ "$act" != "none" ] && [ -z "${HEAL_DRY_RUN:-}" ]; then
          if action_is_ticket_only "$act"; then
            # Filing a ticket is the right action for a product-class fault —
            # and it is NOT a repair (#79): nothing on the host or in the repo
            # changed, so the fault recurs until the fix lands and each
            # recurrence carries no new information. Record it as `ticketed`
            # and leave the signature on the reply-cap ladder (three replies,
            # ONE escalation, then quiet). Marking it `repaired` instead is
            # what routed the 2026-08-24 recurrences onto the repair
            # loop-breaker, whose latch this ticket also fixes.
            ledger_set "$sig" ticketed "$(( $(ledger_get "$sig" ticketed | grep -E '^[0-9]+$' || echo 0) + 1 ))"
            [ -z "$(ledger_get "$sig" repaired)" ] && ledger_set "$sig" repaired 0
          else
            ledger_set "$sig" repaired 1
          fi
        else
          ledger_set "$sig" repaired "$(ledger_get "$sig" repaired)"
          [ -z "$(ledger_get "$sig" repaired)" ] && ledger_set "$sig" repaired 0
        fi
      else
        pid="$(post "@ben :rotating_light: **$wf failed and the healer could not produce a diagnosis** — ${RUN_URL:-watchdog} · agent log + evidence: \`$EVIDENCE\` on $HEAL_EVIDENCE_HOST" "$thread")"
        [ -z "$thread" ] && [ -n "$pid" ] && ledger_set "$sig" thread_id "$pid"
        [ -z "$(ledger_get "$sig" repaired)" ] && ledger_set "$sig" repaired 0
      fi
      ledger_set "$sig" workflow "$wf"
      [ -z "$(ledger_get "$sig" first_seen)" ] && ledger_set "$sig" first_seen "$NOW"
      ledger_set "$sig" attempts "$(( $(ledger_get "$sig" attempts | grep -E '^[0-9]+$' || echo 0) + 1 ))"
      ;;
  esac
  ledger_set "$sig" last_seen "$NOW"
}

gather_evidence

# Limit gate, BEFORE any claude call (#253): if the host-global marker says the
# Claude subscription window is exhausted, the healer's own claude call would
# just refuse — it goes BLIND exactly when it can't help, and a limit-caused red
# is almost never a real incident. Defer the whole incident: record it in the
# evidence dir and exit 0 WITHOUT consuming a ledger attempt (the ledger is only
# touched further down, past this gate).
if claude_limit_parked; then
  echo "deferred: limit window ($(date -u '+%Y-%m-%dT%H:%M:%SZ') — global marker fresh)" > "$EVIDENCE/deferred-limit.txt"
  echo "heal: deferred — Claude usage limit window (marker fresh); no ledger attempt consumed"
  exit 0
fi

if [ "$MODE" = "hook" ]; then
  handle_incident "$WORKFLOW" "$(error_line "$WORKFLOW")"
else
  found=0
  # (c) API latency incident
  api_s="$(sed -n 's/^api_seconds=//p' "$EVIDENCE/api-timing.txt")"
  if [ "$api_s" = "timeout" ] || { [ "$api_s" -ge 30 ] 2>/dev/null; }; then
    handle_incident "forgejo-api" "API version probe ${api_s}s (threshold 30s)"
    found=1
  fi
  # (a)+(b) failure streaks / always-red — skip workflows whose ledger was
  # touched within the cooldown (a hook already owns the incident)
  while IFS=$'\t' read -r wf kind; do
    [ -z "$wf" ] && continue
    recent="$(find "$HEALER_STATE" -maxdepth 1 -type f -newermt "-6 hours" \
      -exec grep -l "^workflow=$wf$" {} + 2>/dev/null | head -1 || true)"
    [ -n "$recent" ] && { echo "heal: $wf already ledgered recently — skipping"; continue; }
    handle_incident "$wf" "watchdog: $kind ($(error_line "$wf"))"
    found=1
  done < <(watchdog_detect "$EVIDENCE/runs.json")
  if [ "$found" -eq 0 ]; then echo "heal: watchdog — all healthy"; fi
fi
