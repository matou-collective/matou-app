#!/usr/bin/env bash
# fleet-slot-report-lib.sh — a pool host's slot report (ADR 0009, slice 1 / #354).
#
# ADR 0009 proposes one dispatcher that allocates fleet-queue picks to free
# heavy slots fleet-wide. Its picture is DERIVED every pass from two sources it
# does not own: the tracker, and the hosts (decision 2). This library is the
# second of those — the host's half of the "slot truth stays on the host; hosts
# report it, event-first" contract (decision 3). It builds ONE description of a
# host's slots and pushes it over the mesh at the three moments of ruling A:
#
#   take   a run takes a heavy slot         (run-swarm.sh, after the holder write)
#   end    a run ends                       (fleet-queue.sh after-close / rearm —
#                                            the end-of-ticket self-rearm seam)
#   tick   the host's two-minute tick       (fleet-queue.sh tick)
#
# take and end make the dispatcher react in seconds; the tick is what keeps it
# correct, because the end message is exactly the one a host that died never
# sends (ruling A). This slice DISPATCHES NOTHING — it only produces the reports
# slice 2's dispatcher will consume, and the push is a best-effort no-op until a
# host declares FLEET_DISPATCHER_URL. So turning it on is a one-way switch a
# human throws (ADR 0009 decision 6's staged rollout); landing the producer is a
# two-way door.
#
# ── one description of a host's slots ────────────────────────────────────────
# The report's per-slot shape is DELIBERATELY the shape fleet-tui already uses
# for a host's slots (snapshot._slots -> collector._host_rows / _holder): a slot
# carries {n, path, state, issue, iteration, holder}, where state is
# free|busy|unknown and holder is null or {kind, repo, worker, since, pid,
# pid_alive, ref}. So the dispatcher AND the Floor read one shape, never two
# that drift — tests/fleet-slot-report-contract-test.sh proves the bash producer
# here feeds fleet-tui's own collector._host_rows unchanged. Extra keys (path,
# pid, pid_alive, ref) are a superset the collector ignores and the dispatcher
# needs; the report wraps the slots with {report_version, event, host, now,
# drive_reserved, ended}.
#
# Slot truth is the flock, read from /proc/locks WITHOUT taking a lock (the #138
# lesson that moved fleet-tui's probe off a grab-and-release probe: an exclusive
# harness acquire landing in the probe's microsecond window read a free slot as
# busy). The holder sidecar is only a LABEL beside a held lock (GOTCHAS 42); a
# label beside a FREE lock is a crash leftover and is ignored, exactly as
# snapshot._slots does. No repo name, host or product path lives here: the host
# is resolved from the env, the slots from HOST_CAPACITY_SLOTS, and the
# dispatcher address from a host-declared FLEET_DISPATCHER_URL — never defaulted
# to any product (CLAUDE.md blast radius).
#
# Offline-tested by tests/fleet-slot-report-lib-test.sh (a crafted /proc/locks,
# fake holder sidecars, a shimmed curl) and the both-ends contract test above;
# run-swarm.sh's inline wiring rides main.mts and cannot run in the offline bash
# suite, so the shape is proven at both ends instead (the main-mts-offline rule).

if [ -z "${__SWARM_FLEET_SLOT_REPORT_LIB:-}" ]; then
__SWARM_FLEET_SLOT_REPORT_LIB=1

_FLEET_SLOT_REPORT_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The holder-sidecar paths + the drive-reservation predicate live in
# host-capacity-lib.sh; HOST_CAPACITY_SLOTS is its list of pooled slot locks.
# It has no source guard but is idempotent — a caller that already sourced it
# (run-swarm.sh, fleet-queue-lib.sh) keeps its own state.
if ! command -v host_capacity_drive_wanted >/dev/null 2>&1; then
  # shellcheck source=host-capacity-lib.sh
  . "$_FLEET_SLOT_REPORT_HERE/host-capacity-lib.sh"
fi

# The shape version. Bump on any change to the report SHAPE below; the
# dispatcher (slice 2) and the contract test both read it, so a shape change is
# a version bump neither side can miss, never a silent rename (the probe.py /
# collector SNAPSHOT_VERSION precedent).
FLEET_SLOT_REPORT_VERSION="${FLEET_SLOT_REPORT_VERSION:-1}"

# The dispatcher endpoint, host-declared (empty = no dispatcher, the fleet runs
# on its own ticks — ADR 0009 decision 4). A host sets this (and optionally a
# bearer token) in its own env; the harness never defaults it to any address.
FLEET_DISPATCHER_URL="${FLEET_DISPATCHER_URL:-}"
FLEET_DISPATCHER_TOKEN="${FLEET_DISPATCHER_TOKEN:-}"
FLEET_SLOT_REPORT_MAX_TIME="${FLEET_SLOT_REPORT_MAX_TIME:-10}"
# The kernel lock table; overridable so the offline test can craft one (the
# probe.py seam — a host-side fact that is only real on Linux).
FLEET_SLOT_REPORT_PROC_LOCKS="${FLEET_SLOT_REPORT_PROC_LOCKS:-/proc/locks}"

# ── the dispatcher's acknowledgement (ADR 0009 decision 4 / #356) ────────────
# The dispatcher answers every slot report; a LIVE dispatcher's answer says it is
# ACTING on the report — it holds the fleet view and will allocate this host's
# free slots itself. A host whose last report drew a FRESH acting-ack leaves
# allocation to the dispatcher and stands its own fleet-queue tick down
# (fleet-queue.sh reads fleet_slot_report_acked_fresh). The moment the acks stop
# — the dispatcher died, was stopped, or only ever shadowed — the ack goes stale
# and the host resumes today's tick within one heartbeat window, arbitrated by
# the #351 dispatch marker. The report and its answer ARE the heartbeat: no
# global clock is distributed, and the dispatcher is never a single point of
# failure (decision 4). "Live on one host's slots" (decision 6b) needs no mode of
# its own — only the hosts that set FLEET_DISPATCHER_URL report to, and defer to,
# the dispatcher; a host that leaves it unset never hears an ack and keeps ticking.
#
# Freshness is the HOST's own receipt time (stamped here on a 2xx), never the
# dispatcher's clock — the same cross-skew rule the dispatcher applies to reports.
# The TTL is only a safety net for a host that stopped emitting at all: a FAILED
# or non-2xx push records a DEAD ack, so the next tick resumes at once rather than
# waiting out the TTL. Keyed under the host state dir; never a product literal.
FLEET_DISPATCH_ACK_STATE="${FLEET_DISPATCH_ACK_STATE:-$HOST_CAPACITY_STATE_DIR/fleet-dispatch-ack}"
FLEET_DISPATCH_ACK_TTL="${FLEET_DISPATCH_ACK_TTL:-240}"

# _fleet_slot_report_now -> the current epoch, overridable so the offline test can
# pin "now" and age the ack deterministically (the dispatcher's _now precedent).
_fleet_slot_report_now() { echo "${FLEET_SLOT_REPORT_NOW:-$(date +%s)}"; }

# _fleet_slot_report_record_ack <ok-bool> <acting-bool> — write the ack state
# atomically (our receipt time, whether the push landed, whether the dispatcher
# said it is acting). Best-effort: a write failure leaves the previous state,
# which ages out on the TTL. Never reds a tick (its callers run under set -e).
_fleet_slot_report_record_ack() {
  local ok="$1" acting="$2" f="$FLEET_DISPATCH_ACK_STATE"
  mkdir -p "$(dirname "$f")" 2>/dev/null || true
  if printf '%s %s %s\n' "$(_fleet_slot_report_now)" "$ok" "$acting" >"$f.tmp" 2>/dev/null; then
    mv -f "$f.tmp" "$f" 2>/dev/null || rm -f "$f.tmp" 2>/dev/null || true
  else
    rm -f "$f.tmp" 2>/dev/null || true
  fi
}

# fleet_slot_report_acked_fresh -> rc 0 iff the host's most recent slot report
# drew a FRESH acting-ack (the push landed, the dispatcher said acting=true, and
# it arrived within the TTL). The fleet-queue tick reads this to stand its own
# dispatch down (decision 4). rc 1 — resume today's tick — on ANY of: no ack
# file, a malformed line, a dead ack (push failed), a not-acting ack (dispatcher
# in shadow), or an ack older than the TTL.
fleet_slot_report_acked_fresh() {
  local f="$FLEET_DISPATCH_ACK_STATE" at ok acting age
  [ -s "$f" ] || return 1
  read -r at ok acting <"$f" || return 1
  case "$at" in ''|*[!0-9]*) return 1 ;; esac
  [ "$ok" = true ] && [ "$acting" = true ] || return 1
  age=$(( $(_fleet_slot_report_now) - at ))
  [ "$age" -ge 0 ] && [ "$age" -lt "$FLEET_DISPATCH_ACK_TTL" ]
}

# fleet_slot_report_lock_key <path> -> the "major:minor:inode" key the kernel
# prints for <path> in /proc/locks ("%02x:%02x:%lu" of the file's st_dev
# major/minor and inode), or nothing when stat cannot answer. The dev_t decode
# mirrors glibc's gnu_dev_major/minor (os.major/os.minor in probe.py): stat's
# %t/%T are the device-NODE type, 0 for a regular file, so they cannot be used —
# the slot lock lives on a real filesystem whose major:minor must come from
# st_dev itself.
fleet_slot_report_lock_key() {
  local dev ino major minor
  dev="$(stat -c '%d' "$1" 2>/dev/null)" || return 0
  ino="$(stat -c '%i' "$1" 2>/dev/null)" || return 0
  case "$dev" in ''|*[!0-9]*) return 0 ;; esac
  case "$ino" in ''|*[!0-9]*) return 0 ;; esac
  major=$(( (dev >> 8) & 0xfff ))
  minor=$(( (dev & 0xff) | ((dev >> 12) & 0xfff00) ))
  printf '%02x:%02x:%d' "$major" "$minor" "$ino"
}

# _fleet_slot_report_pid_alive <pid> -> true | false | null. The host is the
# ONLY place a run's process-truth is knowable (probe.py's _pid_alive): a dead
# pid is false, a live one true, a pid owned by another uid still EXISTS (kill
# raises EPERM, not ESRCH) so it reads true, and a non-numeric / absent pid is a
# named null, never guessed.
_fleet_slot_report_pid_alive() {
  local pid="$1" err
  case "$pid" in ''|*[!0-9]*) printf 'null'; return 0 ;; esac
  if err="$(kill -0 "$pid" 2>&1)"; then printf 'true'; return 0; fi
  case "$err" in *[Pp]ermitted*) printf 'true' ;; *) printf 'false' ;; esac
}

# _fleet_slot_report_claimed_issue <attempts_dir> -> the one ticket a swarm
# run's in-sandbox claim appended to <attempts_dir>/claimed.log (#350), or null
# when the dir is not an absolute path, the file is absent/unreadable, or the
# last 20 lines name more than one distinct ticket — mirrors snapshot._slots'
# `len(set(claimed)) == 1` rule, so a ref=run slot names its pick from claim
# time, never a guess over a multi-ticket drain.
_fleet_slot_report_claimed_issue() {
  local d="$1" f uniq cnt
  case "$d" in /*) : ;; *) printf 'null'; return 0 ;; esac
  f="$d/claimed.log"
  [ -s "$f" ] || { printf 'null'; return 0; }
  uniq="$(grep -E '^[0-9]+$' "$f" 2>/dev/null | tail -20 | sort -u)"
  cnt="$(printf '%s\n' "$uniq" | grep -c . 2>/dev/null || echo 0)"
  if [ "$cnt" = 1 ]; then printf '%s' "$uniq"; else printf 'null'; fi
}

# _fleet_slot_report_slot_json <n> <path> <locks-blob> -> one slot object.
# <locks-blob> is the whole /proc/locks text, or the literal __UNREADABLE__ when
# it could not be read (a non-Linux dev box): then held is unknowable and the
# slot reads `unknown`, never a lock taken to find out (the probe's posture).
_fleet_slot_report_slot_json() {
  local n="$1" path="$2" locks="$3"
  local key held state hp raw
  local kind ref repo worker since pid attempts_dir
  local issue=null pid_alive=null holder=null

  # held: none (unknown) when /proc/locks is unreadable; else membership of the
  # slot's key in the lock table. An absent lock file is free (nobody holds it).
  if [ "$locks" = "__UNREADABLE__" ]; then
    held=none
  elif [ ! -e "$path" ]; then
    held=false
  else
    key="$(fleet_slot_report_lock_key "$path")"
    if [ -n "$key" ]; then
      # Match the key as a whole whitespace-delimited field (the device column),
      # so inode 399041 never matches 3990410. Newlines collapse to spaces so a
      # single glob spans the blob.
      local sp=" ${locks//$'\n'/ } "
      case "$sp" in *" $key "*) held=true ;; *) held=false ;; esac
    else
      held=false
    fi
  fi

  # The holder label, read only beside a HELD lock (a sidecar beside a free lock
  # is a crash leftover — snapshot._slots' `holder if held else None`).
  hp="$path.holder"
  if [ "$held" = true ] && [ -s "$hp" ]; then
    raw="$(cat "$hp" 2>/dev/null || true)"
    if printf '%s' "$raw" | jq -e 'type == "object"' >/dev/null 2>&1; then
      kind="$(printf '%s' "$raw" | jq -r '.kind // empty')"
      ref="$(printf '%s' "$raw" | jq -r '.ref // empty')"
      repo="$(printf '%s' "$raw" | jq -r '.repo // empty')"
      worker="$(printf '%s' "$raw" | jq -r '.worker // empty')"
      since="$(printf '%s' "$raw" | jq -r '.since // empty')"
      pid="$(printf '%s' "$raw" | jq -r '.pid // empty')"
      attempts_dir="$(printf '%s' "$raw" | jq -r '.attempts_dir // empty')"
      case "$kind" in
        ticket)
          case "$ref" in
            '' | *[!0-9]*) issue="$(_fleet_slot_report_claimed_issue "$attempts_dir")" ;;
            *) issue="$ref" ;;
          esac ;;
        session)
          case "$ref" in '' | *[!0-9]*) issue=null ;; *) issue="$ref" ;; esac ;;
      esac
      pid_alive="$(_fleet_slot_report_pid_alive "$pid")"
      holder="$(jq -cn \
        --arg kind "$kind" --arg repo "$repo" --arg worker "$worker" \
        --arg ref "$ref" --argjson since "${since:-null}" \
        --argjson pid "${pid:-null}" --argjson pid_alive "$pid_alive" \
        '{kind:(if $kind=="" then null else $kind end),
          repo:(if $repo=="" then null else $repo end),
          worker:(if $worker=="" then null else $worker end),
          ref:(if $ref=="" then null else $ref end),
          since:$since, pid:$pid, pid_alive:$pid_alive}' 2>/dev/null || printf 'null')"
    fi
  fi

  case "$held" in
    none) state=unknown ;;
    false) state=free ;;
    true) if [ "$holder" != null ]; then state=busy; else state=unknown; fi ;;
  esac
  case "$issue" in ''|*[!0-9]*) issue=null ;; esac

  jq -cn --argjson n "$n" --arg path "$path" --arg state "$state" \
     --argjson issue "$issue" --argjson holder "$holder" \
     '{n:$n, path:$path, state:$state, issue:$issue, iteration:null, holder:$holder}'
}

# fleet_slot_report_build <event> [host] [ended-repo] [ended-issue] -> the full
# report JSON on stdout (rc 1 and no output when jq is absent). <event> is
# take|end|tick; [ended-repo]/[ended-issue] ride the END report naming the
# ticket whose run is finishing (ADR 0009 decision 5 — the dispatcher checks
# that landing at once). The host defaults from the env.
fleet_slot_report_build() {
  local event="${1:-tick}" host="${2:-}" erepo="${3:-}" eissue="${4:-}"
  command -v jq >/dev/null 2>&1 || return 1
  [ -n "$host" ] || host="${SWARM_HOST:-${HOST_NAME:-$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo unknown)}}"

  local locks lf drive_reserved=false
  lf="$FLEET_SLOT_REPORT_PROC_LOCKS"
  if [ -r "$lf" ]; then locks="$(cat "$lf" 2>/dev/null || printf '__UNREADABLE__')"
  else locks='__UNREADABLE__'; fi
  if host_capacity_drive_wanted 2>/dev/null; then drive_reserved=true; fi

  local n=0 slot slots=""
  for slot in $HOST_CAPACITY_SLOTS; do
    n=$(( n + 1 ))
    slots="$slots$(_fleet_slot_report_slot_json "$n" "$slot" "$locks")"$'\n'
  done
  local slots_json ended_json
  slots_json="$(printf '%s' "$slots" | jq -s '.' 2>/dev/null || printf '[]')"

  case "$eissue" in ''|*[!0-9]*) eissue="" ;; esac
  if [ -n "$erepo" ] && [ -n "$eissue" ]; then
    ended_json="$(jq -cn --arg r "$erepo" --argjson i "$eissue" '{repo:$r, issue:$i}')"
  else
    ended_json=null
  fi

  jq -cn --arg ev "$event" --arg host "$host" --argjson now "$(date +%s)" \
     --argjson ver "$FLEET_SLOT_REPORT_VERSION" --argjson dr "$drive_reserved" \
     --argjson slots "$slots_json" --argjson ended "$ended_json" \
     '{report_version:$ver, event:$ev, host:$host, now:$now,
       drive_reserved:$dr, slots:$slots, ended:$ended}'
}

# fleet_slot_report_send <report-json> — push the report to the dispatcher over
# the mesh, best-effort. No dispatcher declared (FLEET_DISPATCHER_URL empty) is
# the normal state in this slice: a silent no-op, so the producer is harmless
# until a human throws the switch. Always rc 0 — a failed push NEVER reds a run
# or a tick; the next tick report corrects the dispatcher (decision 3's event
# wakes, periodic corrects).
fleet_slot_report_send() {
  local json="$1" url="${FLEET_DISPATCHER_URL:-}" resp code body acting
  [ -n "$url" ] || return 0
  command -v curl >/dev/null 2>&1 || return 0
  # Capture the body AND the code ('\n%{http_code}' appends the code on its own
  # last line), so the dispatcher's ack (ADR 0009 decision 4 / #356) — which rides
  # the 2xx body — can be read; the body's own newlines stay in $body.
  resp="$(printf '%s' "$json" | curl -s -w '\n%{http_code}' \
      --max-time "$FLEET_SLOT_REPORT_MAX_TIME" \
      -X POST -H 'Content-Type: application/json' \
      ${FLEET_DISPATCHER_TOKEN:+-H "Authorization: Bearer $FLEET_DISPATCHER_TOKEN"} \
      --data-binary @- "$url" 2>/dev/null)" || true
  code="${resp##*$'\n'}"
  body="${resp%$'\n'*}"
  case "${code:-000}" in
    2??)
      # The ack says acting=true iff a LIVE dispatcher is allocating this host's
      # slots; anything else (shadow, absent, malformed) reads false. Record it
      # against our own clock so the tick can defer while it is fresh.
      acting="$(printf '%s' "$body" | jq -r '.acting // false' 2>/dev/null)"
      case "$acting" in true) acting=true ;; *) acting=false ;; esac
      _fleet_slot_report_record_ack true "$acting"
      return 0 ;;
    *)
      # A failed or non-2xx push is a DEAD ack: record it so the host's next tick
      # resumes its own dispatch within one heartbeat, not at the TTL (decision 4).
      _fleet_slot_report_record_ack false false
      echo "fleet-slot-report: push to the dispatcher failed (http=${code:-000}) — the next tick report corrects it" >&2
      return 0 ;;
  esac
}

# fleet_slot_report_emit <event> [host] [ended-repo] [ended-issue] — build and
# push in one call, always rc 0 (the call sites run under set -e; neither the
# build nor the push may end a run or a tick). A no-op when jq is absent.
fleet_slot_report_emit() {
  local json
  command -v jq >/dev/null 2>&1 || return 0
  json="$(fleet_slot_report_build "$@" 2>/dev/null)" || return 0
  [ -n "$json" ] || return 0
  fleet_slot_report_send "$json"
  return 0
}

fi
