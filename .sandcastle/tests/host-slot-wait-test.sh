#!/usr/bin/env bash
# Offline test for host-slot-wait.sh (#268): the bounded-camp adapter that
# event-driven workflow jobs (ci checks, android builds, swarm-smoke, pr-e2e)
# use to ride the host-capacity pool. Proves: a free pool runs the command
# HOLDING a slot; a busy pool times out with exit 75 (never runs the command);
# a fresh drive reservation makes the heavy shape stand down; the exclusive
# shape holds EVERY pooled slot while the command runs and leaves no
# reservation residue. No network. Run: bash tests/host-slot-wait-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
wrapper="$root/host-slot-wait.sh"
fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0

slot1="$(mktemp)"; slot2="$(mktemp)"; side="$(mktemp)"; wanted="$(mktemp -u)"
trap 'rm -f "$slot1" "$slot2" "$side" "$wanted" "$wanted-since"' EXIT
export HOST_CAPACITY_SLOTS="$slot1 $slot2"
export HOST_CAPACITY_DRIVE_WANTED="$wanted"

# hold <path> <ready-file> — background-hold a lock, signalling once acquired
# (mirrors tests/host-capacity-lib-test.sh).
hold() {
  ( exec 9>"$1"; flock -x 9; echo held > "$2"; exec sleep 300 ) &
  HOLD_PID=$!
}
wait_ready() {
  for _ in $(seq 1 50); do [ -s "$1" ] && return 0; sleep 0.1; done
  fail "lock holder never signalled ready — test setup broken"
}
# locked <path> — 0 if <path> is currently flocked by someone else.
locked() { ! flock -n 9 9>"$1"; }

# --- heavy: pool free -> runs the command while holding a pooled slot ---
out="$(bash "$wrapper" 5 bash -c '
  held=0
  for s in $HOST_CAPACITY_SLOTS; do flock -n 9 9>"$s" || held=$((held+1)); done
  echo "held=$held"')"
[ "$out" = "held=1" ] || fail "heavy must hold exactly one pooled slot during the command, got: $out"
locked "$slot1" && fail "heavy released nothing — slot 1 still locked after the command exited"
pass=$((pass+1))

# --- heavy: BOTH slots held -> exit 75 at the deadline, command never runs ---
hold "$slot1" "$side"; h1=$HOLD_PID
trap 'kill "$h1" 2>/dev/null || true; rm -f "$slot1" "$slot2" "$side" "$wanted" "$wanted-since"' EXIT
wait_ready "$side"
: > "$side"
hold "$slot2" "$side"; h2=$HOLD_PID
trap 'kill "$h1" "$h2" 2>/dev/null || true; rm -f "$slot1" "$slot2" "$side" "$wanted" "$wanted-since"' EXIT
wait_ready "$side"
marker="$(mktemp -u)"
rc=0; bash "$wrapper" 0 touch "$marker" >/dev/null 2>&1 || rc=$?
[ "$rc" = 75 ] || fail "busy pool must exit 75, got rc=$rc"
[ ! -e "$marker" ] || fail "command ran despite a busy pool"
pass=$((pass+1))

# --- exclusive: one slot held -> exit 75, and NO leaked drive reservation ---
kill "$h2" 2>/dev/null || true; wait "$h2" 2>/dev/null || true
rc=0; bash "$wrapper" --exclusive 0 touch "$marker" >/dev/null 2>&1 || rc=$?
[ "$rc" = 75 ] || fail "exclusive with slot 1 held must exit 75, got rc=$rc"
[ ! -e "$marker" ] || fail "exclusive ran the command without the full pool"
[ ! -e "$wanted" ] || fail "exclusive timeout leaked the drive-wanted reservation"
pass=$((pass+1))

# --- heavy: fresh drive reservation -> stands down even with a free slot ---
touch "$wanted"
rc=0; bash "$wrapper" 0 touch "$marker" >/dev/null 2>&1 || rc=$?
[ "$rc" = 75 ] || fail "heavy must stand down under a fresh drive reservation, got rc=$rc"
[ ! -e "$marker" ] || fail "heavy ignored the drive reservation"
rm -f "$wanted"
pass=$((pass+1))

# --- exclusive: pool free -> holds EVERY slot during the command, cleans up ---
kill "$h1" 2>/dev/null || true; wait "$h1" 2>/dev/null || true
out="$(bash "$wrapper" --exclusive 5 bash -c '
  held=0
  for s in $HOST_CAPACITY_SLOTS; do flock -n 9 9>"$s" || held=$((held+1)); done
  echo "held=$held"')"
[ "$out" = "held=2" ] || fail "exclusive must hold every pooled slot during the command, got: $out"
locked "$slot1" && fail "exclusive did not release slot 1"
locked "$slot2" && fail "exclusive did not release slot 2"
[ ! -e "$wanted" ] || fail "exclusive left the drive-wanted reservation behind after success"
pass=$((pass+1))

echo "OK: $pass host-slot-wait tests passed"
