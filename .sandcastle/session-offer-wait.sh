#!/usr/bin/env bash
# session-offer-wait.sh — a pool host's offer poll for the fleet dispatcher's
# session lane (ADR 0010 / #387, decision 3).
#
# The dispatcher allocates `ready-for-session` tickets to free slots fleet-wide
# and OFFERS a placed ticket to the host whose slot it took. This is the host's
# half of that hand-off: one long-lived loop that holds a request open to the
# dispatcher (a long poll — the host dials out, so no port is opened here and the
# dispatcher holds no key onto this host), and starts the session-runner for an
# offered ticket the moment the offer arrives. That removes the ten-minute wait
# of the per-repo cron tick without removing the tick: the tick stays as the
# fallback and stands down only while the dispatcher says it is allocating this
# host's session work — which it says only while THIS poll is connected.
#
# The host keeps the veto (decision 4). This script decides nothing about a
# ticket: it runs the host's own session-runner with the offer, and the runner
# applies every rule it always has. If the runner refuses, it writes one line
# `<scope> <retry-after-seconds> <reason>` to the decline file it was handed, and
# this script sends that back so the dispatcher stops offering it here for that
# long. An accepted offer needs no message: the runner's own slot report says the
# slot is taken.
#
#   loop   (default) poll until SESSION_OFFER_LIFETIME seconds have passed, then
#          exit 0 — cron starts the next one, so a new harness copy is picked up
#          within the hour. One at a time per host (a non-blocking lock): a
#          second start while one is polling exits at once.
#   once   one poll with no wait, offers handled in the foreground (the offline
#          test's seam, and a manual "is anything waiting for me?").
#
# Env:
#   FLEET_DISPATCHER_URL    the dispatcher's report endpoint (host-declared; the
#                           offer poll is <scheme://host:port>/session-offers on
#                           the same receiver). Unset = no dispatcher: exit 0.
#   FLEET_DISPATCHER_OFFERS_URL  override the derived poll URL.
#   FLEET_DISPATCHER_TOKEN  optional bearer, as for the slot report.
#   SESSION_OFFER_RUN       the host's generated launcher, called as
#                             <run> run <owner/repo> <number> <decline-file>
#                           It runs that repo's session-runner with the offer and
#                           the repo's own env, exactly as the cron line does. rc 3
#                           = that repo has no session-runner on this host.
#   SESSION_OFFER_HOST      the name this host reports as (default: SWARM_HOST,
#                           else HOST_NAME, else the short hostname — the slot
#                           report's own rule, so the two always agree).
#   SESSION_OFFER_KILLSWITCH  a path; while it exists the loop exits (the host's
#                           pause switch stops the poll as it stops every tick).
#   SESSION_OFFER_WAIT (50) / SESSION_OFFER_LIFETIME (3300) / SESSION_OFFER_BACKOFF (15)
#
# No repo name, host or product path lives here (CLAUDE.md blast radius).
# Offline-tested by tests/session-offer-wait-test.sh (a shimmed curl replaying the
# receiver's own --offers body, a fake launcher).
set -euo pipefail

mode="${1:-loop}"
case "$mode" in loop|once) ;; *) echo "usage: session-offer-wait.sh {loop|once}" >&2; exit 2 ;; esac

url="${FLEET_DISPATCHER_URL:-}"
if [ -z "$url" ] && [ -z "${FLEET_DISPATCHER_OFFERS_URL:-}" ]; then
  echo "session-offer-wait: no dispatcher declared (FLEET_DISPATCHER_URL unset) — nothing to wait for"
  exit 0
fi
offers_url="${FLEET_DISPATCHER_OFFERS_URL:-$(printf '%s' "$url" | sed -E 's#^(https?://[^/]+).*#\1#')/session-offers}"
[ -n "${SESSION_OFFER_RUN:-}" ] || { echo "session-offer-wait: SESSION_OFFER_RUN is unset — it must name the generated session launcher of this host" >&2; exit 2; }
host="${SESSION_OFFER_HOST:-${SWARM_HOST:-${HOST_NAME:-$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo unknown)}}}"
case "$host" in ''|*[!A-Za-z0-9._-]*|.*) echo "session-offer-wait: host name '$host' is not usable as a poll key" >&2; exit 2 ;; esac

SESSION_OFFER_WAIT="${SESSION_OFFER_WAIT:-50}"
SESSION_OFFER_LIFETIME="${SESSION_OFFER_LIFETIME:-3300}"
SESSION_OFFER_BACKOFF="${SESSION_OFFER_BACKOFF:-15}"
SESSION_OFFER_KILLSWITCH="${SESSION_OFFER_KILLSWITCH:-}"
SESSION_OFFER_STATE="${SESSION_OFFER_STATE:-${HOST_CAPACITY_STATE_DIR:-$HOME/swarm/state}/session-offers}"
SESSION_OFFER_LOCK="${SESSION_OFFER_LOCK:-$SESSION_OFFER_STATE/wait.lock}"
mkdir -p "$SESSION_OFFER_STATE"

log() { printf '%s session-offer-wait: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# send_decline <scope> <repo> <number> <retry-after> <reason> — tell the
# dispatcher this host will not take it. Best-effort: a decline that does not
# arrive only means the offer times out and is made again, and declined again.
send_decline() {
  local scope="$1" repo="$2" n="$3" retry="$4" reason="$5" body
  case "$retry" in ''|*[!0-9]*) retry=600 ;; esac
  body="$(jq -cn --arg h "$host" --arg r "$repo" --argjson n "$n" --arg s "$scope" \
            --arg why "$reason" --argjson ra "$retry" \
            '{kind: "session-decline", host: $h, repo: $r, number: $n, scope: $s, reason: $why, retry_after: $ra}')" || return 0
  [ -n "$url" ] || return 0
  printf '%s' "$body" | curl -s -o /dev/null --max-time 15 -X POST -H 'Content-Type: application/json' \
      ${FLEET_DISPATCHER_TOKEN:+-H "Authorization: Bearer $FLEET_DISPATCHER_TOKEN"} \
      --data-binary @- "$url" 2>/dev/null || true
}

# handle_offer <repo> <number> — run the host's launcher for one offered ticket
# and report a refusal. Runs for as long as the session does (it is started in
# the background by the loop); what it reports is decided entirely by the runner.
handle_offer() {
  local repo="$1" n="$2" df rc=0 scope retry reason
  df="$(mktemp "$SESSION_OFFER_STATE/decline.XXXXXX")"
  log "offered $repo#$n — starting the session-runner"
  "$SESSION_OFFER_RUN" run "$repo" "$n" "$df" || rc=$?
  if [ "$rc" = 3 ]; then
    log "$repo has no session-runner on this host — declining the repo"
    send_decline repo "$repo" "$n" 3600 "this repo has no session-runner on this host"
  elif [ -s "$df" ]; then
    read -r scope retry reason <"$df" || true
    case "${scope:-}" in ticket|repo|host) ;; *) scope=ticket ;; esac
    log "declined $repo#$n (scope=$scope, holds ${retry:-600}s): ${reason:-declined}"
    send_decline "$scope" "$repo" "$n" "${retry:-600}" "${reason:-declined}"
  else
    log "$repo#$n — the session-runner took the offer (rc=$rc)"
  fi
  unlink "$df" 2>/dev/null || true
}

# poll <wait-seconds> -> the offers JSON array on stdout; rc 1 when the
# dispatcher could not be reached or answered something that is not an offer
# list (the caller backs off — never a busy loop against a dead endpoint).
poll() {
  local wait="$1" resp
  resp="$(curl -s --max-time "$(( wait + 15 ))" -G \
            ${FLEET_DISPATCHER_TOKEN:+-H "Authorization: Bearer $FLEET_DISPATCHER_TOKEN"} \
            --data-urlencode "host=$host" --data-urlencode "wait=$wait" "$offers_url" 2>/dev/null)" || return 1
  printf '%s' "$resp" | jq -e '.ok == true and (.offers | type == "array")' >/dev/null 2>&1 || return 1
  # An offer is DATA from the network: keep only a well-formed one addressed to
  # this host — an owner/repo of safe characters and a ticket number.
  printf '%s' "$resp" | jq -c --arg h "$host" '[.offers[]
    | select(type == "object" and (.host // $h) == $h)
    | select((.repo | type) == "string" and (.repo | test("^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$")))
    | select((.number | type) == "number" and .number > 0 and (.number | floor) == .number)
    | {repo, number}]'
}

if [ "$mode" = once ]; then
  offers="$(poll 0)" || { log "the dispatcher did not answer the offer poll"; exit 1; }
  k="$(jq length <<<"$offers")"
  for (( i = 0; i < k; i++ )); do
    handle_offer "$(jq -r ".[$i].repo" <<<"$offers")" "$(jq -r ".[$i].number" <<<"$offers")"
  done
  exit 0
fi

# ── loop: one waiter per host ────────────────────────────────────────────────
exec 8>"$SESSION_OFFER_LOCK"
flock -n 8 || exit 0   # another waiter is already polling for this host
log "polling $offers_url as host '$host' (wait ${SESSION_OFFER_WAIT}s, lifetime ${SESSION_OFFER_LIFETIME}s)"
started="$(date +%s)"; down=0
while [ $(( $(date +%s) - started )) -lt "$SESSION_OFFER_LIFETIME" ]; do
  if [ -n "$SESSION_OFFER_KILLSWITCH" ] && [ -e "$SESSION_OFFER_KILLSWITCH" ]; then
    log "the host kill switch is on — stopping the offer poll"
    exit 0
  fi
  if ! offers="$(poll "$SESSION_OFFER_WAIT")"; then
    # Say so once per outage, not once per retry.
    [ "$down" = 1 ] || log "the dispatcher is not answering the offer poll — retrying every ${SESSION_OFFER_BACKOFF}s (the cron session tick covers meanwhile)"
    down=1
    sleep "$SESSION_OFFER_BACKOFF"
    continue
  fi
  [ "$down" = 0 ] || log "the dispatcher is answering again"
  down=0
  k="$(jq length <<<"$offers")"
  for (( i = 0; i < k; i++ )); do
    repo="$(jq -r ".[$i].repo" <<<"$offers")"; n="$(jq -r ".[$i].number" <<<"$offers")"
    # In the background, so a two-hour session never stops the poll; with the
    # waiter lock CLOSED in the child, so a session that outlives this waiter
    # does not keep the next one from starting.
    ( exec 8>&-; handle_offer "$repo" "$n" ) &
    disown $! 2>/dev/null || true
  done
done
log "lifetime reached — exiting (cron starts the next waiter)"
exit 0
