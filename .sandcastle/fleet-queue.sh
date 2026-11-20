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
#                         The dispatch is ARBITRATED on the tracker (#351): a
#                         ticket a peer host is already dispatching is skipped
#                         for the next in line, so one ticket goes to one host.
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
# shellcheck source=fleet-slot-report-lib.sh
. "$here/fleet-slot-report-lib.sh"
# #376: reuse the #373 runner-queue lag map + ceiling (fleet_dispatch_lag_from_runs,
# _fleet_dispatch_waiting_runs, _fleet_dispatch_host_backed_off, FLEET_DISPATCH_QUEUE_
# LAG_MAX) for the host-side early marker release + self-dispatch backpressure below.
# shellcheck source=fleet-dispatch-lib.sh
. "$here/fleet-dispatch-lib.sh"

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

# ── runner-queue backpressure scan, host side (#376 — follow-ups to #373) ─────
# This host's forgejo-runner is a resource SEPARATE from its heavy slot: a leg it
# dispatched can sit `waiting` unpicked while a slot is free (GOTCHAS 78 / #373).
# Read this host's still-`waiting` legs across every repo it watches ONCE per
# invocation (memoised in _FQ_SCAN_FILE), exposing BOTH shapes the follow-ups need:
#   .hostlag {<host>: lag}      — the #373 host lag map restricted to THIS host, for
#                                 the self-dispatch backpressure gate (item 2);
#   .legs    {<slug>: {<n>: lag}} — the per-ticket waiting-leg age, for the early
#                                 marker release (item 1).
# One bounded, curl-timed GET per repo (actions/runs?status=waiting), fail-open per
# repo (a read that fails contributes nothing — never frees a marker, never backs
# the host off). Reuses the #373 read + lag-map helpers (fleet-dispatch-lib.sh).
# The memo lives in a per-process FILE, not a shell var: both call sites read it via
# command substitution (a subshell), so a var assignment would not survive to be
# reused — the file does, so the tracker is read at most once per invocation.
_FQ_SCAN_FILE="${TMPDIR:-/tmp}/fleet-queue-waiting-scan.$$"
trap 'rm -f "$_FQ_SCAN_FILE"' EXIT
_fleet_queue_waiting_scan() {
  [ -s "$_FQ_SCAN_FILE" ] && { printf '%s' "$(< "$_FQ_SCAN_FILE")"; return 0; }
  local now pair checkout slug root runs sub hostlag='{}' legs='{}' out
  now="$(date +%s)"
  for pair in "${repos[@]}"; do
    checkout="${pair%%:*}"; slug="${pair#*:}"
    root="$(fleet_queue_api_root "$checkout" 2>/dev/null)" || continue
    runs="$(_fleet_dispatch_waiting_runs "$root" "$slug")" || continue
    [ -n "$runs" ] || continue
    sub="$(fleet_dispatch_lag_from_runs "$runs" "$now" "$host")"; [ -n "$sub" ] || sub='{}'
    hostlag="$(jq -cn --argjson a "$hostlag" --argjson b "$sub" \
      'reduce (($a|keys_unsorted)+($b|keys_unsorted))[] as $k ({};
         .[$k] = ([$a[$k], $b[$k]] | map(select(. != null)) | max))' 2>/dev/null || printf '%s' "$hostlag")"
    legs="$(jq -cn --argjson l "$legs" --arg s "$slug" \
      --argjson v "$(fleet_queue_waiting_legs "$runs" "$now" "$host")" \
      '$l + {($s): $v}' 2>/dev/null || printf '%s' "$legs")"
  done
  out="$(jq -cn --argjson h "$hostlag" --argjson g "$legs" '{hostlag: $h, legs: $g}')"
  printf '%s' "$out" >"$_FQ_SCAN_FILE" 2>/dev/null || true
  printf '%s' "$out"
}

# Sweep this host's expired dispatch markers (#351) on EVERY call, before any
# gate: a busy host's tick exits at the slot gate, and its markers must not
# outlive their TTL on the tickets. No tracker call when none is recorded.
if [ -s "$(fleet_queue_marks_path)" ] && sweep_root="$(fleet_queue_api_root "$first_checkout")"; then
  fleet_queue_marks_sweep "$sweep_root"
fi

# ── early dispatch-marker release (#376 item 1 / follow-up to #373) ───────────
# A dispatch marker (#351) holds its ticket for the full FLEET_QUEUE_MARK_TTL even
# when the dispatched leg is never picked — and under a live dispatcher the
# stood-down host idles its slot the whole TTL (#370). If a marker THIS host
# recorded names a leg the forge still shows `waiting` past FLEET_QUEUE_LEG_WAIT_MAX,
# release it NOW so another host can take the ticket; the TTL sweep above stays the
# backstop for a leg that cannot be read (fail-open). Reads the tracker only when a
# marker is held AND the early release is enabled.
if [ -s "$(fleet_queue_marks_path)" ] && [ "${FLEET_QUEUE_LEG_WAIT_MAX:-0}" -gt 0 ] 2>/dev/null \
   && release_root="$(fleet_queue_api_root "$first_checkout")"; then
  scan="$(_fleet_queue_waiting_scan)"
  # Snapshot the marker records before the loop: fleet_queue_mark_release rewrites
  # the marks file, so iterate a copy rather than the live file.
  while read -r _ mslug mn mcid; do
    [ -n "${mcid:-}" ] || continue
    lag="$(jq -r --arg s "$mslug" --arg n "$mn" '.legs[$s][$n] // empty' <<<"$scan" 2>/dev/null)" || lag=""
    case "$lag" in ''|*[!0-9]*) continue ;; esac
    [ "$lag" -ge "$FLEET_QUEUE_LEG_WAIT_MAX" ] || continue
    fleet_queue_mark_release "$release_root" "$mcid"
    echo "fleet-queue: $mslug#$mn's dispatched leg is still waiting ${lag}s (>= ${FLEET_QUEUE_LEG_WAIT_MAX}s) — released its dispatch marker early so another host can take it (#376)"
  done <<<"$(< "$(fleet_queue_marks_path)")"
fi

# ── slot report (ADR 0009 / #354): the host's full slot state, pushed to the
# dispatcher event-first. Sent BEFORE the gates, so a BUSY host — which exits at
# the slot gate below — still reports its held slots every tick; that periodic
# report is what keeps the dispatcher correct when a host dies without an end
# event. `end` carries the ticket this run is finishing (after-close). A no-op
# until a host declares FLEET_DISPATCHER_URL: this slice dispatches nothing.
case "$mode" in
  tick)        fleet_slot_report_emit tick "$host" ;;
  after-close) fleet_slot_report_emit end "$host" "$closed_slug" "$closed_n" ;;
  rearm)       fleet_slot_report_emit end "$host" ;;
esac

# ── the cheap gates (tick only): nothing is listed unless a run could start ──
if [ "$mode" = tick ]; then
  if host_capacity_drive_wanted; then
    echo "fleet-queue: a rehearsal drive has reserved host capacity — not dispatching while it waits"
    exit 0
  fi
  fleet_queue_slot_free || exit 0     # both pooled slots busy (or no disk headroom): silent, the slot's own run re-arms
  # ── dispatcher stand-down (ADR 0009 decision 4 / #356) ─────────────────────
  # This host has a free slot it could dispatch into. If its last slot report
  # (emitted above) drew a FRESH acting-ack, a LIVE dispatcher holds the fleet
  # view and will allocate that slot itself — so stand this tick's dispatch down
  # and leave allocation to it. The moment the acks stop (the dispatcher died,
  # was stopped, or only ever shadowed), the ack goes stale and this gate falls
  # through, resuming today's tick (stamp, strikes, #351 arbitration below)
  # within one heartbeat window: the dispatcher is never a single point of
  # failure. Only `tick` stands down — a finishing run's after-close/rearm still
  # self-rearms (the dispatcher-era retirement of that seam is a later slice).
  if fleet_slot_report_acked_fresh; then
    echo "fleet-queue: a live dispatcher acknowledged $host's last slot report — standing this tick's dispatch down; it allocates this host's free slot (ADR 0009)"
    exit 0
  fi
  if stamp="$(fleet_queue_stamp_fresh)"; then
    set -- $stamp
    echo "fleet-queue: dispatched $1#$2 ${3}s ago — waiting for that leg to claim before picking again"
    exit 0
  fi
  # A sick host whose dispatches die before they claim stands itself down with a
  # decaying backoff (#315) rather than re-dispatching the same ticket forever.
  if standdown="$(fleet_queue_standdown)"; then
    set -- $standdown
    echo "fleet-queue: $host has $1 consecutive unclaimed dispatch(es) — backing off ${2}s before probing the fleet again"
    exit 0
  fi
  # ── runner-queue backpressure (#376 item 2 / #373 parity) ──────────────────
  # No live dispatcher is handling this host (its acting-ack fell through above),
  # so this tick would SELF-dispatch into its own free slot. Apply the #373 gate —
  # the one the central dispatcher applies to a candidate host — to THIS host: if
  # its OWN runner queue is backed up past the ceiling, a self-dispatched leg would
  # only sit `waiting` (#370), so decline this pass and leave the slot free until
  # the runner drains. Reuses the #373 lag map + ceiling (FLEET_DISPATCH_QUEUE_LAG_
  # MAX; 0 disables); fail-open — an unreadable queue backs the host off nothing.
  # The cheap local gates above (stamp, strikes) run first, so the tracker read
  # happens only on a tick that would actually self-dispatch.
  if [ "${FLEET_DISPATCH_QUEUE_LAG_MAX:-0}" -gt 0 ] 2>/dev/null; then
    scan="$(_fleet_queue_waiting_scan)"
    if _fleet_dispatch_host_backed_off "$host" "$(jq -c '.hostlag' <<<"$scan" 2>/dev/null)"; then
      lag="$(jq -r --arg h "$host" '.hostlag[$h] // 0' <<<"$scan" 2>/dev/null)"
      echo "fleet-queue: $host's runner queue is backed up — oldest waiting leg ${lag}s old (>= ${FLEET_DISPATCH_QUEUE_LAG_MAX}s), offered nothing this pass (#373)"
      exit 0
    fi
  fi
fi

# A finishing run (after-close / rearm) on THIS host is proof it can start and
# claim: clear any accumulated unclaimed-dispatch strikes so it rejoins at once.
case "$mode" in after-close|rearm) fleet_queue_strike_reset ;; esac
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

# Strike accounting (#315, tick only): if the ticket we last dispatched to this
# host is STILL the fleet head, that dispatch never claimed — a healthy claim
# would have moved the head. Count a strike (the stand-down gate above reads the
# running total next tick); any other head resets the streak.
if [ "$mode" = tick ]; then
  if last_dispatch="$(fleet_queue_stamp_ticket)" && [ "$last_dispatch" = "$head_slug $head_n" ]; then
    n="$(fleet_queue_strike_bump)"
    echo "fleet-queue: $host's last dispatch of $head_slug#$head_n never claimed (strike $n)" >&2
    # The strike just counted may have reached the threshold: stand down now
    # rather than firing one more dispatch this host cannot claim (#315).
    if standdown="$(fleet_queue_standdown)"; then
      set -- $standdown
      echo "fleet-queue: $host has $1 consecutive unclaimed dispatch(es) — backing off ${2}s before probing the fleet again"
      exit 0
    fi
  else
    fleet_queue_strike_reset
  fi
fi

if [ "$mode" = pick ]; then
  printf '%s %s\n' "$head_slug" "$head_n"
  exit 0
fi

# ── arbitrate (#351): one ticket goes to ONE host ───────────────────────────
# Every pool host computes this same order in the same cron minute. Walk it
# from the head: a ticket a peer host is already dispatching (its live marker
# on the ticket is lower than ours) is theirs — take the next in line, so a
# second idle host works the second ticket instead of racing for the first.
total="$(jq length <<<"$ordered")"
limit="$FLEET_QUEUE_ARBITRATE_MAX"; [ "$total" -lt "$limit" ] && limit="$total"
pick_slug=""; pick_n=""; skipped=0
for (( i = 0; i < limit; i++ )); do
  cand_slug="$(jq -r --argjson i "$i" '.[$i].repo' <<<"$ordered")"
  cand_n="$(jq -r --argjson i "$i" '.[$i].number' <<<"$ordered")"
  if fleet_queue_arbitrate "$api_root" "$cand_slug" "$cand_n" "$host"; then
    pick_slug="$cand_slug"; pick_n="$cand_n"; break
  fi
  skipped=$(( skipped + 1 ))
  echo "fleet-queue: $cand_slug#$cand_n is being dispatched to $FLEET_QUEUE_ARB_HOLDER — taking the next ticket in line"
done
if [ -z "$pick_slug" ]; then
  echo "fleet-queue: the first $skipped ready ticket(s) are already being dispatched to another host — nothing for $host to dispatch ($total ready fleet-wide)"
  exit 0
fi
if [ "$skipped" -gt 0 ]; then
  why="next in line; $skipped ahead held by another host"
  if jq -e --arg s "$pick_slug" --argjson n "$pick_n" 'any(.[]; .repo == $s and .number == $n)' <<<"$deps" >/dev/null; then
    why="dependant of $promoted_for; $skipped ahead held by another host"
  fi
fi

# ── dispatch: one repo, one ticket, this host ──────────────────────────────
if code="$(fleet_queue_dispatch "$api_root" "$pick_slug" "$pick_n" "$host")"; then
  fleet_queue_stamp_write "$pick_slug" "$pick_n"
  echo "fleet-queue: dispatched $pick_slug#$pick_n to $host ($why; $total ready fleet-wide)"
else
  # Nothing is running for this ticket: free it now rather than at the TTL.
  [ -z "$FLEET_QUEUE_ARB_MARK" ] || fleet_queue_mark_release "$api_root" "$FLEET_QUEUE_ARB_MARK"
  echo "fleet-queue: dispatch of $pick_slug#$pick_n to $host FAILED (http=$code) — the next tick retries" >&2
fi
exit 0
