#!/usr/bin/env bash
# pr-e2e-sweep.sh — #278, Ben's ruling (shape 2 + shape 3): a self-healing
# dispatcher for feature-e2e evidence.
#
# The problem: a contended pr-e2e camps on host capacity for a bounded 1800 s
# and then gives up (a swarm worker holds the host-global /tmp/matou-swarm.lock
# for up to 180 min, so a PR pushed early into a long worker can never outwait
# it). The pr-e2e trigger is event-driven (pull_request) and nothing re-fires
# it, so the PR head silently carries no feature-e2e verdict until a human
# notices the red run and re-dispatches by hand.
#
# This scheduled sweep (pr-e2e-sweep.yml, off-cycle from swarm's :15/:45) lists
# open PRs and, for each whose CURRENT head sha has no real pr-e2e verdict
# comment AND no pr-e2e run already in flight, workflow_dispatches pr-e2e —
# oldest PR first, at most PR_E2E_SWEEP_MAX per tick so it can never flood the
# queue. The comment-on-PR is the source of truth for "has evidence" (the
# give-up loud path in pr-e2e.yml writes a state=pending placeholder;
# run-pr-e2e.sh writes state=done), so the sweep holds no state of its own and
# also catches runs lost to a runner restart.
#
# Actions-API slowness (#335): only bounded, filtered queries here —
# actions/tasks?limit&page=1 and per-PR comment GETs — never the full
# /actions/runs listing (it 500s at 45 s).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=pr-e2e-lib.sh
. "$here/pr-e2e-lib.sh"

: "${FORGEJO_TOKEN:?set FORGEJO_TOKEN}" "${FORGEJO_API:?set FORGEJO_API (…/api/v1/repos/<owner>/<repo>)}"
MAX_DISPATCH="${PR_E2E_SWEEP_MAX:-2}"

api() { curl -sf --max-time 60 -H "Authorization: token $FORGEJO_TOKEN" "$@"; }

# ── in-flight guard (schedule-backstop's #238 AC3 pattern) ───────────────────
# Never pile onto a host that is already running pr-e2e. pr-e2e is
# host-exclusive (it takes every pooled slot), so at most one runs at a time,
# and a fresh dispatch while one is waiting/running would just camp and likely
# give up again — the very failure this sweep exists to avoid. If ANY
# feature-e2e run is waiting (queued) or running, stand down this tick; a later
# tick (30 min) finds the host free. Fail CLOSED on API trouble: we cannot tell
# "nothing in flight" from "API degraded", and dispatching blind piles runs
# onto an already-struggling instance.
if ! tasks="$(api "$FORGEJO_API/actions/tasks?limit=50&page=1")"; then
  echo "pr-e2e-sweep: actions/tasks unavailable — cannot tell if pr-e2e is in flight; skipping this tick" >&2
  exit 0
fi
# actions/tasks reports the JOB name (feature-e2e), not the workflow file.
inflight="$(jq -r '[.workflow_runs[]?
     | select((.name // "") == "feature-e2e" or ((.name // "") | test("^feature-e2e \\(")))
     | select(.status == "waiting" or .status == "running")] | length' <<<"$tasks" 2>/dev/null || echo 0)"
case "$inflight" in ''|*[!0-9]*) inflight=0 ;; esac
if [ "$inflight" -gt 0 ]; then
  echo "pr-e2e-sweep: a feature-e2e run is already waiting/running — host busy, standing down this tick"
  exit 0
fi

# ── candidates: open PRs whose current head has no verdict ───────────────────
# sort=oldest so the at-most-N budget goes to the stalest PRs first.
if ! prs="$(api "$FORGEJO_API/pulls?state=open&sort=oldest&limit=50")"; then
  echo "pr-e2e-sweep: could not list open PRs — skipping this tick" >&2
  exit 0
fi

dispatched=0 checked=0
while IFS=$'\t' read -r num sha; do
  [ -n "$num" ] && [ -n "$sha" ] || continue
  [ "$dispatched" -ge "$MAX_DISPATCH" ] && break
  checked=$((checked + 1))
  comments="$(api "$FORGEJO_API/issues/$num/comments?limit=100" 2>/dev/null || echo '[]')"
  if pr_e2e_has_verdict_for "$comments" "$sha"; then
    continue
  fi
  echo "pr-e2e-sweep: PR #$num head ${sha:0:12} has no feature-e2e verdict — dispatching pr-e2e"
  if api -X POST -H 'Content-Type: application/json' \
       -d "$(jq -n --arg n "$num" '{ref:"main", inputs:{pr_number:$n}}')" \
       "$FORGEJO_API/actions/workflows/pr-e2e.yml/dispatches" >/dev/null; then
    dispatched=$((dispatched + 1))
  else
    echo "pr-e2e-sweep: dispatch failed for PR #$num" >&2
  fi
done < <(jq -r '.[] | "\(.number)\t\(.head.sha)"' <<<"$prs")

if [ "$dispatched" -gt 0 ]; then
  echo "pr-e2e-sweep: dispatched pr-e2e for $dispatched PR(s) (checked $checked open PR(s), cap $MAX_DISPATCH/tick)"
else
  echo "pr-e2e-sweep: nothing to do — no open PR is missing a feature-e2e verdict"
fi
