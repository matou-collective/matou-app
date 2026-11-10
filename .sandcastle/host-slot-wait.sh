#!/usr/bin/env bash
# host-slot-wait.sh — run a command under host capacity (Matou/matou-app#268).
#
# Usage:
#   host-slot-wait.sh [--exclusive] <timeout-seconds> <cmd> [args...]
#
# Default (heavy shape): acquire ONE pooled host-capacity slot, then exec
# <cmd> holding it. --exclusive (the e2e drive's shape): declare the
# drive-wanted reservation so slot claimers stand down, acquire EVERY pooled
# slot all-or-nothing, release the reservation, then exec <cmd> holding them.
# Either way the flocks ride this process's fds into the exec'd command and
# release when it exits — no sidecar holder process to leak.
#
# Why this exists (#268): ci.yml checks, android.yml builds and swarm-smoke
# ran with NO slot — docker/gradle work co-ran with the timing-sensitive
# pr-e2e drive on the 7 GB workstation and starved its bootstrap. The vendored
# host-capacity primitives never camp (yield; the cron re-fires) — right for
# cron-refired consumers, wrong for EVENT-DRIVEN workflow jobs, where a yield
# loses the run outright. This wrapper is the bounded-camp adapter: poll the
# non-blocking primitives, honour a drive's reservation while waiting, give up
# loudly at the deadline with exit 75 (EX_TEMPFAIL) so a lock timeout is
# distinguishable from the command failing.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=host-capacity-lib.sh
. "$here/host-capacity-lib.sh"

exclusive=0
if [ "${1:-}" = --exclusive ]; then exclusive=1; shift; fi
timeout="${1:?usage: host-slot-wait.sh [--exclusive] <timeout-seconds> <cmd> [args...]}"; shift
[ "$#" -ge 1 ] || { echo "host-slot-wait: no command given" >&2; exit 2; }
deadline=$(( $(date +%s) + timeout ))

# resolve_drive_mode — this host's drive-exclusivity shape (#572), printing
# exclusive|single-slot. Precedence: an explicit HOST_CAPACITY_DRIVE_MODE wins;
# else DRIVE_EXCLUSIVE (a runner env); else the `drive-exclusive` directive in
# HOST_REGISTRY_CONF ($HOME/swarm/host-registry.conf by default). `slot` (a big
# box — take ONE pooled slot, leave the rest of the host to the pool:
# elitebook-03, dev-factory ADR 0003) maps to single-slot; `all`, unset,
# unreadable, or anything else keeps `exclusive` (the 7 GB workstation, byte-
# for-byte). Lives here (not in the vendored host-capacity-lib.sh) so the mode
# read stays per-repo; the pr-e2e.yml inline step reads the SAME source, so the
# two agree. Read `key value` or `key=value`, first match wins.
HOST_REGISTRY_CONF="${HOST_REGISTRY_CONF:-$HOME/swarm/host-registry.conf}"
resolve_drive_mode() {
  if [ -n "${HOST_CAPACITY_DRIVE_MODE:-}" ]; then
    printf '%s\n' "$HOST_CAPACITY_DRIVE_MODE"
    return 0
  fi
  local ex="${DRIVE_EXCLUSIVE:-}"
  if [ -z "$ex" ] && [ -r "$HOST_REGISTRY_CONF" ]; then
    ex="$(awk -F'[ \t=]+' '$1=="drive-exclusive"{print $2; exit}' "$HOST_REGISTRY_CONF" 2>/dev/null || true)"
  fi
  case "$ex" in
    slot) printf 'single-slot\n' ;;
    *)    printf 'exclusive\n' ;;
  esac
}

if [ "$exclusive" = 1 ]; then
  # Honour the host's drive-exclusivity shape (#572): on a `slot` host the drive
  # keeps slot 1 and leaves slot 2 to the pool (single-slot), on an `all`/unset
  # host it takes every pooled slot (exclusive, byte-for-byte). host_capacity_
  # acquire_exclusive reads HOST_CAPACITY_DRIVE_MODE, so resolve it once here.
  HOST_CAPACITY_DRIVE_MODE="$(resolve_drive_mode)"; export HOST_CAPACITY_DRIVE_MODE
  # A crash while waiting must not leave a stale reservation deferring every
  # heavy consumer for the full TTL; released again right after acquiring.
  trap 'host_capacity_drive_release' EXIT
  while :; do
    host_capacity_drive_reserve
    # shellcheck disable=SC2086  # pooled slots are a space-separated list by design
    host_capacity_acquire_exclusive $HOST_CAPACITY_SLOTS && break
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "host-slot-wait: host capacity still busy after ${timeout}s — giving up" >&2
      exit 75
    fi
    sleep 20
  done
  host_capacity_drive_release
  trap - EXIT
  for s in ${HOST_CAPACITY_EXCLUSIVE_SLOTS:-}; do
    host_capacity_holder_write "$s" drive "${HOST_SLOT_REF:-pr-e2e}" "${REPO_SLUG:-}"
  done
else
  while :; do
    # Stand down while a drive has a fresh reservation — a camped flock would
    # otherwise beat the drive's all-or-nothing acquire indefinitely (the
    # starvation idss #663/#664 solved for the pool's own consumers).
    if ! host_capacity_drive_wanted && host_capacity_acquire_heavy; then break; fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "host-slot-wait: host capacity still busy after ${timeout}s — giving up" >&2
      exit 75
    fi
    sleep 15
  done
  host_capacity_holder_write "$HOST_CAPACITY_HELD_SLOT" session "${HOST_SLOT_REF:-ci}" "${REPO_SLUG:-}"
fi

exec "$@"
