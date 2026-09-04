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
#
# idss #1195 (run 17201): BOTH of those bounds were unsound as a PAIR, and run 17201 red anyway.
# The outer 30 s is a HARD-CODED library constant
# (@ai-hero/sandcastle/dist/index.js: `PROMPT_EXPANSION_TIMEOUT_MS = 3e4`) — a
# shell expression gets no per-expression override the way a lifecycle hook gets
# `timeoutMs` (main.mts, #1142). So this script has to PROVE it returns first,
# and the old arithmetic could not:
#   (a) OVERSHOOT. The `SECONDS >= CLAIM_NEXT_BUDGET` test sat only at the TOP of
#       each candidate. A candidate admitted at 21 s then spent up to
#       ~4 x CLAIM_API_MAX_TIME (post + comments + label-id + label-write) with
#       nothing re-checking the clock: 21 + 10 already exceeds 30. Two candidates
#       whose claim_post each burned the full 10 s cap is exactly run 17201 —
#       ~10 s of prefetch, admitted at ~20 s, dead at 30.004 s, and NO claim
#       comment left on either #1191 or #1192 to show for it.
#   (b) FAIL-CLOSED ON HEALTHY. CLAIM_API_MAX_TIME=10 was set below the measured
#       latency of the one endpoint claim_alive_runs must read: this forge answers
#       `actions/tasks?limit=100&page=1` in 8.5-12.2 s (5 live samples,
#       2026-09-03; 3 of 5 over 10 s). So the fail-closed arm fired on a
#       healthy-but-slow forge, not just a stall, and the tick spent its
#       iteration claiming nothing — the "ready list was empty, but re-running
#       the lister myself shows 2 tasks" confusion in run 17201's iterations 1-2.
# The bound is now a DEADLINE plus per-candidate call sizing, so the worst case
# is arithmetic rather than hope: a candidate is admitted only when the clock
# left can bound ALL of its calls, i.e. CLAIM_CANDIDATE_CALLS x cap <=
# CLAIM_NEXT_DEADLINE - SECONDS. The last admitted candidate therefore lands at
# or before CLAIM_NEXT_DEADLINE, under the library's 30 s, for every path.
SECONDS=0
# Self-deadline, held under the library's hard-coded 30 s with margin for the
# `docker exec` round trip the library clock includes but this script cannot see.
CLAIM_NEXT_DEADLINE="${CLAIM_NEXT_DEADLINE:-26}"
# Worst-case bounded calls ONE candidate can make: claim_post, _claim_comments,
# then either the loser's DELETE or the winner's claim_label_id + label write.
# 5, not 4, leaves a spare for a second labels page (this repo has 25 labels, so
# claim_label_id pages once today — the margin is for a consumer that grows past
# 50 and would otherwise silently un-bound the walk).
CLAIM_CANDIDATE_CALLS="${CLAIM_CANDIDATE_CALLS:-5}"
# Below this the derived cap is too tight to be worth a round trip (healthy claim
# calls on this forge measure 1.0-1.5 s) — stop the walk and emit [] instead.
CLAIM_CALL_FLOOR="${CLAIM_CALL_FLOOR:-2}"
# The prefetch leg's cap, sized OVER the measured actions/tasks tail (12.2 s max
# of 5 samples) rather than under it — see (b). Fail-closed is still the outcome
# when it genuinely stalls; it is no longer the outcome when the forge is merely
# slow.
CLAIM_ALIVE_MAX_TIME="${CLAIM_ALIVE_MAX_TIME:-14}"
# Wall-clock bound on the lister leg. list-ready-tasks.sh retries each read with
# backoff at LIST_READY_MAX_TIME (30 s) apiece — a posture tuned for #52's
# transient 5xx, but one whose worst case (~96 s) is unbounded relative to a 30 s
# expansion. Bound it from OUTSIDE, leaving #52's retry tuning untouched.
CLAIM_LISTER_MAX_TIME="${CLAIM_LISTER_MAX_TIME:-12}"
# An EXPLICIT operator/probe override stays absolute and uncapped (eyes-open, the
# #77c seam); only the DEFAULT is deadline-derived. `+` form, so `set -u` is safe.
CLAIM_API_MAX_TIME_EXPLICIT="${CLAIM_API_MAX_TIME+1}"
: "${CLAIM_API_MAX_TIME:=$CLAIM_ALIVE_MAX_TIME}"
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

# #120: the lister and claim_alive_runs share no data, yet ran back-to-back —
# the lister's O(ready-queue) reads (~16-25s) plus the ~11s actions/tasks leg
# summed past Sandcastle's 30s prompt-expansion budget (matou-app run 11019),
# REDing the tick as PromptExpansionTimeoutError before CLAIM_NEXT_BUDGET could
# even be consulted. Kick claim_alive_runs off in the BACKGROUND first so its
# ~11s overlaps the lister entirely, then reap it. Its stdout goes to a temp
# file and its rc is captured below so the fail-closed ruling is preserved
# EXACTLY — the concurrency changes only WHEN the fetch runs, never its outcome.
alive_file="$(mktemp)"
trap 'rm -f "$alive_file"' EXIT
claim_alive_runs >"$alive_file" & alive_pid=$!

# idss#1195: bounded by wall clock from the outside. rc 124 is `timeout`'s "I killed
# it" — the ONLY rc that gets the graceful [] here. Every other non-zero rc still
# propagates, preserving #52/GOTCHAS #7: a persistent listing outage must still
# fail LOUD and be re-keyed to the "list ready tasks" stage, not be laundered
# into a quiet "nothing to do".
lister_rc=0
ready="$(timeout "${CLAIM_LISTER_MAX_TIME}s" bash "$lister")" || lister_rc=$?

# Reap the backgrounded alive-runs fetch, capturing its rc without tripping
# set -e (a failed fetch must fail CLOSED just below, not abort the reap here).
# Reaped BEFORE any lister-failure exit below, so no path leaves it orphaned.
alive_rc=0; wait "$alive_pid" || alive_rc=$?

if [ "$lister_rc" -ne 0 ]; then
  if [ "$lister_rc" -eq 124 ]; then
    echo "claim-next-task: the lister exceeded its ${CLAIM_LISTER_MAX_TIME}s wall-clock bound — emitting [] inside the 30s prompt-expansion budget rather than letting its retry schedule run the tick past it; cron/backstop re-fires." >&2
    echo '[]'
    exit 0
  fi
  exit "$lister_rc"
fi

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
[ "$alive_rc" -eq 0 ] || { echo '[]'; exit 0; }
alive="$(cat "$alive_file")"
for i in $(seq 0 $((n - 1))); do
  # #77: stop the walk once our wall-clock budget is spent. $SECONDS already
  # counts the lister + alive-runs fetch, so this also fails closed when those
  # ate most of the budget before the walk even began. Emitting [] here is the
  # SAME outcome as losing every race — nothing claimed, no Claude tokens — and
  # the cron/backstop re-fires, versus letting the sum run past 30 s and RED the
  # whole tick.
  # CLAIM_NEXT_BUDGET is now an OPTIONAL extra ceiling (unset by default): the
  # deadline test below is the real guard, because a fixed budget checked only
  # here cannot bound what the candidate does AFTER being admitted (idss#1195 (a)).
  if [ -n "${CLAIM_NEXT_BUDGET:-}" ] && [ "$SECONDS" -ge "$CLAIM_NEXT_BUDGET" ]; then
    echo "claim-next-task: ${CLAIM_NEXT_BUDGET}s wall-clock budget spent after $i candidate(s) of $n — emitting [] within the 30s prompt-expansion budget; cron/backstop re-fires." >&2
    echo '[]'
    exit 0
  fi

  # idss#1195: admit this candidate ONLY if the clock left can bound every call it
  # may make. cap x CLAIM_CANDIDATE_CALLS <= CLAIM_NEXT_DEADLINE - SECONDS, so a
  # candidate admitted at S finishes by the deadline even when every one of its
  # calls burns its full cap — the overshoot that REDed run 17201 is now
  # arithmetically unreachable, not merely unlikely.
  remaining=$((CLAIM_NEXT_DEADLINE - SECONDS))
  cap=$((remaining / CLAIM_CANDIDATE_CALLS))
  if [ "$cap" -lt "$CLAIM_CALL_FLOOR" ]; then
    echo "claim-next-task: ${remaining}s of the ${CLAIM_NEXT_DEADLINE}s deadline left after $i candidate(s) of $n — too little to bound one candidate's ${CLAIM_CANDIDATE_CALLS} calls at the ${CLAIM_CALL_FLOOR}s floor; emitting [] inside the 30s prompt-expansion budget. cron/backstop re-fires." >&2
    echo '[]'
    exit 0
  fi
  # Re-derived per candidate: _claim_api reads CLAIM_API_MAX_TIME at CALL time,
  # so the shrinking cap applies to the calls this candidate is about to make.
  if [ -z "$CLAIM_API_MAX_TIME_EXPLICIT" ]; then
    CLAIM_API_MAX_TIME="$cap"
    export CLAIM_API_MAX_TIME
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
