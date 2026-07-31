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
. "$here/heal-lib.sh"
# shellcheck source=limit-lib.sh
. "$here/limit-lib.sh"

# Secrets: env wins (the workflow provides the authoritative value);
# the bind-mounted secrets file is the fallback for host runs
# (same precedence as list-ready-tasks.sh).
[ -z "${FORGEJO_TOKEN:-}" ] && [ -f "$here/secrets/forgejo_token" ] && FORGEJO_TOKEN="$(cat "$here/secrets/forgejo_token")"
: "${FORGEJO_API:=https://git.matou.nz/api/v1/repos/Matou/matou-app}"
MODE="${HEAL_MODE:-hook}"
WORKFLOW="${WORKFLOW:-unknown}"
WORKDIR="${HEAL_WORKDIR:-$HOME/swarm/Matou/matou-app}"
HEALER_STATE="${HEALER_STATE:-$WORKDIR/.sandcastle/.state/healer}"
mkdir -p "$HEALER_STATE"
NOW="$(date +%s)"

# One healer at a time. Our OWN lock — never the swarm's.
exec 8>/tmp/matou-healer.lock
flock -n 8 || { echo "heal: another healer holds the lock — exiting"; exit 0; }

EVIDENCE="$(mktemp -d /tmp/matou-heal.XXXXXX)"
echo "heal: evidence at $EVIDENCE (mode=$MODE workflow=$WORKFLOW)"

api() { curl -sf --max-time 30 -H "Authorization: token $FORGEJO_TOKEN" "$@"; }

gather_evidence() {
  local t0=$SECONDS
  # Probe the endpoint the automation actually depends on, paged: Forgejo
  # ignores limit without page and dumps the whole task table (~30s+ at
  # 1100 tasks; docs/research/2026-07-30-forgejo-actions-tasks-api.md).
  curl -sf --max-time 35 -o /dev/null \
    -H "Authorization: token $FORGEJO_TOKEN" \
    "$FORGEJO_API/actions/tasks?limit=1&page=1" \
    && echo "api_seconds=$((SECONDS - t0))" > "$EVIDENCE/api-timing.txt" \
    || echo "api_seconds=timeout" > "$EVIDENCE/api-timing.txt"
  api "$FORGEJO_API/actions/tasks?limit=50&page=1" > "$EVIDENCE/runs.json" 2>/dev/null \
    || echo '{"workflow_runs":[]}' > "$EVIDENCE/runs.json"
  : > "$EVIDENCE/worker-logs.txt"
  local f
  for f in $(ls -t "$WORKDIR/.sandcastle/logs/"*.log 2>/dev/null | head -5); do
    { echo "===== ${f##*/} (tail)"; tail -c 20000 "$f"; echo; } >> "$EVIDENCE/worker-logs.txt"
  done
  journalctl -u forgejo-runner --since "-2 hours" --no-pager -q 2>/dev/null | tail -100 \
    > "$EVIDENCE/runner-journal.txt" || true
  {
    git -C "$WORKDIR" status --short 2>&1 | head -20
    git -C "$WORKDIR" log --oneline -5 2>&1
    ls "$WORKDIR/.git/rebase-merge" "$WORKDIR/.git/rebase-apply" 2>/dev/null || echo "no rebase in progress"
  } > "$EVIDENCE/workdir-git.txt" || true
  { df -h /; free -m; } > "$EVIDENCE/host.txt" 2>&1 || true
  if flock -n /tmp/matou-swarm.lock -c true 2>/dev/null; then
    echo free > "$EVIDENCE/swarm-lock.txt"
  else
    echo held > "$EVIDENCE/swarm-lock.txt"
  fi
}

# Newest error-ish line from the worker logs — the signature's raw material.
# ci/triage failures have no local artifact (Forgejo's log API is closed), so
# their signature degrades to the workflow name alone: distinct ci faults
# within one cooldown share an incident. Accepted limitation.
error_line() {
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
    cat "$here/heal-prompt.md"
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
  local status=0
  if [ -n "${HEAL_AGENT_CMD:-}" ]; then
    # Test seam: the stub receives the prompt as $1.
    timeout 900 ${HEAL_AGENT_CMD} "$(cat "$ctx")" > "$EVIDENCE/agent-out.log" 2>&1 || status=$?
  else
    ( cd "$WORKDIR" && timeout 900 claude -p --model claude-opus-4-8 \
        --dangerously-skip-permissions "$(cat "$ctx")" ) > "$EVIDENCE/agent-out.log" 2>&1 || status=$?
  fi
  # Shared detector (limit-lib.sh) — see the note in run-swarm.sh's guard.
  if claude_limit_hit "$EVIDENCE/agent-out.log"; then
    echo "heal: Claude usage limit — skipping quietly"; exit 0
  fi
  [ "$status" -eq 0 ] && [ -f "$EVIDENCE/diagnosis.md" ]
}

handle_incident() { # <workflow> <errline>
  local wf="$1" errline="$2" sig decision thread
  sig="$(compute_signature "$wf" "$errline")"
  decision="$(ledger_decide "$sig" "$NOW")"
  thread="$(ledger_get "$sig" thread_id)"
  echo "heal: incident wf=$wf sig=$sig decision=$decision"

  case "$decision" in
    reply-recurring)
      post ":arrows_counterclockwise: still failing (\`$sig\`, $wf) — ${RUN_URL:-watchdog}" "$thread" >/dev/null
      ledger_set "$sig" replies "$(( $(ledger_get "$sig" replies | grep -E '^[0-9]+$' || echo 0) + 1 ))"
      ;;
    escalate-noisy)
      # The reply cap is spent: say it once, with the operator action spelled
      # out, then go quiet for the rest of the cooldown. Silence here is the
      # point — the incident is already on the thread above.
      post "@ben :rotating_light: **$wf has failed ${HEAL_MAX_REPLIES}+ times with the same fault** (\`$sig\`) — the healer is going quiet on it until the cooldown expires or the fault changes. ${RUN_URL:-} · evidence: \`$EVIDENCE\` on matou-workstation" "$thread" >/dev/null
      ledger_set "$sig" escalated 1
      ;;
    silent)
      echo "heal: $sig already escalated and silenced — posting nothing"
      ;;
    escalate-repaired)
      post "@ben :rotating_light: **$wf recurred after a repair attempt** (\`$sig\`) — the healer will not retry. ${RUN_URL:-} · evidence: \`$EVIDENCE\` on matou-workstation" "$thread" >/dev/null
      ;;
    investigate|investigate-stale)
      local pid
      if run_agent "$sig" "$wf" "$errline"; then
        local head_lines act
        head_lines="$(head -c 3500 "$EVIDENCE/diagnosis.md")"
        act="$(sed -n 's/^ACTION-TAKEN: *//p' "$EVIDENCE/diagnosis.md" | head -1)"
        local esc; esc="$(sed -n 's/^ESCALATE: *//p' "$EVIDENCE/diagnosis.md" | head -1)"
        local ping=""; [ "$esc" = "yes" ] && ping="@ben "
        pid="$(post "${ping}:stethoscope: **Healer — $wf** (\`$sig\`) ${RUN_URL:-}
$head_lines" "$thread")"
        [ -z "$thread" ] && [ -n "$pid" ] && ledger_set "$sig" thread_id "$pid"
        if [ -n "$act" ] && [ "$act" != "none" ] && [ -z "${HEAL_DRY_RUN:-}" ]; then
          ledger_set "$sig" repaired 1
        else
          ledger_set "$sig" repaired "$(ledger_get "$sig" repaired)"
          [ -z "$(ledger_get "$sig" repaired)" ] && ledger_set "$sig" repaired 0
        fi
      else
        pid="$(post "@ben :rotating_light: **$wf failed and the healer could not produce a diagnosis** — ${RUN_URL:-watchdog} · agent log + evidence: \`$EVIDENCE\` on matou-workstation" "$thread")"
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

if [ "$MODE" = "hook" ]; then
  handle_incident "$WORKFLOW" "$(error_line)"
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
    handle_incident "$wf" "watchdog: $kind ($(error_line))"
    found=1
  done < <(watchdog_detect "$EVIDENCE/runs.json")
  if [ "$found" -eq 0 ]; then echo "heal: watchdog — all healthy"; fi
fi
