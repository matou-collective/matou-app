#!/usr/bin/env bash
# Host capacity semaphore — a small, fixed, zero-lock-server pool for
# serializing heavy host-wide work (Claude-calling jobs: swarm workers,
# triage, session-runner) against each other, without a single choke point.
#
# Two primitives:
#   host_capacity_acquire_heavy    — ONE pooled slot, first-fit, non-blocking.
#   host_capacity_acquire_exclusive — ALL named locks, all-or-nothing,
#                                     non-blocking (a drive's shape: it must
#                                     coexist with NOTHING heavy on the host).
#                                     HOST_CAPACITY_DRIVE_MODE=single-slot
#                                     relaxes this on a big host: the drive
#                                     keeps slot 1 but hands every pooled slot
#                                     past the first back to the pool, so one
#                                     worker runs beside it (#46, ADR 0184).
# Both NEVER camp (no flock -w): a busy resource means the caller yields
# (exit 0) and the next cron tick / backstop re-fires — the #238 lesson this
# whole subsystem is built around (originated in Matou/idss's #577,
# ADR 0184 there; ported here so every consumer's heavy host-side loops —
# not just workflow-triggered ones — can be pool participants without
# reimplementing the primitive per repo).
#
# Pure w.r.t. lock *paths*: no network, no tracker calls. Sourced directly
# (not `$()`) so the fds it opens live in the CALLING shell, not a subshell
# that would close them the instant the call returns.
#
# N is fixed at 2 slots by default (the #577 ruling: sized to the two-Claude-
# account failover reality, not RAM headroom alone — see ADR 0184 in
# Matou/idss). A consumer repo may override HOST_CAPACITY_SLOTS, but the
# default keeps every consumer counting against the SAME two paths so the
# pool is actually shared host-wide, not per-repo.

# The pooled heavy slots, in try-order. Slot 1 keeps the name
# /tmp/matou-swarm.lock on purpose: it predates this pool (the original
# single-slot lock) and an unmodified caller not yet pool-aware still
# correctly excludes against slot 1.
HOST_CAPACITY_SLOTS="${HOST_CAPACITY_SLOTS:-/tmp/matou-swarm.lock /tmp/matou-host-slot-2.lock}"

# host_capacity_acquire_heavy — try each pooled slot in order (non-blocking).
# On success: 0, HOST_CAPACITY_HELD_SLOT names the winning path, its fd stays
# open (closing it — host_capacity_release_heavy — is the only way to free
# it; process exit does too). On exhaustion: 1, nothing held — the caller
# must yield, never camp.
host_capacity_acquire_heavy() {
  local slot
  HOST_CAPACITY_HELD_SLOT=""
  HOST_CAPACITY_HELD_FD=""
  for slot in $HOST_CAPACITY_SLOTS; do
    exec {HOST_CAPACITY_HELD_FD}>"$slot"
    if flock -n "$HOST_CAPACITY_HELD_FD"; then
      HOST_CAPACITY_HELD_SLOT="$slot"
      return 0
    fi
    exec {HOST_CAPACITY_HELD_FD}>&-
    HOST_CAPACITY_HELD_FD=""
  done
  return 1
}

# host_capacity_release_heavy — release what host_capacity_acquire_heavy
# holds, if anything. Idempotent.
host_capacity_release_heavy() {
  [ -n "${HOST_CAPACITY_HELD_SLOT:-}" ] && host_capacity_holder_clear "$HOST_CAPACITY_HELD_SLOT"
  [ -n "${HOST_CAPACITY_HELD_FD:-}" ] && exec {HOST_CAPACITY_HELD_FD}>&-
  HOST_CAPACITY_HELD_FD=""
  HOST_CAPACITY_HELD_SLOT=""
}

# HOST_CAPACITY_DRIVE_MODE — how a drive's exclusive acquire sizes itself
# against the pooled slots (#46, ruled on the ticket under ADR 0184). Two
# values, default `exclusive`:
#   exclusive   — acquire EVERY path given, pooled slots included: the drive
#                 coexists with nothing heavy. Unset == exclusive, so the
#                 acquire is BYTE-IDENTICAL to the pre-#46 behaviour on any
#                 host that never declares the knob (the 7 GB workstation the
#                 exclusivity rule was sized for stays here).
#   single-slot — acquire slot 1 (the first pooled slot) and every sibling
#                 lock the caller names, but LEAVE every pooled slot past the
#                 first to the pool, so one worker can run beside the drive on
#                 a host with headroom (the 8-core box the exclusive rule
#                 would idle). Set per-host in the identity layer
#                 (rehearsal-env.sh), never hardcoded in a repo.
# The mode only ever DROPS pooled slots past the first from the acquire set; a
# sibling lock the drive names (its healer lock, session-runner's lock) is
# still fully held under either mode, so the drive's heal path always rides the
# drive's own slot and never contends for slot 2.

# _host_capacity_pool_slot_past_first <path> — 0 if <path> is a pooled slot
# that single-slot mode releases to the pool (any HOST_CAPACITY_SLOTS entry
# AFTER the first), else 1. The first pooled slot is never released: the drive
# always holds slot 1.
_host_capacity_pool_slot_past_first() {
  local target="$1" first=1 slot
  for slot in $HOST_CAPACITY_SLOTS; do
    if [ "$first" = 1 ]; then first=0; continue; fi
    [ "$slot" = "$target" ] && return 0
  done
  return 1
}

# _host_capacity_is_pool_slot <path> — 0 if <path> is one of HOST_CAPACITY_SLOTS.
_host_capacity_is_pool_slot() {
  local slot
  for slot in $HOST_CAPACITY_SLOTS; do [ "$slot" = "$1" ] && return 0; done
  return 1
}

# host_capacity_acquire_exclusive <lock-path>... — non-blocking, all-or-
# nothing over every path given (the pooled slots AND any sibling locks the
# caller names, e.g. session-runner's own lock, a repo's healer lock) — so
# nothing sharing ANY of those locks can start while the caller holds this.
# One busy lock releases everything already grabbed this call and returns 1
# — never camp holding partial capacity. Fds live in
# HOST_CAPACITY_EXCLUSIVE_FDS (space-separated) until
# host_capacity_release_exclusive; the pooled slots actually held (a subset
# of HOST_CAPACITY_SLOTS, excluding sibling locks) live in
# HOST_CAPACITY_EXCLUSIVE_SLOTS. Under HOST_CAPACITY_DRIVE_MODE=single-slot
# every pooled slot past the first is skipped (left to the pool) — see the
# knob's doc above; the acquire is otherwise unchanged.
host_capacity_acquire_exclusive() {
  local path fd mode="${HOST_CAPACITY_DRIVE_MODE:-exclusive}"
  HOST_CAPACITY_EXCLUSIVE_FDS=""
  HOST_CAPACITY_EXCLUSIVE_SLOTS=""
  for path in "$@"; do
    if [ "$mode" = single-slot ] && _host_capacity_pool_slot_past_first "$path"; then
      continue
    fi
    exec {fd}>"$path"
    if flock -n "$fd"; then
      HOST_CAPACITY_EXCLUSIVE_FDS="$HOST_CAPACITY_EXCLUSIVE_FDS $fd"
      if _host_capacity_is_pool_slot "$path"; then
        HOST_CAPACITY_EXCLUSIVE_SLOTS="${HOST_CAPACITY_EXCLUSIVE_SLOTS:+$HOST_CAPACITY_EXCLUSIVE_SLOTS }$path"
      fi
    else
      exec {fd}>&-
      host_capacity_release_exclusive
      return 1
    fi
  done
  return 0
}

# host_capacity_release_exclusive — release every fd
# host_capacity_acquire_exclusive holds, if any, and clear the holder
# sidecars it recorded in HOST_CAPACITY_EXCLUSIVE_SLOTS. Idempotent.
host_capacity_release_exclusive() {
  local fd s
  for s in ${HOST_CAPACITY_EXCLUSIVE_SLOTS:-}; do host_capacity_holder_clear "$s"; done
  HOST_CAPACITY_EXCLUSIVE_SLOTS=""
  for fd in ${HOST_CAPACITY_EXCLUSIVE_FDS:-}; do
    exec {fd}>&- 2>/dev/null || true
  done
  HOST_CAPACITY_EXCLUSIVE_FDS=""
}

# --- Slot-holder sidecar (slot-aware fleet, spec 2026-08-28) -----------------
#
# A flock records nothing about its holder, so the fleet monitor could only
# infer slot use from live swarm runs — a session-runner session (which takes
# a pooled slot but writes no run row) was invisible. Each acquirer now labels
# the slot it won with a JSON sidecar, <slot-path>.holder. The sidecar is ONLY
# the label: flock stays the single truth of held/free, and a reader that finds
# a sidecar beside a FREE lock ignores it (a crash leaves one behind; the next
# acquirer overwrites it). It is a sidecar and not the lock file's content
# because every acquirer opens the lock with `>` — which truncates the file
# even when the flock then FAILS — so content inside the lock could not
# survive a losing contender (GOTCHAS: slot-holder). Best-effort like the
# drive log: jq-gated, and a write that fails never reds the caller.

# host_capacity_holder_path <slot-path> — the sidecar beside a pooled lock.
host_capacity_holder_path() { printf '%s.holder\n' "$1"; }

# host_capacity_holder_write <slot-path> <kind> <ref> [repo] [worker] [run_id] [mode] [run_dir] [target]
#   <kind> is one of ticket|session|drive (CONTEXT.md vocabulary); <ref> the
#   issue number, `run` (a swarm run — the issue is read from swarm.db
#   attempts), `triage`, or the drive id. <repo> is the owner/slug the work is
#   FOR; <target> (drive holders) is the drive SHAPE — a per-product token for
#   the box the drive stands up (CONTEXT.md **Box**), never a repo slug —
#   the two are distinct fields so the fleet monitor renders REPO and TARGET
#   from their own keys (#118). Empty optional args record JSON null. Atomic
#   (tmp + mv) so a concurrent reader never sees partial JSON.
host_capacity_holder_write() {
  [ -n "${1:-}" ] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  local slot="$1" kind="$2" ref="$3" repo="${4:-}" worker="${5:-}"
  local run_id="${6:-}" mode="${7:-}" run_dir="${8:-}" target="${9:-}"
  local path tmp
  path="$(host_capacity_holder_path "$slot")"
  tmp="$(mktemp "$path.XXXXXX" 2>/dev/null)" || return 0
  if jq -cn \
      --arg kind "$kind" --arg ref "$ref" --arg repo "$repo" --arg worker "$worker" \
      --argjson pid "$$" --arg host "${SWARM_HOST:-$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo unknown)}" \
      --argjson since "$(date +%s)" --arg run_id "$run_id" --arg mode "$mode" --arg run_dir "$run_dir" \
      --arg target "$target" \
      '{kind:$kind, ref:$ref, repo:(if $repo=="" then null else $repo end),
        worker:(if $worker=="" then null else $worker end), pid:$pid, host:$host, since:$since,
        run_id:(if $run_id=="" then null else $run_id end),
        mode:(if $mode=="" then null else $mode end),
        run_dir:(if $run_dir=="" then null else $run_dir end),
        target:(if $target=="" then null else $target end)}' > "$tmp" 2>/dev/null \
     && mv -f "$tmp" "$path" 2>/dev/null; then
    chmod 0644 "$path" 2>/dev/null || true
  else
    rm -f "$tmp" 2>/dev/null || true
  fi
  return 0
}

# host_capacity_holder_clear <slot-path> — remove the sidecar. Idempotent.
host_capacity_holder_clear() {
  [ -n "${1:-}" ] || return 0
  rm -f "$(host_capacity_holder_path "$1")" 2>/dev/null || true
  return 0
}

# host_capacity_holder_clear_held — clear the sidecar of the heavy slot this
# process holds, and of every pooled slot an exclusive acquire recorded in
# HOST_CAPACITY_EXCLUSIVE_SLOTS. Safe when nothing is held.
host_capacity_holder_clear_held() {
  local s
  [ -n "${HOST_CAPACITY_HELD_SLOT:-}" ] && host_capacity_holder_clear "$HOST_CAPACITY_HELD_SLOT"
  for s in ${HOST_CAPACITY_EXCLUSIVE_SLOTS:-}; do host_capacity_holder_clear "$s"; done
  return 0
}

# every consumer sees the SAME reservation the drive declared.
HOST_CAPACITY_DRIVE_WANTED="${HOST_CAPACITY_DRIVE_WANTED:-/tmp/matou-drive-wanted}"
# Consecutive-skip counter, persisted across the */2 executor ticks (each tick
# is a fresh process). Its whole point is that "skipped N consecutive ticks"
# distinguishes tick 3 from tick 50 — the observability gap that let the first
# occurrence starve ~100 minutes across ~50 ticks unnoticed.
HOST_CAPACITY_DRIVE_SKIPS="${HOST_CAPACITY_DRIVE_SKIPS:-/tmp/matou-drive-skip-count}"
# First-post marker for the CURRENT reservation episode (#93). WANTED's mtime is
# deliberately refreshed on every re-declaring tick (that is the TTL freshness
# mechanism), so it can only report the per-tick age (#30), never the full
# reservation WINDOW — reservation first posted → drive started. This sibling
# marker is created ONCE per episode (create-if-absent, mtime never disturbed by
# a re-declare) and removed by release, so its mtime pins the episode's start and
# host_capacity_drive_wanted_window can report the true deferred-work window the
# drive should be credited with, not idleness. Derived from WANTED by default so
# an offline test that re-points WANTED automatically isolates this too.
HOST_CAPACITY_DRIVE_WANTED_SINCE="${HOST_CAPACITY_DRIVE_WANTED_SINCE:-${HOST_CAPACITY_DRIVE_WANTED}-since}"

# host_capacity_drive_reserve — declare that a ready drive wants the host's
# heavy capacity. Idempotent: WANTED is truncate-or-created (refreshing its mtime
# so the TTL sees a live want), while the SINCE marker is created only if absent
# — a re-declaring tick refreshes freshness without disturbing the episode's
# first-post time, so the reservation WINDOW survives across ticks (#93).
host_capacity_drive_reserve() {
  : >"$HOST_CAPACITY_DRIVE_WANTED"
  [ -e "$HOST_CAPACITY_DRIVE_WANTED_SINCE" ] || : >"$HOST_CAPACITY_DRIVE_WANTED_SINCE"
}

# host_capacity_drive_release — clear the reservation (skip counter and the
# first-post marker included). Idempotent; the drive arms this on a trap so a
# crash cannot leak it (a leaked reservation only makes consumers yield until the
# next drive tick clears it — it never kills work — so it self-heals, but the
# trap keeps it tight).
host_capacity_drive_release() {
  rm -f "$HOST_CAPACITY_DRIVE_WANTED" "$HOST_CAPACITY_DRIVE_SKIPS" \
        "$HOST_CAPACITY_DRIVE_WANTED_SINCE"
}

# host_capacity_drive_wanted — predicate: 0 if a drive has reserved capacity,
# else 1. This is the function a heavy-capacity consumer calls before claiming
# a NEW task; it declines (yields, exit 0) when this returns 0. (The consumer
# call sites live in the protected .sandcastle/ claim path and ship separately
# — this predicate is defined here so the two copies of the primitive stay in
# lockstep and the consumer edit is a one-liner.)
# Freshness bound (#664). The reservation is cleared by rehearsal-cycle.sh's EXIT
# traps — but those arm only AFTER the drive wins capacity, and the executor
# exits before ever reaching the cycle once the drive ticket is blocked or
# closed. So "the next drive tick clears it" is not guaranteed: a tick that
# reserved-then-skipped, followed by the drive going blocked/closed/disarmed —
# or a SIGKILL/OOM/reboot that a trap cannot catch, on a host whose whole
# capacity subsystem exists BECAUSE it is memory-tight — leaves the file
# standing with nothing scheduled to remove it. Once consumers honour it, that
# is a host-wide wedge: every swarm/triage/session-runner run yields forever
# until a human rm's /tmp.
#
# A TTL removes the class outright. The declarer re-touches the file on every
# */2 tick (reserve is truncate-or-create), so a LIVE want is always fresh and
# the bound never fires while a drive is genuinely waiting; an abandoned one
# ages out and the pool re-opens on its own. This is why the reservation is a
# plain file and not a lock: it must EXPIRE, never deadlock. A running drive
# holding the real locks is unaffected either way — flock excludes consumers
# far more strongly than this predicate does, so the TTL lapsing mid-drive
# costs nothing.
HOST_CAPACITY_DRIVE_WANTED_TTL="${HOST_CAPACITY_DRIVE_WANTED_TTL:-900}"

# host_capacity_drive_wanted — predicate: 0 if a drive has a FRESH reservation,
# else 1 (absent, unreadable, or older than HOST_CAPACITY_DRIVE_WANTED_TTL).
host_capacity_drive_wanted() {
  local mtime now
  [ -e "$HOST_CAPACITY_DRIVE_WANTED" ] || return 1
  mtime="$(stat -c %Y "$HOST_CAPACITY_DRIVE_WANTED" 2>/dev/null || true)"
  case "$mtime" in ''|*[!0-9]*) return 1 ;; esac
  now="$(date +%s)"
  [ "$(( now - mtime ))" -lt "$HOST_CAPACITY_DRIVE_WANTED_TTL" ]
}

# host_capacity_drive_wanted_issue — echo the reserving drive's issue number if
# the reservation file carries one, else nothing (#24). The producer
# (idss rehearsal-cycle.sh) writes REHEARSAL_DRIVE_ISSUE into the file so a
# consumer can admit the one worker whose next claim would UNBLOCK that drive —
# the work the drive is waiting on — instead of yielding to it. An EMPTY file
# (today's touch-file, and any producer still on the pre-#24 pin) yields nothing
# here, so host_capacity_drive_wanted's unconditional-yield semantics are
# preserved and the reservation-format change is backward compatible across the
# pin lag: the admit exception only fires when a number is actually present.
# Reads only the first line and only a bare integer — any other content (a stale
# multi-line file, a non-numeric token) is treated as "no issue" so a malformed
# reservation can never mis-admit a worker. Does NOT re-check the TTL: a caller
# gates on host_capacity_drive_wanted (freshness) first, then reads the number.
host_capacity_drive_wanted_issue() {
  local first
  [ -e "$HOST_CAPACITY_DRIVE_WANTED" ] || return 0
  first="$(head -n1 "$HOST_CAPACITY_DRIVE_WANTED" 2>/dev/null || true)"
  case "$first" in
    '' | *[!0-9]*) return 0 ;;
    *) echo "$first" ;;
  esac
}

# host_capacity_drive_wanted_age — echo the reservation's age in whole seconds
# (now - mtime); rc 1 with no output when the file is absent or unreadable. A
# consumer that stands down (swarm/triage/healer, #30) prints this in its yield
# line so its "yielded" line and the executor's "skipped N consecutive tick(s)"
# line corroborate on the SAME reservation. Reports the age regardless of the
# TTL (a caller only logs it on the fresh-reservation path, where the age is
# by definition < TTL) — kept a pure read of the mtime so the offline test can
# assert it directly.
host_capacity_drive_wanted_age() {
  local mtime now
  [ -e "$HOST_CAPACITY_DRIVE_WANTED" ] || return 1
  mtime="$(stat -c %Y "$HOST_CAPACITY_DRIVE_WANTED" 2>/dev/null || true)"
  case "$mtime" in ''|*[!0-9]*) return 1 ;; esac
  now="$(date +%s)"
  echo "$(( now - mtime ))"
}

# host_capacity_drive_wanted_window — echo the CURRENT reservation episode's full
# window in whole seconds (now - first-post), or rc 1 with no output when no
# episode is open (the SINCE marker is absent or unreadable). Unlike
# host_capacity_drive_wanted_age (which reads WANTED's per-tick-refreshed mtime),
# this reads the SINCE marker whose mtime is pinned at the episode's first
# host_capacity_drive_reserve — so it reports the deferred-work window a drive
# waited before winning capacity, the #663 time the timeline must attribute to
# the drive rather than idleness (#93). Independent of the TTL, a pure read of
# the mtime, so the offline test can assert it directly.
host_capacity_drive_wanted_window() {
  local mtime now
  [ -e "$HOST_CAPACITY_DRIVE_WANTED_SINCE" ] || return 1
  mtime="$(stat -c %Y "$HOST_CAPACITY_DRIVE_WANTED_SINCE" 2>/dev/null || true)"
  case "$mtime" in ''|*[!0-9]*) return 1 ;; esac
  now="$(date +%s)"
  echo "$(( now - mtime ))"
}

# host_capacity_drive_skip_bump — increment the consecutive-skip counter and
# echo the new value. Called on every yielded drive tick so the skip log line
# carries a running count.
host_capacity_drive_skip_bump() {
  local n
  n="$(cat "$HOST_CAPACITY_DRIVE_SKIPS" 2>/dev/null || echo 0)"
  case "$n" in ''|*[!0-9]*) n=0 ;; esac
  n=$((n + 1))
  echo "$n" >"$HOST_CAPACITY_DRIVE_SKIPS"
  echo "$n"
}

# host_capacity_drive_skip_reset — zero the consecutive-skip counter (the drive
# acquired capacity this tick; the next starvation episode counts from 1).
host_capacity_drive_skip_reset() { rm -f "$HOST_CAPACITY_DRIVE_SKIPS"; }

# --- Per-consumer drive-defer counter (#664) -------------------------------
#
# host_capacity_drive_skip_bump/_reset above are the DRIVE's own counter (how
# many consecutive ticks the drive itself was skipped waiting for a slot).
# This is the mirror for the CONSUMER side: swarm, triage, and session-runner
# each defer to a reservation on their own independent cadence (swarm's
# :15/:45 vs triage's :05/:35 vs session-runner's */10), so one shared counter
# would conflate three unrelated streaks. Takes the counter PATH directly
# (not just a consumer name) — same reason HOST_CAPACITY_DRIVE_WANTED/_SKIPS
# above are overridable rather than hard-coded: an offline test must be able
# to point this at a throwaway file instead of real host-global /tmp state.
# The convention every real caller uses is /tmp/matou-<name>-drive-defer-count
# (session-runner.sh, and the swarm.yml/triage.yml inline guards which cannot
# source this file but mirror the same naming and message shape).
host_capacity_consumer_defer_bump() { # <path> -> prints the new count
  local f="$1" n
  n="$(cat "$f" 2>/dev/null || echo 0)"
  case "$n" in ''|*[!0-9]*) n=0 ;; esac
  n=$((n + 1))
  echo "$n" >"$f"
  echo "$n"
}

# host_capacity_consumer_defer_reset <path> — zero the consecutive-defer
# counter at <path>. Called once a tick proceeds past the reservation check
# (deferred or not); the next starvation episode for that consumer counts
# from 1 again.
host_capacity_consumer_defer_reset() { rm -f "$1"; }

# --- Durable drive-lifecycle log (#93) -------------------------------------
#
# The live drive-status file (the `drive-status` registry directive, #80) is
# overwritten as a drive progresses and says NOTHING once the drive ends, so a
# whole-host-exclusive window — the single largest capacity event a host has —
# vanishes from the timeline the moment the next drive starts (or the file is
# cleared). This append-only JSONL log, kept next to swarm.db, is the DURABLE
# host-side record: one `start` line (box, target, mode, and the reservation
# WINDOW the drive is crediting itself with) and one matching `end` line
# (verdict) per drive, correlated by a caller-chosen drive id. Append-only is the
# whole point — a later drive can NEVER overwrite an earlier drive's record, the
# live status file's exact flaw. The probe tails it (fleet-tui probe
# `--drive-log`), so the operator side reconstructs the exclusive-window timeline
# offline. Best-effort, swarm.db's posture: a log we cannot write NEVER reds a
# drive. The writer is the host-side drive machinery (a consumer's
# rehearsal-cycle.sh once vendored), NOT the identity layer (pull-only, ADR
# 0001) — this primitive lives here so the two copies stay in lockstep
# (mirrors host_capacity_drive_wanted, #24).
#
# Two env knobs the consumer's drive machinery exports (both additive, both
# mirroring the plain-env pattern — never a positional flag day) BEFORE calling
# host_capacity_drive_log_start, since the acquire happens on the host outside
# this primitive:
#   HOST_CAPACITY_DRIVE_REPO    — the owner/slug the drive is FOR; fills the
#                                 holder's `repo` and the start line's `repo`.
#   HOST_CAPACITY_DRIVE_RUN_DIR — the run dir; rides into the holder's `run_dir`
#                                 so the fleet monitor finds artifacts/legs.json.
# The positional <target> is the drive SHAPE — a per-product token for the box
# the drive stands up (CONTEXT.md **Box**), a different
# thing from the repo (#118) — it lands in the holder's `target` and the start
# line's `target`, never in `repo`.
HOST_CAPACITY_DRIVE_LOG="${HOST_CAPACITY_DRIVE_LOG:-$HOME/swarm/state/drive-log.jsonl}"

# _host_capacity_drive_log_append <json-line> — append one line, creating the
# parent dir. Best-effort: an unwritable path is swallowed (never reds a drive).
_host_capacity_drive_log_append() {
  local dir
  dir="$(dirname "$HOST_CAPACITY_DRIVE_LOG")"
  mkdir -p "$dir" 2>/dev/null || return 0
  printf '%s\n' "$1" >>"$HOST_CAPACITY_DRIVE_LOG" 2>/dev/null || true
}

# _host_capacity_drive_slots [mode] — the pooled slots a drive holds under
# <mode>: slot 1 only under single-slot, every pooled slot under exclusive.
_host_capacity_drive_slots() {
  local mode="${1:-${HOST_CAPACITY_DRIVE_MODE:-exclusive}}" slot first=1
  for slot in $HOST_CAPACITY_SLOTS; do
    if [ "$mode" = single-slot ] && [ "$first" != 1 ]; then break; fi
    printf '%s\n' "$slot"; first=0
  done
}

# host_capacity_drive_log_start <id> <box> <target> [mode] [reservation_window_s]
#   Record that a drive won the host's heavy capacity and started. <id>
#   correlates this start with its later end (any stable per-drive token: the
#   drive's run id, or "$(date +%s)-$$"). <box> is the box the drive stood up
#   (CONTEXT.md vocabulary), <target> the drive SHAPE it targets (a per-product
#   token for the box, CONTEXT.md **Box**) — NOT the repo, which rides in via
#   HOST_CAPACITY_DRIVE_REPO (see the header). [mode] defaults to the live
#   HOST_CAPACITY_DRIVE_MODE (exclusive|single-slot) — the capacity shape the
#   drive actually held. [reservation_window_s] is the #663 window (reservation
#   posted → drive started), deferred-work time the timeline must attribute to
#   the drive, not to idleness; omitted, it is read from the still-standing
#   reservation via host_capacity_drive_wanted_window (so the drive machinery
#   just logs the start BEFORE releasing its reservation and the window is
#   captured automatically). A non-numeric / absent window records JSON null.
#   Best-effort; never reds the drive. Requires jq (present on every swarm
#   host); absent, it is a silent no-op like the swarm.db writers.
#
#   Also labels the pooled slots the drive ACTUALLY holds with a `drive` holder
#   sidecar — flock is truth, the sidecar is a label (GOTCHAS 42), so the label
#   must follow the flock, never a HOST_CAPACITY_DRIVE_MODE prediction (#118): it
#   labels the slots an exclusive acquire recorded in HOST_CAPACITY_EXCLUSIVE_SLOTS
#   when that is set, else the one heavy slot in HOST_CAPACITY_HELD_SLOT, and only
#   falls back to the mode prediction when the caller acquired some other way.
#   The slots labelled are remembered in HOST_CAPACITY_DRIVE_HOLDER_SLOTS so
#   host_capacity_drive_log_end clears exactly those (never re-predicting).
#   HOST_CAPACITY_DRIVE_REPO fills the holder's `repo`; HOST_CAPACITY_DRIVE_RUN_DIR
#   its `run_dir`; <target> its `target`.
host_capacity_drive_log_start() {
  command -v jq >/dev/null 2>&1 || return 0
  local id="$1" box="$2" target="$3"
  local mode="${4:-${HOST_CAPACITY_DRIVE_MODE:-exclusive}}"
  local window="${5:-}" repo="${HOST_CAPACITY_DRIVE_REPO:-}"
  [ -n "$window" ] || window="$(host_capacity_drive_wanted_window 2>/dev/null || true)"
  case "$window" in ''|*[!0-9]*) window=null ;; esac
  _host_capacity_drive_log_append "$(jq -cn \
    --arg id "$id" --arg box "$box" --arg target "$target" --arg mode "$mode" \
    --arg repo "$repo" --argjson at "$(date +%s)" --argjson res "$window" \
    '{event:"start",id:$id,at:$at,box:$box,target:$target,mode:$mode,
      repo:(if $repo=="" then null else $repo end),reservation_window_s:$res}')"
  # Label the slots the flock actually won, not the mode prediction (#118).
  local slots slot
  if [ -n "${HOST_CAPACITY_EXCLUSIVE_SLOTS:-}" ]; then
    slots="$HOST_CAPACITY_EXCLUSIVE_SLOTS"
  elif [ -n "${HOST_CAPACITY_HELD_SLOT:-}" ]; then
    slots="$HOST_CAPACITY_HELD_SLOT"
  else
    slots="$(_host_capacity_drive_slots "$mode")"
  fi
  HOST_CAPACITY_DRIVE_HOLDER_SLOTS="$slots"
  for slot in $slots; do
    host_capacity_holder_write "$slot" drive "$id" "$repo" executor "" "$mode" "${HOST_CAPACITY_DRIVE_RUN_DIR:-}" "$target"
  done
}

# host_capacity_drive_log_end <id> [verdict]
#   Record that the drive <id> ended. [verdict] is the drive's outcome
#   (completed, failed, killed:...); omitted → "ended". This end line is
#   permanent and independent of the live status file, which the next drive
#   overwrites (the whole point, #93). Best-effort; jq-gated like _start.
#   Also clears exactly the `drive` holder sidecars host_capacity_drive_log_start
#   labelled — the slots it remembered in HOST_CAPACITY_DRIVE_HOLDER_SLOTS (so a
#   drive that held only slot 2 never wipes a ticket worker's slot-1 holder, #118).
#   When that variable is unset (a process that only ends, never started, the
#   drive here) it falls back to the live-mode prediction.
host_capacity_drive_log_end() {
  command -v jq >/dev/null 2>&1 || return 0
  local id="$1" verdict="${2:-ended}"
  _host_capacity_drive_log_append "$(jq -cn \
    --arg id "$id" --arg verdict "$verdict" --argjson at "$(date +%s)" \
    '{event:"end",id:$id,at:$at,verdict:$verdict}')"
  local slots slot
  slots="${HOST_CAPACITY_DRIVE_HOLDER_SLOTS:-}"
  [ -n "$slots" ] || slots="$(_host_capacity_drive_slots)"
  for slot in $slots; do host_capacity_holder_clear "$slot"; done
}
