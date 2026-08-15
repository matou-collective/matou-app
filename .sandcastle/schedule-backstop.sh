#!/usr/bin/env bash
# Dispatch a workflow when Forgejo's own scheduler hasn't.
#
# Why this exists: on 2026-07-28 the repo's registered schedules silently
# stopped firing — healer's hourly watchdog last ran 06:01Z, triage's :05/:35
# last ran 05:35Z — with no config change and a healthy runner. Forgejo's
# instance-level `start_schedule_tasks` cron is demonstrably alive (14.5k
# executions, firing every 2 minutes), so the fault is that THIS repo's
# schedule rows are gone; pushing the workflow files back to the default
# branch, which is what normally re-registers them, did not bring them back.
# With the watchdog dead nothing noticed the 2026-07-29 limit storm for 92
# minutes, so the cadence can't be left depending on that mechanism.
#
# Deliberately a BACKSTOP, not a replacement: it dispatches only when the
# workflow has not run inside its own window, so if Forgejo's schedules ever
# come back this script quietly does nothing rather than double-firing.
#
# Waiting-aware (#238 AC3): on the capacity-1 runner that serves TWO repos, a
# started run blocks the host for its whole lifetime and every dispatch after it
# sits `status=waiting` for hours. Counting only STARTED runs (the pre-#238
# behaviour) meant each tick re-dispatched a workflow whose earlier dispatch was
# still queued — duplicates piled up 2x per workflow within 20 minutes. So we
# treat an in-flight run — `waiting` (queued, not yet started) OR `running` —
# as "already covered" and skip, not just a run STARTED within the window. That
# guard first lived as a stopgap in the host's backstop-tick.sh wrapper; this is
# its upstream home (the wrapper stopgap can be removed once this is installed).
#
# This file is CANONICAL in Matou/matou-app and synced to Matou/matou-app by
# .sandcastle/sync-harness.sh (the ONE transform: the repo-slug substitution on
# the FORGEJO_API default below); edit it here, never in the copy (#250).
#
# Usage: schedule-backstop.sh <workflow-file> <window-minutes>
#   e.g. schedule-backstop.sh swarm.yml 25
# Install: see the crontab block in .sandcastle/README.md.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
wf="${1:?workflow file, e.g. swarm.yml}"
window_min="${2:?window in minutes}"

: "${FORGEJO_API:=https://git.matou.nz/api/v1/repos/Matou/matou-app}"
if [ -z "${FORGEJO_TOKEN:-}" ] && [ -f "$here/secrets/forgejo_token" ]; then
  FORGEJO_TOKEN="$(cat "$here/secrets/forgejo_token")"
fi
: "${FORGEJO_TOKEN:?no token: set FORGEJO_TOKEN or populate .sandcastle/secrets/forgejo_token}"

api() { curl -sf --max-time 30 -H "Authorization: token $FORGEJO_TOKEN" "$@"; }

# The workflow's job name as it appears in the runs list ("healer" runs a job
# called "watchdog"), since that listing reports job names, not file names.
name="${wf%.yml}"
[ "$name" = "healer" ] && name="watchdog"

cutoff="$(date -u -d "-${window_min} minutes" +%Y-%m-%dT%H:%M:%SZ)"
# page=1 is load-bearing: Forgejo ignores limit without page and dumps the
# whole task table (~30s+, times out). Fail CLOSED on API trouble — we cannot
# tell "scheduler dead" from "API degraded", and dispatching blind piles runs
# onto an already-struggling instance.
if ! runs="$(api "$FORGEJO_API/actions/tasks?limit=50&page=1")"; then
  echo "backstop: runs listing unavailable — cannot tell if $name ran; skipping this tick" >&2
  exit 0
fi

# Count this workflow's runs that make a dispatch redundant: one still in flight
# (`waiting` = queued behind the busy host, or `running`), OR one that STARTED
# within the window (Forgejo's own scheduler is doing its job). The in-flight
# clause is #238 AC3 — without it a queued dispatch is re-dispatched every tick.
# Name match is `$name` OR `$name (N)` (#588, same drift as #541's
# claim_alive_runs): swarm.yml's 2-wide worker matrix (44fe333) makes Forgejo
# name each matrix job "swarm (1)"/"swarm (2)", never bare "swarm" — an
# exact-match filter never sees a real swarm run as in-flight and can pile on
# redundant dispatches while matrix workers are already running.
inflight="$(printf '%s' "$runs" | jq -r --arg n "$name" --arg c "$cutoff" \
  '[.workflow_runs[]?
     | select(.name == $n or (.name | test("^" + $n + " \\(")))
     | select((.status == "waiting") or (.status == "running") or ((.run_started_at // "") >= $c))
   ] | length')"

if [ "${inflight:-0}" -gt 0 ]; then
  echo "backstop: $name already in flight (waiting/running) or ran within the last ${window_min}m — not piling on, skipping"
  exit 0
fi

echo "backstop: no $name run since $cutoff and none waiting/running — dispatching"
api -X POST -H "Content-Type: application/json" -d '{"ref":"main"}' \
  "$FORGEJO_API/actions/workflows/$wf/dispatches" >/dev/null
echo "backstop: dispatched $wf"
