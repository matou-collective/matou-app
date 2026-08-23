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
  [ -n "${HOST_CAPACITY_HELD_FD:-}" ] && exec {HOST_CAPACITY_HELD_FD}>&-
  HOST_CAPACITY_HELD_FD=""
  HOST_CAPACITY_HELD_SLOT=""
}

# host_capacity_acquire_exclusive <lock-path>... — non-blocking, all-or-
# nothing over every path given (the pooled slots AND any sibling locks the
# caller names, e.g. session-runner's own lock, a repo's healer lock) — so
# nothing sharing ANY of those locks can start while the caller holds this.
# One busy lock releases everything already grabbed this call and returns 1
# — never camp holding partial capacity. Fds live in
# HOST_CAPACITY_EXCLUSIVE_FDS (space-separated) until
# host_capacity_release_exclusive.
host_capacity_acquire_exclusive() {
  local path fd
  HOST_CAPACITY_EXCLUSIVE_FDS=""
  for path in "$@"; do
    exec {fd}>"$path"
    if flock -n "$fd"; then
      HOST_CAPACITY_EXCLUSIVE_FDS="$HOST_CAPACITY_EXCLUSIVE_FDS $fd"
    else
      exec {fd}>&-
      host_capacity_release_exclusive
      return 1
    fi
  done
  return 0
}

# host_capacity_release_exclusive — release every fd
# host_capacity_acquire_exclusive holds, if any. Idempotent.
host_capacity_release_exclusive() {
  local fd
  for fd in ${HOST_CAPACITY_EXCLUSIVE_FDS:-}; do
    exec {fd}>&- 2>/dev/null || true
  done
  HOST_CAPACITY_EXCLUSIVE_FDS=""
}

# every consumer sees the SAME reservation the drive declared.
HOST_CAPACITY_DRIVE_WANTED="${HOST_CAPACITY_DRIVE_WANTED:-/tmp/matou-drive-wanted}"
# Consecutive-skip counter, persisted across the */2 executor ticks (each tick
# is a fresh process). Its whole point is that "skipped N consecutive ticks"
# distinguishes tick 3 from tick 50 — the observability gap that let the first
# occurrence starve ~100 minutes across ~50 ticks unnoticed.
HOST_CAPACITY_DRIVE_SKIPS="${HOST_CAPACITY_DRIVE_SKIPS:-/tmp/matou-drive-skip-count}"

# host_capacity_drive_reserve — declare that a ready drive wants the host's
# heavy capacity. Idempotent (truncate-or-create): a re-declaring tick does
# not disturb a reservation an earlier tick already made.
host_capacity_drive_reserve() { : >"$HOST_CAPACITY_DRIVE_WANTED"; }

# host_capacity_drive_release — clear the reservation (and any skip counter).
# Idempotent; the drive arms this on a trap so a crash cannot leak it (a leaked
# reservation only makes consumers yield until the next drive tick clears it —
# it never kills work — so it self-heals, but the trap keeps it tight).
host_capacity_drive_release() {
  rm -f "$HOST_CAPACITY_DRIVE_WANTED" "$HOST_CAPACITY_DRIVE_SKIPS"
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
