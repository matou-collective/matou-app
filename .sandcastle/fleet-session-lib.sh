#!/usr/bin/env bash
# fleet-session-lib.sh — the fleet dispatcher's SESSION lane (ADR 0010 / #387).
#
# ADR 0009 gave the fleet one allocator for `ready-for-agent` work and left the
# `ready-for-session` queue to a ten-minute cron line per repo per host. ADR 0010
# brings that queue under the same allocator: the dispatcher reads every repo's
# session queue, merges it into the ONE fleet order (priority label, then filing
# date — the lane is not part of the order), and OFFERS a placed session ticket
# to the host whose slot it took. The host starts it at once (it holds a long
# poll open for offers — session-offer-wait.sh) and KEEPS THE VETO: the
# session-runner applies every rule of its own and may decline, with a reason, a
# scope and a hold time the dispatcher remembers but does not interpret.
#
# This file is the dispatcher's half:
#   fleet_session_collect   the session queues -> fleet-order items (lane=session)
#   fleet_session_blocks    what the allocator must not offer where: live
#                           declines, offers still outstanding, sessions a slot
#                           report already shows running
#   fleet_session_offer     write one offer into the outbox the receiver serves
#   fleet_session_decline_ingest  a host's decline, spooled by the receiver
# The allocation itself is fleet_dispatch_allocate (fleet-dispatch-lib.sh), which
# takes these blocks as its fourth argument; a ticket with no `lane` is a swarm
# ticket and is allocated exactly as before.
#
# Nothing here is state the dispatcher cannot rebuild (ADR 0009 decision 2): the
# offers-outstanding file, the declines file and the dependency cache are hints.
# Losing any of them costs one repeated offer, which the host declines again.
#
# The mode is its own switch (ADR 0010 decision 6), independent of the swarm
# lane's FLEET_DISPATCH_MODE:
#   off     (default) the lane is inert — no tracker read, no log line.
#   shadow  read the queues, log the merged order and what WOULD be offered;
#           offer nothing, stand no host down. Computed BESIDE the live swarm
#           allocation, never inside it.
#   live    session tickets take slots in the one allocation; a placed one is
#           offered to its host (all hosts, or only FLEET_DISPATCH_SESSION_LIVE_HOSTS).
#
# No repo name, host or product path lives here (CLAUDE.md blast radius).
# Offline-tested by tests/fleet-session-lib-test.sh (a shimmed curl, crafted
# reports and spool files).

if [ -z "${__SWARM_FLEET_SESSION_LIB:-}" ]; then
__SWARM_FLEET_SESSION_LIB=1

FLEET_DISPATCH_HOME="${FLEET_DISPATCH_HOME:-$HOME/swarm/state/fleet-dispatch}"
FLEET_DISPATCH_SESSION_MODE="${FLEET_DISPATCH_SESSION_MODE:-off}"
FLEET_DISPATCH_SESSION_LIVE_HOSTS="${FLEET_DISPATCH_SESSION_LIVE_HOSTS:-}"
# The outbox the receiver serves a host's long poll from: one dir per host, one
# file per offer. The loop writes, the receiver hands over and deletes.
FLEET_DISPATCH_SESSION_OUTBOX="${FLEET_DISPATCH_SESSION_OUTBOX:-$FLEET_DISPATCH_HOME/session-offers}"
# The receiver touches <dir>/<host> on every offer poll: the proof a host's
# waiter is connected. No fresh stamp = no offers to that host, and no
# "allocating session work" in its acknowledgement (ADR 0010 decision 5).
FLEET_DISPATCH_SESSION_WAITERS="${FLEET_DISPATCH_SESSION_WAITERS:-$FLEET_DISPATCH_HOME/session-waiters}"
FLEET_DISPATCH_SESSION_WAITER_TTL="${FLEET_DISPATCH_SESSION_WAITER_TTL:-150}"
# How long an offer counts as outstanding (neither claimed nor declined) before
# the ticket may be offered again; and how long an UNDELIVERED offer file lives.
FLEET_DISPATCH_SESSION_OFFER_TTL="${FLEET_DISPATCH_SESSION_OFFER_TTL:-180}"
FLEET_DISPATCH_SESSION_DELIVER_TTL="${FLEET_DISPATCH_SESSION_DELIVER_TTL:-90}"
# A dependency verdict is cached this long, so a 10 s pass does not re-read every
# session ticket's dependencies. An unblocked ticket is therefore seen within
# this many seconds; the host re-checks dependencies itself before it claims.
FLEET_DISPATCH_SESSION_DEPS_TTL="${FLEET_DISPATCH_SESSION_DEPS_TTL:-60}"
# Bounds on a host's decline hold, and the default when it names none.
FLEET_DISPATCH_SESSION_DECLINE_MIN="${FLEET_DISPATCH_SESSION_DECLINE_MIN:-30}"
FLEET_DISPATCH_SESSION_DECLINE_MAX="${FLEET_DISPATCH_SESSION_DECLINE_MAX:-86400}"
FLEET_DISPATCH_SESSION_DECLINE_DEFAULT="${FLEET_DISPATCH_SESSION_DECLINE_DEFAULT:-600}"
FLEET_SESSION_MAX_TIME="${FLEET_SESSION_MAX_TIME:-20}"
FLEET_SESSION_QUEUE_LIMIT="${FLEET_SESSION_QUEUE_LIMIT:-50}"

_fleet_session_now() { echo "${FLEET_DISPATCH_NOW:-$(date +%s)}"; }
_fleet_session_api() { curl -sf --max-time "$FLEET_SESSION_MAX_TIME" -H "Authorization: token ${FORGEJO_TOKEN:-}" "$@"; }
_fleet_session_offered_path()  { printf '%s' "${FLEET_DISPATCH_SESSION_OFFERED:-$FLEET_DISPATCH_HOME/session-offered}"; }
_fleet_session_declines_path() { printf '%s' "${FLEET_DISPATCH_SESSION_DECLINES:-$FLEET_DISPATCH_HOME/session-declines}"; }
_fleet_session_deps_dir()      { printf '%s' "${FLEET_DISPATCH_SESSION_DEPS:-$FLEET_DISPATCH_HOME/session-deps}"; }

# a host / repo name safe to use as a path component and a log token
_fleet_session_host_ok() { case "$1" in ''|*[!A-Za-z0-9._-]*|.*) return 1 ;; *) return 0 ;; esac; }
_fleet_session_repo_ok() { case "$1" in ''|*[!A-Za-z0-9._/-]*|/*|*/|*//*|*..*) return 1 ;; */*) return 0 ;; *) return 1 ;; esac; }

# fleet_session_mode -> off | shadow | live (anything else reads off: the safe
# direction — a typo never turns offers on).
fleet_session_mode() {
  case "${FLEET_DISPATCH_SESSION_MODE:-off}" in shadow|live) echo "$FLEET_DISPATCH_SESSION_MODE" ;; *) echo off ;; esac
}

# _fleet_session_host_is_live <host> -> rc 0 iff a session ticket placed on
# <host> is really offered: the lane is live AND (the allowlist is empty, or
# names the host). Mirrors _fleet_dispatch_host_is_live for the swarm lane.
_fleet_session_host_is_live() {
  local h
  [ "$(fleet_session_mode)" = live ] || return 1
  [ -n "${FLEET_DISPATCH_SESSION_LIVE_HOSTS:-}" ] || return 0
  for h in $FLEET_DISPATCH_SESSION_LIVE_HOSTS; do [ "$h" = "$1" ] && return 0; done
  return 1
}

# fleet_session_waiter_fresh <host> -> rc 0 iff the host's offer poll reached the
# receiver within the waiter TTL. A host whose waiter is not connected could not
# receive an offer, so it is offered none.
fleet_session_waiter_fresh() {
  local f="$FLEET_DISPATCH_SESSION_WAITERS/$1" at
  _fleet_session_host_ok "$1" || return 1
  [ -f "$f" ] || return 1
  at="$(stat -c %Y "$f" 2>/dev/null)" || return 1
  case "$at" in ''|*[!0-9]*) return 1 ;; esac
  [ $(( $(_fleet_session_now) - at )) -lt "$FLEET_DISPATCH_SESSION_WAITER_TTL" ]
}

# ── the queue ────────────────────────────────────────────────────────────────
# fleet_session_candidates <issues-json> -> the tickets of ONE repo's
# `ready-for-session` list that the tracker itself says are workable, as
# [{number, title, created_at, priority}]. The label filter is the
# session-runner's own (no-triage / deferred / agent-blocked / agent-working),
# so the dispatcher never offers what every host would skip on sight. Pure.
fleet_session_candidates() {
  jq -c '[ .[]?
           | select((.state // "open") == "open")
           | select(.pull_request == null)
           | ([.labels[]?.name]) as $l
           | select(($l | index("ready-for-session")) != null)
           | select(($l | index("no-triage")) == null and ($l | index("deferred")) == null
                    and ($l | index("agent-blocked")) == null and ($l | index("agent-working")) == null)
           | {number, title: (.title // ""), created_at: (.created_at // null),
              priority: (($l | index("priority")) != null)} ]' <<<"$1" 2>/dev/null || printf '[]'
}

# _fleet_session_deps_open <api-root> <slug> <n> -> echoes the count of OPEN
# dependencies (0 = unblocked), cached for FLEET_DISPATCH_SESSION_DEPS_TTL. rc 1
# when it cannot be read and no fresh verdict is cached: the caller treats that
# as blocked (never offer on an unverified frontier — the session-runner's rule).
_fleet_session_deps_open() {
  local root="$1" slug="$2" n="$3" d f at open now
  d="$(_fleet_session_deps_dir)"; f="$d/${slug//\//-}-$n"; now="$(_fleet_session_now)"
  if [ -s "$f" ]; then
    read -r at open <"$f" || true
    case "${at:-}" in ''|*[!0-9]*) at=0 ;; esac
    case "${open:-}" in ''|*[!0-9]*) at=0 ;; esac
    if [ "$at" -gt 0 ] && [ $(( now - at )) -lt "$FLEET_DISPATCH_SESSION_DEPS_TTL" ]; then echo "$open"; return 0; fi
  fi
  open="$(_fleet_session_api "$root/repos/$slug/issues/$n/dependencies?limit=50" 2>/dev/null \
          | jq '[.[]? | select(.state == "open")] | length' 2>/dev/null)" || return 1
  case "${open:-}" in ''|*[!0-9]*) return 1 ;; esac
  mkdir -p "$d" 2>/dev/null || true
  printf '%s %s\n' "$now" "$open" >"$f.tmp" 2>/dev/null && mv -f "$f.tmp" "$f" 2>/dev/null || true
  echo "$open"
}

# fleet_session_collect_repo <api-root> <slug> -> one repo's session tickets as
# fleet-order items: {repo, number, title, created_at, priority, rank,
# lane:"session", open_deps}. open_deps is the count of OPEN dependencies (0 =
# workable), or -1 when they could not be read. A ticket that is not workable is
# KEPT here, so the log can say why it is not running; fleet_session_ready is what
# hands the allocator only the workable ones. rc 1 when the queue itself cannot
# be read — the caller omits the repo this pass.
fleet_session_collect_repo() {
  local root="$1" slug="$2" raw cands n out='[]' open
  raw="$(_fleet_session_api "$root/repos/$slug/issues?state=open&type=issues&labels=ready-for-session&limit=$FLEET_SESSION_QUEUE_LIMIT" 2>/dev/null)" || return 1
  jq -e 'type == "array"' <<<"$raw" >/dev/null 2>&1 || return 1
  cands="$(fleet_session_candidates "$raw")"
  for n in $(jq -r '.[].number' <<<"$cands"); do
    open="$(_fleet_session_deps_open "$root" "$slug" "$n")" || open=-1
    out="$(jq -c --argjson n "$n" --arg slug "$slug" --argjson c "$cands" --argjson open "$open" \
      '. + [ ($c[] | select(.number == $n))
             | . + {repo: $slug, lane: "session", open_deps: $open,
                    rank: (if .priority then 0 else 1 end)} ]' <<<"$out")"
  done
  printf '%s' "$out"
}

# fleet_session_ready <collected-json> -> the tickets the allocator may place:
# those with no open dependency. A ticket whose dependencies could not be read
# is NOT ready (never offer on an unverified frontier — the session-runner's own
# rule). Pure.
fleet_session_ready() { jq -c '[.[] | select((.open_deps // 0) == 0)]' <<<"$1" 2>/dev/null || printf '[]'; }

# fleet_session_format_held <collected-json> -> one log line per session ticket
# that is on the queue but not workable, in fleet order, with the reason. This is
# the "why is this session ticket not running?" answer that used to live only in
# per-host log files. Pure.
fleet_session_format_held() {
  jq -r 'sort_by(.rank, (.created_at // "~"), .number) | .[] | select((.open_deps // 0) != 0)
         | "  HELD   \(.repo)#\(.number) -> (none)  ["
           + (if .open_deps < 0 then "its dependencies could not be read — not offered on an unverified frontier"
              else "blocked by \(.open_deps) open issue(s)" end) + "]"' <<<"$1" 2>/dev/null || true
}

# fleet_session_collect <checkout>:<slug>... -> every repo's workable session
# tickets, merged (unordered — fleet_queue_order sorts the swarm and session
# items together). Each repo's forge root comes from its own identity layer
# (fleet_queue_api_root); a repo that cannot be read is omitted with one stderr
# line, exactly as fleet_queue_collect treats a failed lister. Repos are read in
# parallel, so a slow tracker costs one read's time, not one per repo.
fleet_session_collect() {
  local pair checkout slug tag root tmpd merged='[]'
  tmpd="$(mktemp -d)"
  for pair in "$@"; do
    checkout="${pair%%:*}"; slug="${pair#*:}"; tag="${slug//\//-}"
    if ! root="$(fleet_queue_api_root "$checkout" 2>/dev/null)"; then
      echo "fleet-session: no identity layer under $checkout for $slug — omitted this pass" >&2
      continue
    fi
    ( if fleet_session_collect_repo "$root" "$slug" >"$tmpd/$tag.json" 2>/dev/null; then echo 0; else echo 1; fi >"$tmpd/$tag.rc" ) &
  done
  wait
  for pair in "$@"; do
    slug="${pair#*:}"; tag="${slug//\//-}"
    [ -f "$tmpd/$tag.rc" ] || continue
    if [ "$(cat "$tmpd/$tag.rc" 2>/dev/null)" = 0 ] && jq -e 'type == "array"' "$tmpd/$tag.json" >/dev/null 2>&1; then
      merged="$(jq -c --slurpfile add "$tmpd/$tag.json" '. + $add[0]' <<<"$merged")"
    else
      echo "fleet-session: $slug session queue could not be read — omitted this pass" >&2
    fi
  done
  rm -rf "$tmpd"
  printf '%s' "$merged"
}

# ── offers ───────────────────────────────────────────────────────────────────
# fleet_session_offered_record <repo> <host> <number> — remember an offer just
# made, pruning the expired ones. Best-effort.
fleet_session_offered_record() {
  local f now at repo host num kept=""
  f="$(_fleet_session_offered_path)"; now="$(_fleet_session_now)"
  mkdir -p "$(dirname "$f")" 2>/dev/null || return 0
  if [ -s "$f" ]; then
    while read -r at repo host num; do
      case "$at" in ''|*[!0-9]*) continue ;; esac
      [ $(( now - at )) -lt "$FLEET_DISPATCH_SESSION_OFFER_TTL" ] || continue
      kept="$kept$at $repo $host $num"$'\n'
    done <"$f"
  fi
  printf '%s%s %s %s %s\n' "$kept" "$now" "$1" "$2" "$3" >"$f.tmp" 2>/dev/null && mv -f "$f.tmp" "$f" 2>/dev/null || true
}

# _fleet_session_offered_drop <repo> <host> <number> — forget one outstanding
# offer (the host declined it, so the ticket is free to be offered elsewhere).
_fleet_session_offered_drop() {
  local f at repo host num kept=""
  f="$(_fleet_session_offered_path)"; [ -s "$f" ] || return 0
  while read -r at repo host num; do
    [ "$repo" = "$1" ] && [ "$host" = "$2" ] && [ "$num" = "$3" ] && continue
    kept="$kept$at $repo $host $num"$'\n'
  done <"$f"
  printf '%s' "$kept" >"$f.tmp" 2>/dev/null && mv -f "$f.tmp" "$f" 2>/dev/null || true
}

# fleet_session_offer <repo> <host> <number> [title] — make one offer: write it
# into the host's outbox (atomically — the receiver never reads a half-written
# file) and record it as outstanding. rc 1 and no file on an unsafe name.
fleet_session_offer() {
  local repo="$1" host="$2" n="$3" title="${4:-}" d now f
  _fleet_session_host_ok "$host" && _fleet_session_repo_ok "$repo" || return 1
  case "$n" in ''|*[!0-9]*) return 1 ;; esac
  now="$(_fleet_session_now)"; d="$FLEET_DISPATCH_SESSION_OUTBOX/$host"
  mkdir -p "$d" 2>/dev/null || return 1
  f="$d/$now-${repo//\//-}-$n.json"
  jq -cn --arg r "$repo" --argjson n "$n" --arg h "$host" --arg t "$title" --argjson at "$now" \
     --argjson exp "$(( now + FLEET_DISPATCH_SESSION_DELIVER_TTL ))" \
     '{kind: "session-offer", repo: $r, number: $n, host: $h, title: $t, offered_at: $at, expires: $exp}' \
     >"$f.tmp" 2>/dev/null || { rm -f "$f.tmp"; return 1; }
  mv -f "$f.tmp" "$f" || return 1
  fleet_session_offered_record "$repo" "$host" "$n"
}

# fleet_session_outbox_sweep — drop offer files no waiter collected in time, so a
# host whose poll died does not find a stale offer when it comes back.
fleet_session_outbox_sweep() {
  local f exp now
  [ -d "$FLEET_DISPATCH_SESSION_OUTBOX" ] || return 0
  now="$(_fleet_session_now)"
  for f in "$FLEET_DISPATCH_SESSION_OUTBOX"/*/*.json; do
    [ -f "$f" ] || continue
    exp="$(jq -r '.expires // 0' "$f" 2>/dev/null)"; case "$exp" in ''|*[!0-9]*) exp=0 ;; esac
    [ "$exp" -gt "$now" ] || rm -f "$f"
  done
}

# ── declines ─────────────────────────────────────────────────────────────────
# fleet_session_decline_ingest <json> -> record one host's decline:
#   {kind:"session-decline", host, repo, number, scope, reason, retry_after}
# scope is ticket (this ticket on this host), repo (any session ticket of this
# repo on this host) or host (any session work on this host). The hold is
# clamped; the reason is flattened to one bounded line (it is a HOST's text —
# data for the log, never interpreted). The matching outstanding offer is
# dropped. rc 1 (and nothing recorded) on anything malformed.
fleet_session_decline_ingest() {
  local json="$1" host repo num scope reason retry now f
  printf '%s' "$json" | jq -e 'type == "object" and .kind == "session-decline"' >/dev/null 2>&1 || return 1
  host="$(jq -r '.host // empty' <<<"$json" 2>/dev/null)"
  repo="$(jq -r '.repo // empty' <<<"$json" 2>/dev/null)"
  num="$(jq -r '.number // 0' <<<"$json" 2>/dev/null)"
  scope="$(jq -r '.scope // "ticket"' <<<"$json" 2>/dev/null)"
  retry="$(jq -r '.retry_after // empty' <<<"$json" 2>/dev/null)"
  reason="$(jq -r '.reason // "declined"' <<<"$json" 2>/dev/null | tr -s '[:space:]' ' ' | cut -c1-200)"
  _fleet_session_host_ok "$host" || return 1
  case "$scope" in ticket|repo|host) ;; *) return 1 ;; esac
  case "$num" in ''|*[!0-9]*) num=0 ;; esac
  if [ "$scope" != host ] || [ -n "$repo" ]; then _fleet_session_repo_ok "$repo" || return 1; fi
  [ -n "$repo" ] || repo=-
  case "$retry" in ''|*[!0-9]*) retry="$FLEET_DISPATCH_SESSION_DECLINE_DEFAULT" ;; esac
  [ "$retry" -ge "$FLEET_DISPATCH_SESSION_DECLINE_MIN" ] || retry="$FLEET_DISPATCH_SESSION_DECLINE_MIN"
  [ "$retry" -le "$FLEET_DISPATCH_SESSION_DECLINE_MAX" ] || retry="$FLEET_DISPATCH_SESSION_DECLINE_MAX"
  now="$(_fleet_session_now)"; f="$(_fleet_session_declines_path)"
  mkdir -p "$(dirname "$f")" 2>/dev/null || return 1
  {
    # keep the live declines, minus an older one this one replaces
    if [ -s "$f" ]; then
      local until h s r n rest
      while read -r until h s r n rest; do
        case "$until" in ''|*[!0-9]*) continue ;; esac
        [ "$until" -gt "$now" ] || continue
        [ "$h" = "$host" ] && [ "$s" = "$scope" ] && [ "$r" = "$repo" ] && [ "$n" = "$num" ] && continue
        printf '%s %s %s %s %s %s\n' "$until" "$h" "$s" "$r" "$n" "$rest"
      done <"$f"
    fi
    printf '%s %s %s %s %s %s\n' "$(( now + retry ))" "$host" "$scope" "$repo" "$num" "$reason"
  } >"$f.tmp" 2>/dev/null && mv -f "$f.tmp" "$f" || { rm -f "$f.tmp"; return 1; }
  [ "$repo" = - ] || _fleet_session_offered_drop "$repo" "$host" "$num"
  echo "fleet-session: $host declined ${repo}#$num (scope=$scope, holds ${retry}s): $reason"
}

# ── what must not be offered where ───────────────────────────────────────────
# fleet_session_blocks <reports-json-lines-fn-output...> -> a JSON array of
# {host, scope, repo, number, reason} the allocator applies to SESSION tickets.
# host "*" means every host. Three sources:
#   - a live decline (the host's veto, in the host's words);
#   - an offer still outstanding: the ticket is offered nowhere else, and its
#     host is not offered a second session of the same repo, until the offer is
#     claimed, declined or times out;
#   - a session a fresh slot report already shows running: one session per repo
#     per host is the session-runner's own lock, visible without asking.
# Reads the fresh reports through _fleet_dispatch_fresh_reports when the
# dispatcher lib is loaded. Never fails: an unreadable source contributes nothing.
fleet_session_blocks() {
  local f now until h s r n rest at repo host num
  now="$(_fleet_session_now)"
  {
    f="$(_fleet_session_declines_path)"
    if [ -s "$f" ]; then
      while read -r until h s r n rest; do
        case "$until" in ''|*[!0-9]*) continue ;; esac
        [ "$until" -gt "$now" ] || continue
        case "$n" in ''|*[!0-9]*) n=0 ;; esac
        jq -cn --arg h "$h" --arg s "$s" --arg r "$r" --argjson n "$n" --arg why "$rest" --argjson left "$(( until - now ))" \
          '{host: $h, scope: $s, repo: (if $r == "-" then null else $r end), number: $n,
            reason: "\($h) declined: \($why) (holds another \($left)s)"}'
      done <"$f"
    fi
    f="$(_fleet_session_offered_path)"
    if [ -s "$f" ]; then
      while read -r at repo host num; do
        case "$at" in ''|*[!0-9]*) continue ;; esac
        case "${num:-}" in ''|*[!0-9]*) continue ;; esac
        [ $(( now - at )) -lt "$FLEET_DISPATCH_SESSION_OFFER_TTL" ] || continue
        jq -cn --arg h "$host" --arg r "$repo" --argjson n "$num" --argjson age "$(( now - at ))" \
          '{host: "*", scope: "ticket", repo: $r, number: $n,
            reason: "already offered to \($h) \($age)s ago — awaiting its claim or decline"},
           {host: $h, scope: "repo", repo: $r, number: $n,
            reason: "\($h) holds an outstanding offer of \($r)#\($n) (one session per repo per host)"}'
      done <"$f"
    fi
    if command -v _fleet_dispatch_fresh_reports >/dev/null 2>&1; then
      for f in $(_fleet_dispatch_fresh_reports | sort); do
        jq -c '(.host) as $h | .slots[]? | select(.state == "busy")
               | select((.holder.kind // "") == "session") | select((.holder.repo // "") != "")
               | {host: $h, scope: "repo", repo: .holder.repo, number: (.issue // 0),
                  reason: "\($h) is already running a \(.holder.repo) session (one session per repo per host)"}' "$f" 2>/dev/null
      done
    fi
  } | jq -cs '.' 2>/dev/null || printf '[]'
}

# fleet_session_waiting_hosts -> a JSON array of the hosts whose offer poll is
# connected right now (a fresh waiter stamp).
fleet_session_waiting_hosts() {
  local f h out=""
  [ -d "$FLEET_DISPATCH_SESSION_WAITERS" ] || { printf '[]'; return 0; }
  for f in "$FLEET_DISPATCH_SESSION_WAITERS"/*; do
    [ -f "$f" ] || continue
    h="${f##*/}"
    fleet_session_waiter_fresh "$h" && out="$out$h"$'\n'
  done
  printf '%s' "$out" | jq -Rcs 'split("\n") | map(select(length > 0))'
}

# fleet_session_unconnected_blocks <free-slots-json> -> a host-scope block for
# every host with a free slot whose offer poll is NOT connected, so the live
# allocation never places a session ticket where no offer could be delivered.
fleet_session_unconnected_blocks() {
  jq -c --argjson w "$(fleet_session_waiting_hosts)" \
    '[ [.[].host] | unique | .[] | select(. as $h | ($w | index($h)) | not)
       | {host: ., scope: "host", repo: null, number: 0,
          reason: "\(.) has no offer poll connected (it runs its own session tick)"} ]' <<<"$1" 2>/dev/null || printf '[]'
}

# fleet_session_format <decisions-json> -> the session lane's log lines: one per
# SESSION decision of an allocation. A placed ticket names the host it is (or
# would be) offered to; an unplaced one says why not sooner.
fleet_session_format() {
  jq -r '.[] | select((.lane // "swarm") == "session") |
    if .placed then "  OFFER  \(.repo)#\(.number) -> \(.host) slot \(.slot)  [\(.reason)]"
    else            "  QUEUE  \(.repo)#\(.number) -> (none)  [\(.reason)]" end' <<<"$1"
}

fi
