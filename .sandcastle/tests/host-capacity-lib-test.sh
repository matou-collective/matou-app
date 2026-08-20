#!/usr/bin/env bash
# Offline test for the host capacity semaphore: pooled-slot first-fit,
# all-or-nothing exclusive acquire, and — critically — that both NEVER camp
# (flock -n only) and that a failed exclusive acquire leaves NO residue.
# No network. Run: bash tests/host-capacity-lib-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
lib="$root/host-capacity-lib.sh"
fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0

slot1="$(mktemp)"; slot2="$(mktemp)"; side="$(mktemp)"
trap 'rm -f "$slot1" "$slot2" "$side"' EXIT
export HOST_CAPACITY_SLOTS="$slot1 $slot2"

# hold <path> <ready-file> — background-hold a lock for 30s, signalling once
# acquired; PID lands in $HOLD_PID. `exec sleep` leaves no child with an
# inherited fd copy, so `kill $HOLD_PID` releases cleanly (mirrors
# .sandcastle/tests/swarm-lock-yield-test.sh). Must be called directly, NOT
# via `$(...)` — a command-substitution subshell's background children do not
# survive the subshell's exit in this environment.
hold() {
  ( exec 9>"$1"; flock -x 9; echo held > "$2"; exec sleep 30 ) &
  HOLD_PID=$!
}
wait_ready() { # <ready-file>
  for _ in $(seq 1 50); do [ -s "$1" ] && return 0; sleep 0.1; done
  fail "lock holder never signalled ready — test setup broken"
}

# --- acquire_heavy: both free -> takes slot 1 ---
out="$(bash -c '. "$1"; host_capacity_acquire_heavy && echo "$HOST_CAPACITY_HELD_SLOT"' _ "$lib")"
[ "$out" = "$slot1" ] || fail "both free must acquire slot 1 first, got: $out"
pass=$((pass+1))

# --- acquire_heavy: slot 1 held -> falls through to slot 2, fast (no camp) ---
hold "$slot1" "$side"; h1=$HOLD_PID
trap 'kill "$h1" 2>/dev/null || true; rm -f "$slot1" "$slot2" "$side"' EXIT
wait_ready "$side"
start="$(date +%s)"
out="$(bash -c '. "$1"; host_capacity_acquire_heavy && echo "$HOST_CAPACITY_HELD_SLOT"' _ "$lib")"
elapsed="$(( $(date +%s) - start ))"
[ "$out" = "$slot2" ] || fail "slot 1 busy must fall through to slot 2, got: $out"
[ "$elapsed" -lt 5 ] || fail "acquire took ${elapsed}s — flock is not -n somewhere"
pass=$((pass+1))

# --- acquire_heavy: BOTH held -> yields (rc=1), fast, holds nothing ---
: > "$side"
hold "$slot2" "$side"; h2=$HOLD_PID
trap 'kill "$h1" "$h2" 2>/dev/null || true; rm -f "$slot1" "$slot2" "$side"' EXIT
wait_ready "$side"
start="$(date +%s)"
rc=0
bash -c '. "$1"; host_capacity_acquire_heavy' _ "$lib" || rc=$?
elapsed="$(( $(date +%s) - start ))"
[ "$rc" -eq 1 ]      || fail "both slots busy must return 1 (yield), got rc=$rc"
[ "$elapsed" -lt 5 ] || fail "exhausted-pool acquire camped ${elapsed}s instead of yielding fast"
pass=$((pass+1))

kill "$h1" "$h2" 2>/dev/null || true
wait "$h1" "$h2" 2>/dev/null || true

# --- acquire_heavy: released -> acquirable again (no residue) ---
out="$(bash -c '. "$1"; host_capacity_acquire_heavy && echo "$HOST_CAPACITY_HELD_SLOT"' _ "$lib")"
[ "$out" = "$slot1" ] || fail "once holders are gone slot 1 must be acquirable again, got: $out"
pass=$((pass+1))

# --- acquire_exclusive: all free -> grabs both, holds them for the caller ---
: > "$slot1"; : > "$slot2"
out="$(bash -c '
  . "$1"
  host_capacity_acquire_exclusive "$2" "$3" && echo ok
  # still held from the SAME shell -> a fresh flock -n on either must fail
  exec 8>"$2"; flock -n 8 && echo "LEAK:slot1-not-held"
  true
' _ "$lib" "$slot1" "$slot2")"
[ "$(printf '%s\n' "$out" | grep -c '^ok$')" = 1 ] || fail "exclusive acquire of two free locks must succeed, got: $out"
[[ "$out" != *LEAK* ]] || fail "exclusive acquire did not actually hold its own locks: $out"
pass=$((pass+1))

# --- acquire_exclusive: one busy -> fails AND releases what it grabbed (no residue) ---
: > "$side"
hold "$slot2" "$side"; h1=$HOLD_PID
trap 'kill "$h1" 2>/dev/null || true; rm -f "$slot1" "$slot2" "$side"' EXIT
wait_ready "$side"
start="$(date +%s)"
out="$(bash -c '
  . "$1"
  if host_capacity_acquire_exclusive "$2" "$3"; then echo ok; else echo failed; fi
  # slot1 (the free one) must be released even though slot2 was the blocker —
  # prove it: a fresh flock -n on slot1 from THIS shell must succeed.
  exec 8>"$2"; flock -n 8 && echo "slot1-released"
  true
' _ "$lib" "$slot1" "$slot2")"
elapsed="$(( $(date +%s) - start ))"
[[ "$out" == *"failed"* ]]          || fail "one busy lock must fail the exclusive acquire, got: $out"
[[ "$out" == *"slot1-released"* ]]  || fail "a failed exclusive acquire left slot1 held (residue): $out"
[ "$elapsed" -lt 5 ]                || fail "exclusive acquire camped ${elapsed}s instead of yielding fast"
pass=$((pass+1))

kill "$h1" 2>/dev/null || true
wait "$h1" 2>/dev/null || true

echo "host-capacity-lib: $pass groups passed"
