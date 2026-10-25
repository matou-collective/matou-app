#!/usr/bin/env bash
# fleet-queue.sh — the fleet queue watcher (#301): the ONE place that decides
# which ticket, across every consumer repo this host serves, is worked next.
#
# Ben's ruling (2026-10-22): one ticket per run; when a ticket closes, its
# dependants are worked next; otherwise the next in line across the whole
# fleet — `priority` first, then the filing date. Faster than the :15/:45 cron
# (a ready ticket is picked up within a tick, ~2 min) with NO `labeled`
# workflow trigger (#103 queued 2,700 no-op runs on one). The logic lives in
# fleet-queue-lib.sh; this is its entrypoint, run three ways:
#
#   tick                  the host cron (every ~2 min, the generated
#                         <home>/factory-cron/fleet-queue-tick.sh). Skips
#                         cheaply when this host has no free slot, a drive
#                         reservation, or a dispatch still in flight; else
#                         merges every repo's own ready list, orders it fleet-
#                         wide, promotes the dependants of recent closes, writes
#                         the host cache, and workflow_dispatches the head
#                         ticket's repo — inputs.ticket + inputs.host — so
#                         exactly ONE leg (this host's) runs exactly that ticket.
#   after-close <slug> <n>  a finishing run's self-rearm (report-lib.sh): the
#                         close is recorded, that ticket's dependants come
#                         first, and the pick is dispatched to THIS host with
#                         no slot gate — the caller's slot is freeing.
#   rearm                 after-close with nothing closed (a run that handed
#                         its ticket off): no slot gate, dispatch the head here.
#   pick                  compute + cache, print "slug n", dispatch nothing.
#
# Env: FLEET_QUEUE_REPOS="<checkout>:<owner/repo> ..." (the host registry's
#      repo lines, rendered by onboarding/host-state-lib.sh), HOST_NAME (the
#      dispatch target: the registry name == the leg's matrix.host label),
#      FORGEJO_TOKEN (else the first checkout's secrets/forgejo_token).
# Exit 0 on every decided path (never camp, never red a cron); 2 on usage.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=fleet-queue-lib.sh
. "$here/fleet-queue-lib.sh"

mode="${1:-tick}"; [ $# -gt 0 ] && shift
case "$mode" in
  tick|pick|rearm) ;;
  after-close)
    [ $# -ge 2 ] || { echo "usage: fleet-queue.sh after-close <owner/repo> <issue>" >&2; exit 2; }
    closed_slug="$1"; closed_n="$2" ;;
  *) echo "usage: fleet-queue.sh {tick|pick|rearm|after-close <owner/repo> <issue>}" >&2; exit 2 ;;
esac
: "${FLEET_QUEUE_REPOS:?set FLEET_QUEUE_REPOS to '<checkout>:<owner/repo> ...' (the generated fleet-queue-tick.sh does)}"
read -ra repos <<<"$FLEET_QUEUE_REPOS"
[ "${#repos[@]}" -gt 0 ] || { echo "fleet-queue: FLEET_QUEUE_REPOS is empty — nothing to watch" >&2; exit 2; }
host="${HOST_NAME:-$(hostname 2>/dev/null || echo unknown)}"
first_checkout="${repos[0]%%:*}"

# The token never rides argv or a URL: from the env (the host env file), else
# the first checkout's bind-mounted secret — the ladder schedule-backstop.sh
# climbs.
if [ -z "${FORGEJO_TOKEN:-}" ]; then
  for f in "$first_checkout/.sandcastle/secrets/forgejo_token" "$first_checkout/secrets/forgejo_token"; do
    [ -f "$f" ] && { FORGEJO_TOKEN="$(cat "$f")"; break; }
  done
fi
export FORGEJO_TOKEN="${FORGEJO_TOKEN:-}"

# ── the cheap gates (tick only): nothing is listed unless a run could start ──
if [ "$mode" = tick ]; then
  if host_capacity_drive_wanted; then
    echo "fleet-queue: a rehearsal drive has reserved host capacity — not dispatching while it waits"
    exit 0
  fi
  fleet_queue_slot_free || exit 0     # both pooled slots busy: silent, the slot's own run re-arms
  if stamp="$(fleet_queue_stamp_fresh)"; then
    set -- $stamp
    echo "fleet-queue: dispatched $1#$2 ${3}s ago — waiting for that leg to claim before picking again"
    exit 0
  fi
fi

[ "$mode" = after-close ] && fleet_queue_recent_close_record "$closed_slug" "$closed_n"

# ── the fleet order ────────────────────────────────────────────────────────
api_root="$(fleet_queue_api_root "$first_checkout")" || {
  echo "fleet-queue: no identity layer under $first_checkout — cannot name the forge; standing down" >&2
  exit 0
}
merged="$(fleet_queue_collect "${repos[@]}")"
ordered="$(fleet_queue_order "$merged")"

# Dependants first: the ticket this call just closed (after-close), then every
# close this host recorded inside the TTL, so a human's close and a peer run's
# close promote on the next tick too. Among the promoted, fleet order holds.
deps='[]'; promoted_for=""
closes="$(fleet_queue_recent_closes)"
if [ "$mode" = after-close ]; then
  closes="$(printf '%s %s\n%s' "$closed_slug" "$closed_n" "$closes" | awk 'NF && !seen[$0]++')"
fi
while read -r cslug cn; do
  [ -n "${cslug:-}" ] && [ -n "${cn:-}" ] || continue
  d="$(fleet_queue_dependants "$api_root" "$cslug" "$cn")"
  [ "$(jq length <<<"$d")" -gt 0 ] || continue
  deps="$(jq -c --argjson add "$d" '. + $add | unique' <<<"$deps")"
  promoted_for="${promoted_for:+$promoted_for, }$cslug#$cn"
done <<<"$closes"
ordered="$(fleet_queue_promote "$ordered" "$deps")"
fleet_queue_cache_write "$ordered"

head_slug="$(jq -r '.[0].repo // empty' <<<"$ordered")"
head_n="$(jq -r '.[0].number // empty' <<<"$ordered")"
if [ -z "$head_slug" ] || [ -z "$head_n" ]; then
  [ "$mode" = pick ] || echo "fleet-queue: nothing ready fleet-wide ($(( ${#repos[@]} )) repo(s) listed)"
  exit 0
fi
why="fleet head"
if jq -e --arg s "$head_slug" --argjson n "$head_n" 'any(.[]; .repo == $s and .number == $n)' <<<"$deps" >/dev/null; then
  why="dependant of $promoted_for"
fi

if [ "$mode" = pick ]; then
  printf '%s %s\n' "$head_slug" "$head_n"
  exit 0
fi

# ── dispatch: one repo, one ticket, this host ──────────────────────────────
if code="$(fleet_queue_dispatch "$api_root" "$head_slug" "$head_n" "$host")"; then
  fleet_queue_stamp_write "$head_slug" "$head_n"
  echo "fleet-queue: dispatched $head_slug#$head_n to $host ($why; $(jq length <<<"$ordered") ready fleet-wide)"
else
  echo "fleet-queue: dispatch of $head_slug#$head_n to $host FAILED (http=$code) — the next tick retries" >&2
fi
exit 0
