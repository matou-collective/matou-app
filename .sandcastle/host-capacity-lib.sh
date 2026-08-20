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
