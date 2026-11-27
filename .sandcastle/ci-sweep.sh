#!/usr/bin/env bash
# ci-sweep.sh — #548: re-run a ci that never got to start.
#
# The problem, same shape as #278's for pr-e2e: ci is event-driven (push /
# pull_request) and its heavy stages ride the host-capacity pool through
# host-slot-wait.sh. When an exclusive drive holds every slot on the host the
# run lands on — an idss rehearsal drive took 43 min on 2026-09-21 — the camp
# expires, host-slot-wait exits 75, and the stage never runs. That used to red
# main: the job failed, the healer was woken on a non-fault, and the sha carried
# a red that said nothing about the code.
#
# run-ci-checks.sh now treats 75 as a DEFERRAL (prints CI_DEFERRED, writes no
# seam verdict) and ci.yml marks the sha with a PENDING `ci / capacity-deferred`
# commit status instead of failing. Pending, not green: the sha's combined
# status stays unresolved, so a deferred run can never be mistaken for a passing
# seam. This scheduled sweep is the other half — it finds those shas and
# re-dispatches ci for them, so the evidence arrives without a human noticing.
#
# State lives in the commit status, not here: `ci / capacity-deferred` pending
# means "owed a run", and ci.yml clears it to success on the re-run. So a run
# lost to a runner restart is caught by the same pass, and the sweep is
# idempotent — re-running it dispatches nothing new.
#
# Actions-API slowness (#335): only bounded, filtered queries — actions/tasks
# with limit&page=1, one commits listing, one statuses GET per candidate sha.
# Never the full /actions/runs listing (it 500s at 45 s).
set -euo pipefail

: "${FORGEJO_TOKEN:?set FORGEJO_TOKEN}" "${FORGEJO_API:?set FORGEJO_API (…/api/v1/repos/<owner>/<repo>)}"
MAX_DISPATCH="${CI_SWEEP_MAX:-1}"
BRANCH="${CI_SWEEP_BRANCH:-main}"
# How many recent main commits to consider. A deferral older than this is stale:
# main has moved on and the newer sha's own run is the one that matters.
DEPTH="${CI_SWEEP_DEPTH:-5}"
CONTEXT="ci / capacity-deferred"

api() { curl -sf --max-time 60 -H "Authorization: token $FORGEJO_TOKEN" "$@"; }

# ── in-flight guard (#238 AC3 pattern, as pr-e2e-sweep) ──────────────────────
# Never pile onto a host that is already running ci: a fresh dispatch while one
# is queued would camp behind the same drive and defer again. Fail CLOSED on API
# trouble — "nothing in flight" and "API degraded" are indistinguishable, and
# dispatching blind piles runs onto an already-struggling instance.
if ! tasks="$(api "$FORGEJO_API/actions/tasks?limit=50&page=1")"; then
  echo "ci-sweep: actions/tasks unavailable — cannot tell if ci is in flight; skipping this tick" >&2
  exit 0
fi
# actions/tasks reports the JOB name (checks), not the workflow file.
inflight="$(jq -r '[.workflow_runs[]?
     | select((.name // "") == "checks" or ((.name // "") | test("^checks \\(")))
     | select(.status == "waiting" or .status == "running")] | length' <<<"$tasks" 2>/dev/null || echo 0)"
case "$inflight" in ''|*[!0-9]*) inflight=0 ;; esac
if [ "$inflight" -gt 0 ]; then
  echo "ci-sweep: a ci run is already waiting/running — standing down this tick"
  exit 0
fi

# ── candidates: recent branch commits still marked deferred ──────────────────
if ! commits="$(api "$FORGEJO_API/commits?sha=$BRANCH&limit=$DEPTH&stat=false&verification=false&files=false")"; then
  echo "ci-sweep: could not list $BRANCH commits — skipping this tick" >&2
  exit 0
fi

# ci_sha_is_deferred <statuses-json> — 0 when the NEWEST status for the deferral
# context is still pending. Forgejo returns statuses newest-first per context;
# taking the first match means a re-run that resolved the sha (success) retires
# it, and only a still-pending marker counts as owed.
ci_sha_is_deferred() {
  local newest
  newest="$(jq -r --arg ctx "$CONTEXT" '[.[]? | select(.context == $ctx)] | .[0].status // ""' <<<"$1" 2>/dev/null || echo "")"
  [ "$newest" = "pending" ]
}

dispatched=0 checked=0
# Oldest first (the listing is newest-first), so the at-most-N budget goes to
# the stalest sha — the one that has been owed a run longest.
while IFS= read -r sha; do
  [ -n "$sha" ] || continue
  [ "$dispatched" -ge "$MAX_DISPATCH" ] && break
  checked=$((checked + 1))
  statuses="$(api "$FORGEJO_API/statuses/$sha?limit=50" 2>/dev/null || echo '[]')"
  ci_sha_is_deferred "$statuses" || continue
  echo "ci-sweep: ${sha:0:12} on $BRANCH is marked '$CONTEXT' pending — dispatching ci"
  if api -X POST -H 'Content-Type: application/json' \
       -d "$(jq -n --arg sha "$sha" --arg ref "$BRANCH" '{ref:$ref, inputs:{sha:$sha}}')" \
       "$FORGEJO_API/actions/workflows/ci.yml/dispatches" >/dev/null; then
    dispatched=$((dispatched + 1))
  else
    echo "ci-sweep: dispatch failed for ${sha:0:12}" >&2
  fi
done < <(jq -r '[.[]? | .sha] | reverse | .[]' <<<"$commits")

if [ "$dispatched" -gt 0 ]; then
  echo "ci-sweep: dispatched ci for $dispatched sha(s) (checked $checked of the last $DEPTH $BRANCH commits, cap $MAX_DISPATCH/tick)"
else
  echo "ci-sweep: nothing to do — no recent $BRANCH commit is owed a ci run"
fi
