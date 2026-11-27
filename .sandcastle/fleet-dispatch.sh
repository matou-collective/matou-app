#!/usr/bin/env bash
# fleet-dispatch.sh — the fleet dispatcher's entrypoint (ADR 0009, slice 2 /
# #355): one long-running loop on one host that holds the fleet-wide view and
# allocates the head pick to a free slot on a named host. In SHADOW (decision
# 6a, the default this slice ships) it LOGS each assignment and dispatches
# nothing; running it alongside the live host ticks for a few days and reading
# this log is the acceptance. The allocation logic lives in fleet-dispatch-lib.sh
# and the fleet order in fleet-queue-lib.sh; this is their entrypoint, run as:
#
#   once    one pass: drain the report inbox, rebuild the fleet order from the
#           tracker, read the fresh slot reports, allocate, and LOG — which pick
#           goes to which slot on which host, and for every ticket that is not
#           placed, why not sooner. Dispatches nothing in shadow. Exit 0.
#   loop    `once` every FLEET_DISPATCH_INTERVAL seconds (the standing service).
#   serve   launch the HTTP receiver (fleet-dispatch-receiver.py) in the
#           background to accept hosts' slot-report POSTs into the inbox, then
#           run `loop` in the foreground; the receiver is killed on exit. This is
#           the one-process shape a systemd unit runs (docs/deploy/fleet-dispatcher.md).
#   ingest  read one report JSON on stdin and spool it (manual / testing).
#
# Nothing here is a one-way door: shadow dispatches nothing, and turning the
# dispatcher off is stopping the process — the hosts' own ticks carry on
# untouched (decision 4). Pointing a host's FLEET_DISPATCHER_URL at this
# receiver, and later flipping FLEET_DISPATCH_MODE=live (slice 4), are the staged
# gos ADR 0009 decision 6 reserves for a human.
#
# Env: FLEET_QUEUE_REPOS="<checkout>:<owner/repo> ..." (the same host-registry
#      pairs the fleet-queue tick reads — the dispatcher's fleet is the repos its
#      host serves), FORGEJO_TOKEN (else the first checkout's bind-mounted
#      secret), FLEET_DISPATCH_MODE (shadow|live, default shadow),
#      FLEET_DISPATCH_INTERVAL (loop seconds, default 10), and for `serve` the
#      receiver's FLEET_DISPATCH_PORT / FLEET_DISPATCH_BIND / FLEET_DISPATCH_TOKEN.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=fleet-queue-lib.sh
. "$here/fleet-queue-lib.sh"
# shellcheck source=fleet-dispatch-lib.sh
. "$here/fleet-dispatch-lib.sh"
# shellcheck source=fleet-landing-detect-lib.sh
. "$here/fleet-landing-detect-lib.sh"

mode="${1:-once}"; [ $# -gt 0 ] && shift
case "$mode" in once|loop|serve|ingest) ;; *) echo "usage: fleet-dispatch.sh {once|loop|serve|ingest}" >&2; exit 2 ;; esac

FLEET_DISPATCH_INTERVAL="${FLEET_DISPATCH_INTERVAL:-10}"
# Landing detection (ADR 0009 slice 5 / #358): on by default, throttled to its
# own cadence so the per-repo tracker reads it needs do not fire on every 10 s
# allocation pass. The stamp is the ONLY extra on-disk state and is trivially
# rebuildable (lose it and detection runs next pass), so decision 2's "nothing it
# cannot rebuild" still holds. INTERVAL=0 runs detection every pass.
FLEET_DISPATCH_DETECT="${FLEET_DISPATCH_DETECT:-on}"
FLEET_DISPATCH_DETECT_INTERVAL="${FLEET_DISPATCH_DETECT_INTERVAL:-120}"

# The dispatch-arbitration markers (#351) the live dispatcher posts to remember
# which picks it already offered (#365). Scoped to the dispatcher's OWN spool so
# its marker bookkeeping never shares a file with a co-located host tick's. The
# markers themselves live on the tracker (decision 2); this file only records ours
# so the sweep/release can find them.
export FLEET_QUEUE_MARKS="${FLEET_QUEUE_MARKS:-$FLEET_DISPATCH_HOME/fleet-queue-marks}"

if [ "$mode" = ingest ]; then
  fleet_dispatch_ingest "$(cat)"
  exit $?
fi

# ── the token ladder (same as fleet-queue.sh): env, else the first checkout's
# bind-mounted secret. Never on argv or a URL. ──────────────────────────────
: "${FLEET_QUEUE_REPOS:?set FLEET_QUEUE_REPOS to '<checkout>:<owner/repo> ...' (the generated host wiring does)}"
read -ra repos <<<"$FLEET_QUEUE_REPOS"
[ "${#repos[@]}" -gt 0 ] || { echo "fleet-dispatch: FLEET_QUEUE_REPOS is empty — nothing to allocate over" >&2; exit 2; }
first_checkout="${repos[0]%%:*}"
if [ -z "${FORGEJO_TOKEN:-}" ]; then
  for f in "$first_checkout/.sandcastle/secrets/forgejo_token" "$first_checkout/secrets/forgejo_token"; do
    [ -f "$f" ] && { FORGEJO_TOKEN="$(cat "$f")"; break; }
  done
fi
export FORGEJO_TOKEN="${FORGEJO_TOKEN:-}"

# _fleet_dispatch_queue_lagmap -> the per-host runner-queue lag map (#373) as a
# JSON object {<host>: <max-lag-seconds>}, merged across every fleet repo. Reads
# each repo's QUEUED runs (`actions/runs?status=waiting`, GOTCHAS 78) over its OWN
# identity's api root, attributes each waiting run to the host whose leg it names,
# and keeps the MAX lag per host. Bounded: one page per repo, each curl-timed, and
# fail-OPEN per repo — a repo whose read fails contributes nothing, so a tracker
# blip never backs a host off (never withholds an offer). Called LIVE-only (the
# loop gates it), so a shadow pass makes no extra tracker reads. Lives here, not
# in the lib, because it fans out over `repos` + per-checkout api roots like the
# detection gather; the single curl and the pure attribution it rides are the
# tested halves in the lib.
_fleet_dispatch_queue_lagmap() {
  local hosts now pair checkout slug root runs sub map='{}'
  hosts="$(fleet_dispatch_reporting_hosts)"
  [ -n "${hosts// /}" ] || { printf '%s' '{}'; return 0; }
  now="$(date +%s)"
  for pair in "${repos[@]}"; do
    checkout="${pair%%:*}"; slug="${pair#*:}"
    root="$(fleet_queue_api_root "$checkout" 2>/dev/null)" || continue
    if ! runs="$(_fleet_dispatch_waiting_runs "$root" "$slug")"; then
      echo "fleet-dispatch: could not read $slug queued runs — not backing any host off on its account (fail-open)" >&2
      continue
    fi
    [ -n "$runs" ] || continue
    sub="$(fleet_dispatch_lag_from_runs "$runs" "$now" "$hosts")"
    [ -n "$sub" ] || sub='{}'
    map="$(jq -cn --argjson a "$map" --argjson b "$sub" \
      'reduce (($a | keys_unsorted) + ($b | keys_unsorted))[] as $k ({};
         .[$k] = ([$a[$k], $b[$k]] | map(select(. != null)) | max))' 2>/dev/null || printf '%s' "$map")"
  done
  printf '%s' "$map"
}

# one allocation pass — the acceptance surface
fleet_dispatch_once() {
  local api_root merged ordered free dec total now lagmap='{}'
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  fleet_dispatch_drain_inbox >/dev/null

  if ! api_root="$(fleet_queue_api_root "$first_checkout")"; then
    echo "fleet-dispatch [$now]: no identity layer under $first_checkout — cannot name the forge; skipping this pass" >&2
    return 0
  fi

  # Sweep our own EXPIRED dispatch markers (#365/#351) before this pass: a marker
  # past FLEET_QUEUE_MARK_TTL holds nothing and is only litter on the thread. No
  # tracker call when none is recorded, and only live passes ever record any.
  if [ -s "$(fleet_queue_marks_path)" ]; then
    fleet_queue_marks_sweep "$api_root" || true
  fi

  # Runner-queue backpressure (#373): LIVE-only and read-only. Before a live pass
  # offers a pick to a host, estimate that host's runner-queue lag from the tracker
  # and drop a host over the ceiling from the free slots (the pick then falls to the
  # next free host or queues, with the lag named in the host line). Shadow does not
  # read it (it offers nothing), so a shadow pass makes no extra tracker calls.
  if [ "$FLEET_DISPATCH_MODE" = live ] && [ "${FLEET_DISPATCH_QUEUE_LAG_MAX:-0}" -gt 0 ] 2>/dev/null; then
    lagmap="$(_fleet_dispatch_queue_lagmap)"
  fi

  merged="$(fleet_queue_collect "${repos[@]}")"
  ordered="$(fleet_queue_order "$merged")"
  free="$(fleet_dispatch_free_slots "$lagmap")"
  dec="$(fleet_dispatch_allocate "$ordered" "$free")"
  total="$(jq length <<<"$ordered")"

  echo "fleet-dispatch [$now] mode=$FLEET_DISPATCH_MODE${FLEET_DISPATCH_LIVE_HOSTS:+ (live hosts: $FLEET_DISPATCH_LIVE_HOSTS)}: $total ready fleet-wide, $(jq length <<<"$free") free slot(s)"
  echo "fleet-dispatch [$now] hosts:"
  fleet_dispatch_host_lines "$lagmap"
  echo "fleet-dispatch [$now] allocation:"
  fleet_dispatch_format_decisions "$dec"

  # The start-a-run seam, once per placed pick (ruling C). The mode is decided PER
  # HOST (fleet_dispatch_host_mode), not from the global FLEET_DISPATCH_MODE: in
  # stage 6b (live scoped to one host) a pick on that host dispatches for real
  # while a pick on any other host is logged-only, the host left on its own tick.
  # Shadow logs "would start" and dispatches nothing; empty allowlist in live mode
  # is fleet-wide (stage 6c).
  local i n repo number host slot hmode arb
  n="$(jq '[.[]|select(.placed)]|length' <<<"$dec")"
  for (( i = 0; i < n; i++ )); do
    repo="$(jq -r "[.[]|select(.placed)][$i].repo" <<<"$dec")"
    number="$(jq -r "[.[]|select(.placed)][$i].number" <<<"$dec")"
    host="$(jq -r "[.[]|select(.placed)][$i].host" <<<"$dec")"
    slot="$(jq -r "[.[]|select(.placed)][$i].slot" <<<"$dec")"
    hmode="$(fleet_dispatch_host_mode "$host")"
    if [ "$hmode" != live ]; then
      # Shadow for this host: log the would-start and post NOTHING to the tracker
      # (shadow must leave no mark — no arbitration, no marker comment).
      fleet_dispatch_start_run shadow "$api_root" "$repo" "$number" "$host" "$slot" || true
      continue
    fi
    # Live: arbitrate on the tracker FIRST (#365). A pick that already carries a
    # live dispatch marker — our own from a prior pass (the leg has not claimed, so
    # the slot still reads `free`) or a peer host's tick (#351) — is skipped, so one
    # ready ticket + one free slot no longer fire a fresh run every ~17 s pass.
    arb=0; fleet_dispatch_arbitrate "$api_root" "$repo" "$number" "$host" || arb=$?
    case "$arb" in
      2) echo "fleet-dispatch [$now]: SKIP $repo#$number -> $host slot $slot — a live dispatch marker (host=$FLEET_DISPATCH_ARB_HOLDER) already holds it; not re-dispatching until it claims or the marker expires" ;;
      1) echo "fleet-dispatch [$now]: SKIP $repo#$number -> $host slot $slot — a peer host ($FLEET_DISPATCH_ARB_HOLDER) is already dispatching it (#351)" ;;
      *) if ! fleet_dispatch_start_run live "$api_root" "$repo" "$number" "$host" "$slot"; then
           # Nothing is running for this pick: release our marker now so the next
           # pass retries rather than waiting out the TTL (the host tick's rule).
           [ -z "${FLEET_DISPATCH_ARB_MARK:-}" ] || fleet_queue_mark_release "$api_root" "$FLEET_DISPATCH_ARB_MARK"
         fi ;;
    esac
  done

  # Landing detection is NOT run here (#363): a pass's per-repo tracker reads can
  # take minutes, and run inline they would stall the allocator for most of every
  # cycle (a freed slot must refill "in seconds", ADR 0009 ruling A) and defer
  # SIGTERM until a read in flight returns. The loop forks it on its own cadence
  # (fleet_dispatch_detect_maybe_fork); the `once` CLI runs it synchronously after
  # this pass returns. Detection runs AFTER allocation either way (decision 5).
  return 0
}

# _fleet_dispatch_detect_stamp / _due / _touch — the throttle. The stamp is a
# single epoch line under the spool root; absent or older than the interval means
# "run detection this pass" (INTERVAL=0 = every pass).
_fleet_dispatch_detect_stamp() { printf '%s' "${FLEET_DISPATCH_DETECT_STAMP:-$FLEET_DISPATCH_HOME/detect-stamp}"; }
_fleet_dispatch_detect_due() {
  local f age last
  case "$FLEET_DISPATCH_DETECT_INTERVAL" in ''|*[!0-9]*) return 0 ;; esac
  [ "$FLEET_DISPATCH_DETECT_INTERVAL" -le 0 ] && return 0
  f="$(_fleet_dispatch_detect_stamp)"; [ -s "$f" ] || return 0
  last="$(cat "$f" 2>/dev/null || echo 0)"; case "$last" in ''|*[!0-9]*) return 0 ;; esac
  age=$(( $(date +%s) - last )); [ "$age" -ge "$FLEET_DISPATCH_DETECT_INTERVAL" ]
}
_fleet_dispatch_detect_touch() {
  local f; f="$(_fleet_dispatch_detect_stamp)"; mkdir -p "$(dirname "$f")" 2>/dev/null || true
  date +%s >"$f.tmp" 2>/dev/null && mv -f "$f.tmp" "$f" 2>/dev/null || true
}

# _fleet_dispatch_detect_run — the body of ONE landing-detection pass (ADR 0009
# slice 5), with NO due/throttle gate (the callers gate + stamp). It gathers the
# facts (recently-closed tickets' landing state, the agent-working set, the fleet's
# busy holders, sandcastle/rescue-* branches, and green agent PRs on agent-after-green
# repos), runs the PURE detector, LOGS every anomaly with its evidence, and files each
# at the FRONT of the fleet queue via the mode-gated seam (shadow logs + files nothing;
# live files a `priority` ticket, idempotently). Thin glue over fleet-landing-detect-
# lib.sh; every gather fails safe, so a tracker blip surfaces nothing. Its per-repo
# reads can take minutes, so it is run OFF the allocation path (forked by the loop,
# synchronous only for the `once` CLI) — #363.
_fleet_dispatch_detect_run() {
  local now; now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  # live refs: every busy holder across the FRESH slot reports -> [{repo,issue}].
  # reports_seen gates case 2 (working-no-run): a cold-started dispatcher that holds
  # NO fresh report from any host must flag nothing (#363), since it cannot tell a
  # dead run from a live one it simply has not heard from yet.
  local f live reports_seen=false
  [ -n "$(_fleet_dispatch_fresh_reports)" ] && reports_seen=true
  live="$( { for f in $(_fleet_dispatch_fresh_reports); do
               jq -c '.slots[]? | select(.state=="busy") | {repo:(.holder.repo // null), issue:.issue}' "$f" 2>/dev/null
             done; } | jq -cs 'map(select(.issue != null))' 2>/dev/null || echo '[]')"
  [ -n "$live" ] || live='[]'

  local closes='[]' working='[]' rescues='[]' prs='[]' roots='{}'
  local pair checkout slug root auth rows row n cat commits unreached w r3 p4
  for pair in "${repos[@]}"; do
    checkout="${pair%%:*}"; slug="${pair#*:}"
    if ! root="$(fleet_queue_api_root "$checkout" 2>/dev/null)"; then
      echo "fleet-landing [$now]: no identity layer under $checkout for $slug — skipping it this pass" >&2; continue
    fi
    roots="$(jq -c --arg s "$slug" --arg r "$root" '. + {($s): $r}' <<<"$roots")"
    # Refresh the checkout's refs so origin/main AND any still-present worker/agent
    # branch are current — a by-SHA or patch-id landing witness is only as good as
    # the refs the checkout holds (#363). Best-effort; a fetch failure just means
    # this pass judges against whatever the checkout already has.
    git -C "$checkout" fetch -q origin 2>/dev/null || true

    # case 1: recently-closed tickets whose claimed work is not on main. A close
    # younger than the grace window may still be landing (#363) — skip it. The
    # landed test (fleet_landing_unlanded) is sha-rewrite-robust: ancestry, then
    # patch-id, then an #N-on-main reference, so a rebase/squash/merge land is not
    # mistaken for a strand.
    rows="$(_fleet_landing_api "$root/repos/$slug/issues?state=closed&type=issues&sort=recentupdate&limit=$FLEET_LANDING_CLOSED_SCAN" 2>/dev/null \
      | jq -r '.[]? | "\(.number)\t\(.closed_at // "")"' 2>/dev/null || true)"
    while IFS=$'\t' read -r n cat; do
      case "$n" in ''|*[!0-9]*) continue ;; esac
      _fleet_landing_close_recent "$cat" && continue   # still inside the land grace
      commits="$(fleet_landing_close_commits "$root" "$slug" "$n" 2>/dev/null || true)"
      [ -n "$commits" ] || continue
      unreached="$(fleet_landing_unlanded "$checkout" "$FLEET_LANDING_MAIN_REF" "$commits" "$n" 2>/dev/null || true)"
      [ -n "$unreached" ] || continue
      closes="$(jq -c --arg r "$slug" --argjson n "$n" \
        --argjson c "$(printf '%s' "$commits" | jq -R 'split(" ")|map(select(length>0))')" \
        --argjson u "$(printf '%s' "$unreached" | jq -R 'split(" ")|map(select(length>0))')" \
        '. + [{repo:$r, number:$n, commits:$c, unreached:$u}]' <<<"$closes")"
    done <<<"$rows"

    w="$(fleet_landing_working "$root" "$slug" 2>/dev/null || echo '[]')"
    working="$(jq -c --argjson w "${w:-[]}" '. + $w' <<<"$working")"
    r3="$(fleet_landing_rescues "$root" "$slug" "$checkout" "$FLEET_LANDING_MAIN_REF" 2>/dev/null || echo '[]')"
    rescues="$(jq -c --argjson r "${r3:-[]}" '. + $r' <<<"$rescues")"
    auth="$(fleet_landing_merge_authority "$checkout")"
    if [ "$auth" = agent-after-green ]; then
      p4="$(fleet_landing_agent_prs "$root" "$slug" 2>/dev/null || echo '[]')"
      prs="$(jq -c --argjson p "${p4:-[]}" '. + $p' <<<"$prs")"
    fi
  done

  local facts anoms count i a arepo rootv
  facts="$(jq -cn --argjson c "$closes" --argjson w "$working" --argjson l "$live" \
    --argjson rs "$reports_seen" --argjson r "$rescues" --argjson p "$prs" \
    '{closes:$c, working:$w, live:$l, reports_seen:$rs, rescues:$r, prs:$p}')"
  anoms="$(fleet_landing_detect "$facts")"

  count="$(jq length <<<"$anoms" 2>/dev/null || echo 0)"
  echo "fleet-landing [$now] mode=$FLEET_DISPATCH_MODE: $count landing anomaly(ies) detected"
  [ "${count:-0}" -gt 0 ] || return 0
  fleet_landing_format "$anoms"
  for (( i = 0; i < count; i++ )); do
    a="$(jq -c ".[$i]" <<<"$anoms")"
    arepo="$(jq -r '.repo' <<<"$a")"
    rootv="$(jq -r --arg s "$arepo" '.[$s] // ""' <<<"$roots")"
    [ -n "$rootv" ] || continue
    fleet_landing_file "$FLEET_DISPATCH_MODE" "$rootv" "$arepo" "$a" || true
  done
  return 0
}

# fleet_dispatch_detect_once — the SYNCHRONOUS detection pass: DETECT on + due +
# stamp + run, in the foreground. Used by the `once` CLI (and its offline test),
# where a single pass to stdout is the whole point. The loop uses the forking form.
fleet_dispatch_detect_once() {
  [ "${FLEET_DISPATCH_DETECT:-on}" = on ] || return 0
  _fleet_dispatch_detect_due || return 0
  _fleet_dispatch_detect_touch
  _fleet_dispatch_detect_run
}

# fleet_dispatch_detect_maybe_fork — the LOOP's detection launcher (#363). When a
# pass is due and none is already running, stamp NOW (so the next allocation pass
# does not relaunch while this one runs) and FORK the pass into the background, so
# the allocator keeps its cadence and SIGTERM is never deferred behind a tracker
# read in flight. One at a time: a pass still running past the interval is left to
# finish rather than stacked. _fleet_detect_pid is read by the loop's shutdown trap.
fleet_dispatch_detect_maybe_fork() {
  [ "${FLEET_DISPATCH_DETECT:-on}" = on ] || return 0
  _fleet_dispatch_detect_due || return 0
  if [ -n "${_fleet_detect_pid:-}" ] && kill -0 "$_fleet_detect_pid" 2>/dev/null; then
    echo "fleet-landing: previous detection pass (pid $_fleet_detect_pid) still running — not stacking another" >&2
    return 0
  fi
  _fleet_dispatch_detect_touch
  _fleet_dispatch_detect_run &
  _fleet_detect_pid=$!
  # disown it from the job table: a RUNNING background child is inherited by the
  # command-substitution subshells the next allocation pass spawns (fleet_queue_collect
  # ends in a bare `wait`), and that bare `wait` spins on the inherited pid it cannot
  # reap — starving the allocator and deferring SIGTERM (#363). disown keeps the pid
  # (we still kill it on shutdown) but hides the job; bash still reaps it on SIGCHLD.
  disown "$_fleet_detect_pid" 2>/dev/null || true
}

# `serve` = launch the dumb receiver (auth + spool the POST body, nothing else)
# in the background, then run the loop in THIS process so the kill-on-exit trap
# survives (an `exec` here would orphan the receiver). It inherits
# FLEET_DISPATCH_INBOX / FLEET_DISPATCH_TOKEN / _PORT / _BIND.
if [ "$mode" = serve ]; then
  mkdir -p "$FLEET_DISPATCH_INBOX" "$FLEET_DISPATCH_REPORTS"
  # Export what the receiver reads from the environment: the inbox it spools into,
  # the MODE its acknowledgement reflects, and the live-host allowlist that scopes
  # WHICH host the acknowledgement stands down (ADR 0009 decision 4 / 6b, #356).
  # All three may be defaulted in the lib rather than set in the operator's env, so
  # a bare assignment would not reach the subprocess — the ack must match the
  # posture the loop runs in (shadow acks acting=false; live acks acting=true only
  # for a host the loop actually dispatches to, so stage 6b stands down one host).
  export FLEET_DISPATCH_INBOX FLEET_DISPATCH_MODE FLEET_DISPATCH_LIVE_HOSTS
  python3 "$here/fleet-dispatch-receiver.py" &
  _rx=$!
  mode=loop
fi

# The loop's shutdown: a SIGTERM/SIGINT (e.g. `systemctl restart`) must stop the
# loop promptly and reap BOTH children — the receiver and any forked detection pass
# (#363: detection no longer runs inline, so a read in flight never defers the stop).
_fleet_dispatch_shutdown() {
  trap - TERM INT EXIT
  kill "${_fleet_detect_pid:-}" 2>/dev/null || true
  kill "${_rx:-}" 2>/dev/null || true
  exit 0
}

case "$mode" in
  once) fleet_dispatch_once; fleet_dispatch_detect_once || true ;;
  loop)
    trap _fleet_dispatch_shutdown TERM INT EXIT
    echo "fleet-dispatch: starting the $FLEET_DISPATCH_MODE loop (every ${FLEET_DISPATCH_INTERVAL}s) over ${#repos[@]} repo(s)"
    while :; do
      fleet_dispatch_once || true
      fleet_dispatch_detect_maybe_fork || true
      # sleep as a reaped background job so a TERM/INT fires the trap at once rather
      # than waiting out the interval (a bare `sleep` defers the signal until it ends).
      sleep "$FLEET_DISPATCH_INTERVAL" & wait $! 2>/dev/null || true
    done ;;
esac
exit 0
