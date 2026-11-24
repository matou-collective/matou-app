#!/usr/bin/env bash
# fleet-dispatch-lib.sh — the fleet dispatcher's SHADOW allocator (ADR 0009,
# slice 2 / #355).
#
# ADR 0009 proposes ONE dispatcher that holds the fleet-wide view — every pool
# host's heavy slots (slice 1's slot report) and the fleet queue
# (fleet-queue-lib.sh) — and allocates the head pick to a free slot on a named
# host, instead of N hosts each deciding alone from a partial view. This slice
# is the allocator in SHADOW: it receives the reports, rebuilds the picture
# every pass, computes the allocation, LOGS each assignment, and DISPATCHES
# NOTHING (decision 6a). Running it alongside the live host ticks for a few days
# and reading its log is the acceptance — the log must answer, for any ready
# ticket, which slot it would have been offered and why not sooner.
#
# What this library is NOT (deliberately, to keep slice 2 one two-way door):
#   * it does not acknowledge reports or stand the host ticks down — the ack and
#     the fallback are decision 4 / slice 3 (#356);
#   * it does not dispatch for real — live dispatch is decision 6b/c / slice 4
#     (#357), which flips the start-a-run seam's mode from shadow to live;
#   * it does not detect bad landings — decision 5 / ruling D is slice 5 (#358).
#
# ── no state of its own (decision 2) ─────────────────────────────────────────
# The dispatcher stores nothing it cannot rebuild. Its picture is DERIVED every
# pass from two sources of truth it does not own: the tracker (the fleet order,
# via fleet-queue-lib.sh) and the hosts (their slot reports). The only thing on
# disk here is a spool of the reports as RECEIVED — the hosts' own truth, re-sent
# every tick (slice 1 ruling A). A restart loses the spool and the next round of
# reports refills it; the dispatcher can never disagree with reality for longer
# than one report cycle. The reports arrive over the mesh as HTTP POSTs that the
# dumb receiver (fleet-dispatch-receiver.py) drops into the inbox; this library
# is the tested half — ingest keys a report by host, the allocator reads the
# fresh ones. No repo name, host or product path lives here (CLAUDE.md blast
# radius): the spool root, the TTL and the start-a-run mode are all env-declared.
#
# Offline-tested by tests/fleet-dispatch-lib-test.sh (crafted reports, a crafted
# fleet order, a shimmed curl for the live seam). The HTTP receiver and the loop
# entrypoint (fleet-dispatch.sh) are runtime glue proven at the ends, like the
# slot-report producer's inline wiring (the main-mts-offline rule).

if [ -z "${__SWARM_FLEET_DISPATCH_LIB:-}" ]; then
__SWARM_FLEET_DISPATCH_LIB=1

_FLEET_DISPATCH_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# fleet-queue-lib.sh carries the order (collect/order/promote) and the dispatch
# call the live seam rides (fleet_queue_dispatch). It is idempotent and has its
# own source guard; a caller (fleet-dispatch.sh) that already sourced it keeps
# its state.
if ! command -v fleet_queue_dispatch >/dev/null 2>&1; then
  # shellcheck source=fleet-queue-lib.sh
  . "$_FLEET_DISPATCH_HERE/fleet-queue-lib.sh"
fi

# The spool root + its two dirs. inbox: raw POST bodies the receiver drops, one
# file per report, drained each pass. reports: the latest report per host, keyed
# by host. All under a host-declared root; never defaulted to a product path.
FLEET_DISPATCH_HOME="${FLEET_DISPATCH_HOME:-$HOME/swarm/state/fleet-dispatch}"
FLEET_DISPATCH_INBOX="${FLEET_DISPATCH_INBOX:-$FLEET_DISPATCH_HOME/inbox}"
FLEET_DISPATCH_REPORTS="${FLEET_DISPATCH_REPORTS:-$FLEET_DISPATCH_HOME/reports}"
# A report older than two host ticks (2 x 120 s) marks its host UNKNOWN and it is
# offered nothing (decision 3) — the end-of-run message is exactly the one a host
# that died never sends, so a quiet host must decay to unknown on the clock.
# Freshness is measured against OUR receipt time (stamped at ingest), never the
# host's own clock, so cross-host skew can never make a report look fresh.
FLEET_DISPATCH_REPORT_TTL="${FLEET_DISPATCH_REPORT_TTL:-240}"
# shadow|live. Slice 2 is shadow (dispatches nothing); slice 4 flips the default.
FLEET_DISPATCH_MODE="${FLEET_DISPATCH_MODE:-shadow}"
# The live-host allowlist (ADR 0009 rollout decision 6b/c / slice 4). It scopes,
# WHEN the dispatcher is live, which hosts it dispatches to for real and asks to
# stand their own tick down. Empty (the default) = fleet-wide live (stage 6c):
# every fresh host. A space-separated host list = live on THOSE hosts only (stage
# 6b): a placed pick on a listed host is dispatched for real and that host is
# acked `acting` (it stands its tick down); a placed pick on any other host is
# logged-only and that host keeps its own ADR 0007 tick. In shadow the list is
# irrelevant — nothing is dispatched or stood down anywhere. This is the one seam
# that makes "live on one host's slots" a reversible config flip; setting it (and
# FLEET_DISPATCH_MODE=live) are the one-way gos decision 6 reserves for a human.
FLEET_DISPATCH_LIVE_HOSTS="${FLEET_DISPATCH_LIVE_HOSTS:-}"

# ── runner-queue backpressure (#373) ─────────────────────────────────────────
# A free heavy slot on a host does NOT mean that host's forgejo-runner will pick
# a dispatched leg up soon: the runner is a SEPARATE resource (it also serves
# `runs-on: swarm` CI), and when it is saturated a dispatched swarm leg sits
# `waiting` past the #351 marker TTL while — in LIVE mode — the host's own tick
# has stood down (slice 3, #356), so nothing retries and the slot idles for the
# whole TTL (the 2026-11-19 policy-generators#113 stall: a dispatch to a host
# whose runner queue was ~an hour deep, never picked before the marker expired —
# #370). So before a LIVE pass offers a pick to a host, the dispatcher estimates
# that host's runner-queue lag from the tracker and treats a host whose oldest
# waiting leg is older than this ceiling as NOT free this pass — the pick falls
# to the next free host, or queues, with the lag named like any other unplaced
# pick. The host tick itself waits ~two ticks for a claim, so 240 s (two host
# ticks = the ack TTL) is a sensible ceiling. 0 disables the check (the pre-#373
# behaviour: every free slot is offerable). The read is a GET (`actions/runs?
# status=waiting`, GOTCHAS 78's queued-run view) so it is never a tracker WRITE,
# and the loop runs it LIVE-only, so a shadow pass makes no extra tracker calls.
FLEET_DISPATCH_QUEUE_LAG_MAX="${FLEET_DISPATCH_QUEUE_LAG_MAX:-240}"
# The bounded page the queued-run read pulls per repo — one page, like every other
# Actions-API read (the #28 ratchet forces page= + a curl timeout; GOTCHAS 16/78).
FLEET_DISPATCH_QUEUE_PAGE="${FLEET_DISPATCH_QUEUE_PAGE:-50}"

# _fleet_dispatch_now -> the current epoch, overridable so the offline test can
# pin "now" and craft fresh/stale reports deterministically.
_fleet_dispatch_now() { echo "${FLEET_DISPATCH_NOW:-$(date +%s)}"; }

# fleet_dispatch_reporting_hosts -> the hosts the dispatcher holds a FRESH report
# from, space-separated on one line (de-duplicated). These are the hosts a pick
# can be attributed to for the backpressure check — a host we cannot hear from is
# already `unknown` and offered nothing.
fleet_dispatch_reporting_hosts() {
  local f
  { for f in $(_fleet_dispatch_fresh_reports); do
      jq -r '.host // empty' "$f" 2>/dev/null
    done; } | sort -u | tr '\n' ' '
}

# _fleet_dispatch_waiting_runs <api-root> <slug> -> the repo's QUEUED runs as the
# forge's raw JSON on stdout (`actions/runs?status=waiting`, the ONE view a run
# with no task row yet appears in — GOTCHAS 78). rc 1 (no output) on a read
# failure, so the caller fails OPEN. Bounded on both axes the #28 ratchet cares
# about: `status=waiting` caps the result at the (tiny) live queue, and page=1 +
# --max-time cap the cost — so this is the admitted runs read, never the unbounded
# full listing (GOTCHAS 16). Shimmed in the offline test.
_fleet_dispatch_waiting_runs() {
  curl -sf --max-time "${FLEET_DISPATCH_QUEUE_MAX_TIME:-${FLEET_QUEUE_MAX_TIME:-30}}" \
    -H "Authorization: token ${FORGEJO_TOKEN:-}" \
    "$1/repos/$2/actions/runs?status=waiting&limit=${FLEET_DISPATCH_QUEUE_PAGE}&page=1" 2>/dev/null
}

# fleet_dispatch_lag_from_runs <runs-json> <now-epoch> <hosts> -> a JSON object
# {<host>: <max-lag-seconds>} over the hosts (space-separated) a waiting run is
# attributed to. A waiting run is attributed to host H when H appears as a whole
# token in the run's display_title or name: the per-host leg is `runs-on: <host>`
# (GOTCHAS 62), so a run still `waiting` names the host whose runner has not
# picked its leg. The lag is now - the run's created time (created / created_at /
# started, RFC3339). A run naming no known host, or whose time will not parse,
# contributes to NO host — fail-open: junk never inflates a lag, so it never
# withholds an offer. Pure (no disk, no clock, no network): trivially tested.
fleet_dispatch_lag_from_runs() {
  jq -c --argjson now "$2" --arg hosts "$3" '
    ($hosts | split(" ") | map(select(length > 0))) as $H
    | reduce (.workflow_runs // [])[] as $r ({};
        ((($r.created // $r.created_at // $r.started // "") | (try fromdateiso8601 catch null))) as $t
        | if $t == null then .
          else (((($r.display_title // "") + " " + ($r.name // "")) | [scan("[A-Za-z0-9_.-]+")])) as $toks
            | reduce $H[] as $h (.;
                if ($toks | index($h)) then
                  (($now - $t) as $lag | if $lag > (.[$h] // -1) then .[$h] = $lag else . end)
                else . end)
          end)
  ' <<<"$1" 2>/dev/null || echo '{}'
}

# fleet_dispatch_backed_off_hosts <lagmap-json> -> the hosts (one per line) whose
# measured lag meets or exceeds FLEET_DISPATCH_QUEUE_LAG_MAX. Empty output (no
# host backed off) when the check is disabled (MAX <= 0 / unset), the map is empty,
# or no host is over — so the pre-#373 behaviour (no backpressure) is "pass {}".
fleet_dispatch_backed_off_hosts() {
  local lagmap="${1:-}" max="${FLEET_DISPATCH_QUEUE_LAG_MAX:-0}"
  case "$max" in ''|*[!0-9]*) return 0 ;; esac
  [ "$max" -gt 0 ] || return 0
  [ -n "$lagmap" ] || return 0
  jq -r --argjson max "$max" \
    'to_entries[] | select((.value | type == "number") and .value >= $max) | .key' \
    <<<"$lagmap" 2>/dev/null || true
}

# _fleet_dispatch_host_backed_off <host> <lagmap-json> -> rc 0 iff <host>'s lag is
# at/over the ceiling (and the check is enabled). The single-host form host_lines
# uses to decide whether to annotate a host as backed off.
_fleet_dispatch_host_backed_off() {
  local host="$1" lagmap="${2:-}" max="${FLEET_DISPATCH_QUEUE_LAG_MAX:-0}" lag
  case "$max" in ''|*[!0-9]*) return 1 ;; esac
  [ "$max" -gt 0 ] || return 1
  [ -n "$lagmap" ] || return 1
  lag="$(jq -r --arg h "$host" '.[$h] // empty' <<<"$lagmap" 2>/dev/null)" || return 1
  case "$lag" in ''|*[!0-9]*) return 1 ;; esac
  [ "$lag" -ge "$max" ]
}

# _fleet_dispatch_host_ok <host> -> rc 0 iff <host> is a safe spool key: a
# non-empty run of [A-Za-z0-9._-] only. A report naming "a/../b" or an empty host
# must never pick the reports file it writes — the key becomes a path otherwise.
_fleet_dispatch_host_ok() {
  case "$1" in
    ''|*[!A-Za-z0-9._-]*) return 1 ;;
    *) return 0 ;;
  esac
}

# fleet_dispatch_ingest <report-json> -> validate one report and write it,
# keyed by host, into the reports dir with a received-at stamp. rc 1 (and one
# stderr line, no file) on junk: not an object, no safe host, no slots array.
# Atomic (write-tmp-rename), so a half-written file is never read by a pass.
fleet_dispatch_ingest() {
  local json="$1" host f
  printf '%s' "$json" | jq -e 'type == "object" and (.slots | type == "array")' >/dev/null 2>&1 || {
    echo "fleet-dispatch: ignoring a report that is not an object with a slots array" >&2; return 1; }
  host="$(printf '%s' "$json" | jq -r '.host // empty' 2>/dev/null)"
  if ! _fleet_dispatch_host_ok "$host"; then
    echo "fleet-dispatch: ignoring a report whose host is missing or unsafe ('${host}')" >&2; return 1
  fi
  mkdir -p "$FLEET_DISPATCH_REPORTS" 2>/dev/null || true
  f="$FLEET_DISPATCH_REPORTS/$host.json"
  printf '%s' "$json" | jq -c --argjson rx "$(_fleet_dispatch_now)" '. + {_received_at: $rx}' >"$f.tmp" 2>/dev/null \
    || { rm -f "$f.tmp"; echo "fleet-dispatch: could not write the report for $host" >&2; return 1; }
  mv -f "$f.tmp" "$f"
}

# fleet_dispatch_drain_inbox -> ingest every raw report the receiver spooled,
# then remove it (success OR reject — a malformed body dropped once never wedges
# the inbox). Echoes the count ingested. A report file still being written by the
# receiver is renamed into place atomically, so a partial read cannot happen.
fleet_dispatch_drain_inbox() {
  local f n=0 body
  [ -d "$FLEET_DISPATCH_INBOX" ] || { echo 0; return 0; }
  for f in "$FLEET_DISPATCH_INBOX"/*; do
    [ -f "$f" ] || continue
    body="$(cat "$f" 2>/dev/null)"
    # ADR 0010: a host's session DECLINE arrives on the same spool as its slot
    # reports. It is routed by its `kind`; the lane's own lib validates it.
    if command -v fleet_session_decline_ingest >/dev/null 2>&1 \
       && printf '%s' "$body" | jq -e 'type == "object" and .kind == "session-decline"' >/dev/null 2>&1; then
      fleet_session_decline_ingest "$body" >&2 || echo "fleet-dispatch: ignoring a malformed session decline" >&2
    elif fleet_dispatch_ingest "$body" 2>/dev/null; then n=$(( n + 1 )); fi
    rm -f "$f"
  done
  echo "$n"
}

# _fleet_dispatch_fresh_reports -> the path of every report whose receipt is
# within the TTL, one per line. A reports dir that does not exist yet is empty.
_fleet_dispatch_fresh_reports() {
  local f now rx
  [ -d "$FLEET_DISPATCH_REPORTS" ] || return 0
  now="$(_fleet_dispatch_now)"
  for f in "$FLEET_DISPATCH_REPORTS"/*.json; do
    [ -f "$f" ] || continue
    rx="$(jq -r '._received_at // 0' "$f" 2>/dev/null)" || continue
    case "$rx" in ''|*[!0-9]*) continue ;; esac
    [ $(( now - rx )) -lt "$FLEET_DISPATCH_REPORT_TTL" ] || continue
    printf '%s\n' "$f"
  done
}

# fleet_dispatch_free_slots [lagmap-json] -> a JSON array of the slots the
# dispatcher may offer this pass: every `free` slot on a FRESH host that holds no
# drive reservation (ruling E — a host with a drive waiting is offered nothing)
# AND whose runner queue is not backed up past the ceiling (#373 — a host whose
# leg would sit `waiting` is not free this pass). Each element is {host, n, path}.
# Host-then-slot ordered, so the allocation is deterministic (a run of the same
# inputs offers the same slots). A session slot and a usage-limit-parked slot are
# `busy` in the report and so never free here — ruling E's "respected the same
# way" falls straight out of the slot state. The lagmap is optional and defaults
# empty: a shadow pass (and the pre-#373 behaviour) passes nothing, so no host is
# ever withheld on queue backpressure.
fleet_dispatch_free_slots() {
  local f off
  off="$(fleet_dispatch_backed_off_hosts "${1:-}" | tr '\n' ' ')"
  {
    for f in $(_fleet_dispatch_fresh_reports | sort); do
      jq -c '
        if (.drive_reserved // false) then empty
        else (.host) as $h | .slots[]? | select(.state == "free")
             | {host: $h, n: .n, path: (.path // null)}
        end' "$f" 2>/dev/null
    done
  } | jq -s --arg off "$off" \
        '($off | split(" ") | map(select(length > 0))) as $x
         | map(select(.host as $h | ($x | index($h)) | not)) | sort_by(.host, .n)'
}

# fleet_dispatch_host_lines [lagmap-json] -> one human status line per host the
# dispatcher has heard from, for the shadow log's header: why each host offered
# what it did. A stale host is `unknown`; a drive-reserved host says so (ruling E);
# a host whose runner queue is backed up past the ceiling says so and is offered
# nothing (#373); a fresh host counts its free / busy / unknown slots. This is
# what lets the log answer "why was this ticket not offered a slot on host H".
# The lagmap is optional (defaults empty), so a shadow pass reads exactly as before.
fleet_dispatch_host_lines() {
  local f now rx host age dr slots line lagmap="${1:-}" lag
  [ -d "$FLEET_DISPATCH_REPORTS" ] || return 0
  now="$(_fleet_dispatch_now)"
  for f in $(ls -1 "$FLEET_DISPATCH_REPORTS"/*.json 2>/dev/null | sort); do
    [ -f "$f" ] || continue
    host="$(jq -r '.host // "?"' "$f" 2>/dev/null)"
    rx="$(jq -r '._received_at // 0' "$f" 2>/dev/null)"; case "$rx" in ''|*[!0-9]*) rx=0 ;; esac
    age=$(( now - rx ))
    if [ "$age" -ge "$FLEET_DISPATCH_REPORT_TTL" ]; then
      line="unknown — last report ${age}s ago (>= ${FLEET_DISPATCH_REPORT_TTL}s / 2 ticks), offered nothing"
    elif [ "$(jq -r '.drive_reserved // false' "$f" 2>/dev/null)" = true ]; then
      line="drive reservation held — offered nothing (ruling E)"
    elif _fleet_dispatch_host_backed_off "$host" "$lagmap"; then
      lag="$(jq -r --arg h "$host" '.[$h] // 0' <<<"$lagmap" 2>/dev/null)"
      line="runner queue backed up — oldest waiting leg ${lag}s old (>= ${FLEET_DISPATCH_QUEUE_LAG_MAX}s), offered nothing this pass (#373)"
    else
      slots="$(jq -r '[.slots[]?.state] | "\(map(select(.=="free"))|length) free, \(map(select(.=="busy"))|length) busy, \(map(select(.=="unknown"))|length) unknown"' "$f" 2>/dev/null)"
      # The per-host scope (stage 6b): is a placed pick on this host dispatched for
      # real, or logged-only with the host left on its own tick? Shown only when the
      # dispatcher is live, so a shadow pass reads exactly as before.
      if [ "${FLEET_DISPATCH_MODE:-shadow}" = live ]; then
        if _fleet_dispatch_host_is_live "$host"; then slots="$slots [live — dispatcher allocates]"
        else slots="$slots [shadow — on its own tick]"; fi
      fi
      line="$slots"
    fi
    printf '  %-24s %s\n' "$host" "$line"
  done
}

# ── one run per repo per host (#384) ─────────────────────────────────────────
# The swarm workflow holds a per-repo workdir lock for a whole run, so a host
# works at most ONE run of a given repo at a time: a second same-repo leg sent to
# its other free slot yields in seconds, nothing claims the ticket, and the pick
# is re-dispatched every marker TTL while the slot sits idle. The allocator
# therefore needs to know which (host, repo) pairs are taken. Two sources, both
# rebuildable hints (decision 2 — losing either only costs one wasted leg):
#   - a BUSY slot's holder on a fresh report (a session holder is skipped: the
#     session-runner works a dedicated checkout and takes no workdir lock);
#   - a pick this dispatcher placed in the last FLEET_DISPATCH_PLACED_TTL seconds
#     whose leg has not taken its slot yet (the slot still reads `free`).
FLEET_DISPATCH_PLACED_TTL="${FLEET_DISPATCH_PLACED_TTL:-180}"
_fleet_dispatch_placed_path() { printf '%s' "${FLEET_DISPATCH_PLACED:-$FLEET_DISPATCH_HOME/recent-placements}"; }

# fleet_dispatch_placed_record <repo> <host> <number> — remember a real dispatch. Also
# drops the entries past the TTL, so the file never grows. Best-effort.
fleet_dispatch_placed_record() {
  local f now at repo host num kept=""
  f="$(_fleet_dispatch_placed_path)"; now="$(_fleet_dispatch_now)"
  mkdir -p "$(dirname "$f")" 2>/dev/null || return 0
  if [ -s "$f" ]; then
    while read -r at repo host num; do
      case "$at" in ''|*[!0-9]*) continue ;; esac
      [ $(( now - at )) -lt "$FLEET_DISPATCH_PLACED_TTL" ] || continue
      kept="$kept$at $repo $host $num"$'\n'
    done <"$f"
  fi
  printf '%s%s %s %s %s\n' "$kept" "$now" "$1" "$2" "${3:-0}" >"$f.tmp" 2>/dev/null && mv -f "$f.tmp" "$f" 2>/dev/null || true
}

# fleet_dispatch_held_repos -> a JSON array of {host, repo, number}: every run a
# host holds or is about to hold. A pick of the same repo with a DIFFERENT number
# must not be placed on that host this pass (the ticket's own entry never blocks
# it — a re-offer of the same pick is the marker arbitration's business, #365).
# Never fails: an unreadable report or placements file contributes nothing.
fleet_dispatch_held_repos() {
  local f now at repo host num
  now="$(_fleet_dispatch_now)"
  {
    for f in $(_fleet_dispatch_fresh_reports | sort); do
      jq -c '(.host) as $h | .slots[]? | select(.state == "busy")
             | select((.holder.kind // "") != "session")
             | select((.holder.repo // "") != "")
             | {host: $h, repo: .holder.repo, number: (.issue // 0)}' "$f" 2>/dev/null
    done
    f="$(_fleet_dispatch_placed_path)"
    if [ -s "$f" ]; then
      while read -r at repo host num; do
        case "$at" in ''|*[!0-9]*) continue ;; esac
        [ -n "${host:-}" ] || continue
        case "${num:-}" in ''|*[!0-9]*) num=0 ;; esac
        [ $(( now - at )) -lt "$FLEET_DISPATCH_PLACED_TTL" ] || continue
        jq -cn --arg h "$host" --arg r "$repo" --argjson n "$num" '{host: $h, repo: $r, number: $n}'
      done <"$f"
    fi
  } | jq -s 'unique'
}

# fleet_dispatch_allocate <ordered-json> <free-slots-json> [held-json] [blocks-json]
# -> the allocation decisions, one per ready ticket in fleet order, as a JSON
# array of {repo, number, lane, placed, host, slot, reason, rank_index}. Walk the
# order; each ticket takes the FIRST free slot left that its lane allows:
#   - a SWARM ticket (no `lane`, or lane "swarm"): a slot whose host is not
#     already running a run of that ticket's repo (#384: <held-json> from
#     fleet_dispatch_held_repos, plus the placements made earlier in this pass);
#   - a SESSION ticket (lane "session", ADR 0010): a slot whose host no entry of
#     <blocks-json> rules out for it (fleet_session_blocks: a host's decline, an
#     offer still outstanding, a session already running for that repo there),
#     plus the session placements made earlier in this pass (one session per repo
#     per host). A session works a dedicated checkout, so the two lanes never
#     block each other on a host — they only compete for its slots.
# A ticket that gets no slot is QUEUED with a reason that says exactly why it was
# not offered sooner — nothing is free fleet-wide, the free slots went to higher
# picks, or the slots left are all on hosts its lane's rule excludes (for a
# session ticket the rule is quoted, so a host's decline reads in its own words).
# Pure (no disk, no clock): the caller passes the inventory in, so it is
# trivially tested. <held-json> and <blocks-json> default empty, and an order
# with no session ticket allocates exactly as it did before ADR 0010.
fleet_dispatch_allocate() {
  local order="$1" free="$2" held="${3:-[]}" blocks="${4:-[]}" nfree
  jq -e 'type == "array"' <<<"$held" >/dev/null 2>&1 || held='[]'
  jq -e 'type == "array"' <<<"$blocks" >/dev/null 2>&1 || blocks='[]'
  nfree="$(jq 'length' <<<"$free")"
  jq -c --argjson free "$free" --argjson nfree "$nfree" --argjson held "$held" --argjson blocks "$blocks" '
    reduce to_entries[] as $e ({free: $free, held: $held, blocks: $blocks, out: []};
      $e.key as $i | $e.value as $t | .held as $hd | .blocks as $bl
      | ($t.lane // "swarm") as $lane
      | ([.free | to_entries[]
          | . as $fe
          | ( if $lane == "session" then
                [$bl[] | select((.host == $fe.value.host or .host == "*")
                                and (.scope == "host"
                                     or (.scope == "repo" and .repo == $t.repo)
                                     or (.scope == "ticket" and .repo == $t.repo and (.number // 0) == $t.number)))
                       | (.reason // "ruled out")]
              else
                [$hd[] | select(.host == $fe.value.host and .repo == $t.repo and ((.number // 0) != $t.number))
                       | "already running a \($t.repo) run"]
              end ) as $why
          | $fe + {why: $why}]) as $cands
      | ([$cands[] | select((.why | length) == 0)] | .[0]) as $pick
      | (.free | length) as $left
      | if $pick != null then
          $pick.value as $s
          | .out += [{repo: $t.repo, number: $t.number, lane: $lane, placed: true, host: $s.host, slot: $s.n,
               rank_index: $i,
               reason: (if $i == 0 then "offered slot \($s.n) on \($s.host) (fleet head)"
                        else "offered slot \($s.n) on \($s.host) (\($i) higher pick(s) took the earlier free slot(s))" end)}]
          | .free |= del(.[$pick.key])
          | if $lane == "session" then
              .blocks += [{host: $s.host, scope: "repo", repo: $t.repo, number: $t.number,
                           reason: "\($s.host) was offered \($t.repo)#\($t.number) this pass (one session per repo per host)"}]
            else
              .held += [{host: $s.host, repo: $t.repo, number: $t.number}]
            end
        else
          .out += [{repo: $t.repo, number: $t.number, lane: $lane, placed: false, host: null, slot: null,
               rank_index: $i,
               reason: (if $nfree == 0 then "no free slot anywhere this pass (every pool slot busy, stale, or drive-reserved)"
                        elif $left == 0 then "no free slot — the \($nfree) free slot(s) went to the \($nfree) higher pick(s) ahead"
                        elif $lane == "session" then
                          "not placed — the \($left) free slot(s) left cannot take this session ticket: "
                          + ([$cands[].why[]] | unique | .[0:3] | join("; "))
                        else "not placed — the \($left) free slot(s) left are on host(s) already running a \($t.repo) run (one run per repo per host, #384)" end)}]
        end)
    | .out' <<<"$order"
}

# fleet_dispatch_format_decisions <decisions-json> -> the shadow log lines, one
# per decision: a placed pick names the slot it would be offered; a queued pick
# names why not sooner. This is the acceptance surface, so it reads for a human.
fleet_dispatch_format_decisions() {
  jq -r '.[] | select((.lane // "swarm") != "session") |
    if .placed then "  ALLOC  \(.repo)#\(.number) -> \(.host) slot \(.slot)  [\(.reason)]"
    else            "  QUEUE  \(.repo)#\(.number) -> (none)  [\(.reason)]" end' <<<"$1"
}

# _fleet_dispatch_host_is_live <host> -> rc 0 iff a run PLACED on <host> should be
# dispatched for real this pass: the dispatcher is in live mode AND (the live-host
# allowlist is empty -> fleet-wide, stage 6c; or <host> is named in it -> stage
# 6b). Every other case — shadow mode, or a host outside a non-empty allowlist —
# is shadow for that host (logged, never dispatched, left on its own tick).
_fleet_dispatch_host_is_live() {
  local host="$1" h
  [ "${FLEET_DISPATCH_MODE:-shadow}" = live ] || return 1
  [ -n "${FLEET_DISPATCH_LIVE_HOSTS:-}" ] || return 0
  for h in ${FLEET_DISPATCH_LIVE_HOSTS}; do
    [ "$h" = "$host" ] && return 0
  done
  return 1
}

# fleet_dispatch_host_mode <host> -> the effective start-a-run mode for <host>
# this pass: `live` iff _fleet_dispatch_host_is_live, else `shadow`. The loop
# passes this per placed pick (not the global FLEET_DISPATCH_MODE), so one
# dispatcher can be live for one host and shadow — host left on its own tick — for
# the rest. That is rollout stage 6b expressed as a per-pick decision.
fleet_dispatch_host_mode() {
  if _fleet_dispatch_host_is_live "$1"; then echo live; else echo shadow; fi
}

# fleet_dispatch_start_run <mode> <api-root> <slug> <n> <host> <slot> -> the
# ONE "start a run for pick P on host H" seam (ruling C). #204 later replaces
# this body with a hand-off to the host puller; nothing else in the dispatcher
# changes. In `shadow` it logs what it WOULD start and dispatches nothing
# (decision 6a) — rc 0 always. In `live` it rides fleet_queue_dispatch
# (workflow_dispatch, inputs.ticket + inputs.host), exactly as the host tick does
# today; that path is wired on by slice 4, never in shadow.
fleet_dispatch_start_run() {
  local mode="$1" root="$2" slug="$3" n="$4" host="$5" slot="$6" code
  case "$mode" in
    live)
      if code="$(fleet_queue_dispatch "$root" "$slug" "$n" "$host")"; then
        echo "fleet-dispatch: dispatched $slug#$n to $host (slot $slot)"
        return 0
      fi
      echo "fleet-dispatch: dispatch of $slug#$n to $host FAILED (http=$code)" >&2
      return 1 ;;
    *)
      echo "fleet-dispatch: SHADOW — would start $slug#$n on $host (slot $slot); dispatching nothing (ADR 0009 decision 6a)"
      return 0 ;;
  esac
}

# fleet_dispatch_arbitrate <api-root> <slug> <n> <target-host> — the dispatcher's
# cross-pass memory on the tracker (#365), reusing the #351 dispatch marker. The
# dispatcher holds nothing it cannot rebuild (ADR 0009 decision 2), so "I already
# offered this pick" cannot be a file on one host — it lives where every actor
# reads it: a `fleet-dispatch host=<target>` marker comment on the ticket. Called
# once per placed pick, in LIVE mode only (shadow must leave no mark), BEFORE the
# start-a-run seam. Globals, like fleet_queue_arbitrate (never `$(...)`):
#   rc 0  no live marker stands — this call POSTS one (host=<target>) and wins the
#         race with a concurrent peer tick; dispatch the pick. FLEET_DISPATCH_ARB_MARK
#         holds the new marker id (release it if the dispatch itself then fails).
#   rc 2  a live marker already stands — our own from a prior pass (the leg has not
#         claimed yet, so the slot is still `free` in the report) or a ticking peer
#         host's (#351). The ticket is ALREADY being dispatched: SKIP it, no second
#         run. FLEET_DISPATCH_ARB_HOLDER names the host. The marker frees itself at
#         FLEET_QUEUE_MARK_TTL, so an offer never taken does not wedge the ticket.
#   rc 1  a peer posted a lower marker in the same window: SKIP; FLEET_DISPATCH_ARB_HOLDER names it.
# Fails OPEN exactly like the host tick (fleet_queue_arbitrate): a tracker read or
# post failure returns rc 0 with an empty mark and one stderr line — a dispatch
# that goes out unarbitrated is still guarded by the claim; a stall is not.
#
# The dispatcher's rule deliberately DIFFERS from fleet_queue_arbitrate's: there a
# host that finds its OWN live marker re-dispatches (the host tick's stamp lapsed);
# here any live marker — own or peer — means skip, because the dispatcher's every
# ~17 s pass would otherwise re-fire the same pick until the leg claims. So the
# pre-check reads the marks and returns rc 2 on ANY of them before ever posting.
fleet_dispatch_arbitrate() {
  local root="$1" slug="$2" n="$3" host="$4" marks first_id first_host
  FLEET_DISPATCH_ARB_MARK=""; FLEET_DISPATCH_ARB_HOLDER=""
  if ! marks="$(fleet_queue_marks "$root" "$slug" "$n")"; then
    echo "fleet-dispatch: could not read the dispatch markers on $slug#$n — dispatching unarbitrated (the claim still guards it)" >&2
    return 0
  fi
  read -r first_id first_host <<<"$marks" || true
  if [ -n "${first_id:-}" ]; then
    FLEET_DISPATCH_ARB_HOLDER="$first_host"
    return 2
  fi
  # No marker stands: post ours (host=<target>) and win the #351 race with a peer.
  if fleet_queue_arbitrate "$root" "$slug" "$n" "$host"; then
    FLEET_DISPATCH_ARB_MARK="$FLEET_QUEUE_ARB_MARK"
    return 0
  fi
  FLEET_DISPATCH_ARB_HOLDER="$FLEET_QUEUE_ARB_HOLDER"
  return 1
}

fi
