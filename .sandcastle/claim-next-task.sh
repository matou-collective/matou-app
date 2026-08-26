#!/usr/bin/env bash
# The Sandcastle task source under the multi-host pool: list ready tickets
# (priority-first, DAG-filtered — list-ready-tasks.sh unchanged), then CLAIM
# the head before the agent ever sees it. Emits a JSON array holding exactly
# the one verified-claimed ticket, or [] when nothing is claimable. A lost
# race costs ~3 API calls and zero Claude tokens — the loser walks down the
# list. Spec: docs/superpowers/specs/2026-08-11-multihost-swarm-design.md D4.
set -euo pipefail

# Wall-clock budget (#77). This whole script runs INSIDE one Sandcastle
# shell-expression whose budget is 30 s, and its cost is O(ready-queue)
# sequential Forgejo calls: the loser's claim walk does ~3 calls per contested
# ticket. A non-trivial ready DAG (#64–#75 stood 13 deep) sums those past 30 s
# under a modest latency bump and REDs the tick as a PromptExpansionTimeoutError
# — while a matrix sibling that won the head in one pass finishes fast (the
# observed asymmetry). Two bounds fix this:
#   1. CLAIM_NEXT_BUDGET — an overall wall-clock ceiling on the claim walk (below
#      the 30 s outer budget). Once spent we stop walking and emit [] gracefully;
#      the cron/backstop re-fires next tick. A partial walk that claims nothing
#      costs only API calls, no Claude tokens — the same trade a lost race makes.
#   2. CLAIM_API_MAX_TIME — the per-call timeout, set BELOW the 30 s outer budget
#      here (claim-lib defaults it to 30 s for the HOST-mode janitor, which runs
#      under no such budget). At 30 s = the outer budget, a single stalled call
#      fires the outer timeout at the very instant it would have failed closed
#      (#28); a smaller cap lets it fail closed to [] within budget instead.
SECONDS=0
CLAIM_NEXT_BUDGET="${CLAIM_NEXT_BUDGET:-22}"
: "${CLAIM_API_MAX_TIME:=10}"
export CLAIM_API_MAX_TIME

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
if [ -z "${FORGEJO_TOKEN:-}" ] && [ -f "$here/.env" ]; then . "$here/.env"; fi
if [ -z "${FORGEJO_TOKEN:-}" ] && [ -f /run/secrets/forgejo_token ]; then
  FORGEJO_TOKEN="$(cat /run/secrets/forgejo_token)"
fi
: "${FORGEJO_TOKEN:?}"
# shellcheck source=swarm-identity.sh
. "$here/swarm-identity.sh"
export FORGEJO_TOKEN FORGEJO_API
# shellcheck source=claim-lib.sh
. "$here/claim-lib.sh"
# Per-repo LANDING policy (#13, ADR 0002): print the claimed ticket's landing
# instruction so the worker knows whether to push to main or open a PR. The
# prompt already surfaces the claim's context; the line goes to stderr so the
# JSON contract on stdout stays a clean {number,title,body,url} array.
# SWARM_POLICY_FILE is a test-only seam (unset in production → the real policy
# file → LANDING=push default → "landing: push to main", today's behaviour).
# shellcheck source=policy-lib.sh
. "$here/policy-lib.sh"
# shellcheck source=landing-lib.sh
. "$here/landing-lib.sh"
policy_load "${SWARM_POLICY_FILE:-}"

print_landing() { # print_landing <issue-number>
  if [ "${SWARM_POLICY_LANDING:-push}" = pr ]; then
    echo "landing: PR from $(landing_branch_for "$1")" >&2
  else
    echo "landing: push to main" >&2
  fi
}

host="${SWARM_HOST:-$(hostname)}"
run="${SWARM_RUN_ID:-0}"
lister="${CLAIM_LISTER:-$here/list-ready-tasks.sh}"

# #468: a claim naming run 0 LOOKS protective and is not — no alive-runs list
# ever contains 0, so every other host's arbitration claims straight over it
# and the next janitor sweep deletes the comment + label outright, while the
# manual operator believes they hold the ticket. Manual invocations (no
# SWARM_RUN_ID) therefore refuse to claim; SWARM_CLAIM_FORCE=1 is the explicit
# eyes-open override (Ben's ruling 2026-08-13).
if [ "$run" = "0" ] && [ "${SWARM_CLAIM_FORCE:-0}" != "1" ]; then
  echo "claim-next-task: SWARM_RUN_ID unset/0 — a run-0 claim would be arbitrated over and janitor-swept, protecting nothing. Refusing to claim; set SWARM_CLAIM_FORCE=1 to claim anyway (it WILL be swept while you work)." >&2
  echo '[]'
  exit 0
fi

ready="$(bash "$lister")"
n="$(jq length <<<"$ready")"
[ "$n" -eq 0 ] && { echo '[]'; exit 0; }

# Fail CLOSED, not open, on an alive-runs fetch failure: falling back to '[]'
# here would make claim_won's own-id short-circuit the ONLY signal it ever
# sees, so this host would look like the sole live claimant and could win a
# ticket another host already holds — a double-claim the janitor can't catch
# either, since both runs really are alive. Skip the round instead; the cost
# is one cron/self-rearm cycle, not a correctness hole. No claim comment gets
# posted, so nothing needs cleaning up. (Ben's fail-closed ruling, 2026-08-11,
# review of commit 68fb911.)
alive="$(claim_alive_runs)" || { echo '[]'; exit 0; }
for i in $(seq 0 $((n - 1))); do
  # #77: stop the walk once our wall-clock budget is spent. $SECONDS already
  # counts the lister + alive-runs fetch, so this also fails closed when those
  # ate most of the budget before the walk even began. Emitting [] here is the
  # SAME outcome as losing every race — nothing claimed, no Claude tokens — and
  # the cron/backstop re-fires, versus letting the sum run past 30 s and RED the
  # whole tick.
  if [ "$SECONDS" -ge "$CLAIM_NEXT_BUDGET" ]; then
    echo "claim-next-task: ${CLAIM_NEXT_BUDGET}s wall-clock budget spent after $i candidate(s) of $n — emitting [] within the 30s prompt-expansion budget; cron/backstop re-fires." >&2
    echo '[]'
    exit 0
  fi
  num="$(jq -r ".[$i].number" <<<"$ready")"
  cid="$(claim_post "$num" "$host" "$run")" || continue
  if claim_won "$num" "$cid" "$alive"; then
    claim_mark_working "$num" || true
    print_landing "$num"
    jq -c "[.[$i]]" <<<"$ready"
    exit 0
  fi
  # lost — remove our claim comment only (the winner's label stays)
  _claim_api -X DELETE "$FORGEJO_API/issues/comments/$cid" || true
done
echo '[]'
