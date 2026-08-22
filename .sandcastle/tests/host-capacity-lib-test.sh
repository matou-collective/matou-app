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

# --- drive reservation (#663/#664): reserve is seen, release clears it ---
wanted="$(mktemp -u)"; skips="$(mktemp -u)"
export HOST_CAPACITY_DRIVE_WANTED="$wanted" HOST_CAPACITY_DRIVE_SKIPS="$skips"
out="$(bash -c '
  . "$1"
  host_capacity_drive_wanted && echo "PRE-WANTED-BUG"      # nothing reserved yet
  host_capacity_drive_reserve
  host_capacity_drive_wanted && echo reserved              # a consumer now sees it
  host_capacity_drive_reserve                              # idempotent: no error
  host_capacity_drive_release
  host_capacity_drive_wanted && echo "POST-RELEASE-BUG"    # cleared
  host_capacity_drive_release                              # idempotent: no error
  echo done
' _ "$lib")"
[[ "$out" != *"PRE-WANTED-BUG"* ]]   || fail "drive_wanted true before any reserve: $out"
[[ "$out" == *"reserved"* ]]         || fail "drive_wanted false after reserve: $out"
[[ "$out" != *"POST-RELEASE-BUG"* ]] || fail "drive_wanted still true after release: $out"
[[ "$out" == *"done"* ]]             || fail "reservation helpers errored (set -e): $out"
[ ! -e "$wanted" ]                   || fail "reservation file left on disk after release"
pass=$((pass+1))

# --- drive reservation: skip counter climbs, resets, and release wipes it ---
out="$(bash -c '
  . "$1"
  echo "bump=$(host_capacity_drive_skip_bump)"            # 1
  echo "bump=$(host_capacity_drive_skip_bump)"            # 2
  echo "bump=$(host_capacity_drive_skip_bump)"            # 3
  host_capacity_drive_skip_reset
  echo "afterreset=$(host_capacity_drive_skip_bump)"      # back to 1
  host_capacity_drive_release                             # also wipes the counter
  echo "afterrelease=$(host_capacity_drive_skip_bump)"    # 1 again
' _ "$lib")"
[[ "$out" == *"bump=1"* && "$out" == *"bump=2"* && "$out" == *"bump=3"* ]] \
  || fail "skip counter did not climb 1,2,3 across ticks: $out"
[[ "$out" == *"afterreset=1"* ]]   || fail "skip counter did not reset to 0 (next bump != 1): $out"
[[ "$out" == *"afterrelease=1"* ]] || fail "release did not wipe the skip counter (next bump != 1): $out"
pass=$((pass+1))
unset HOST_CAPACITY_DRIVE_WANTED HOST_CAPACITY_DRIVE_SKIPS

# --- drive reservation: the TTL is the anti-deadlock -----------------------
# The reservation is cleared only by rehearsal-cycle.sh's EXIT traps, which arm
# after the drive WINS capacity — and the executor never reaches the cycle once
# the drive ticket is blocked or closed. So an abandoned reservation has nothing
# scheduled to remove it; without a freshness bound that wedges every heavy job
# on the host until a human clears /tmp. Re-point at fresh temp paths so this
# never touches the REAL host-global /tmp/matou-drive-wanted.
ttl_wanted="$(mktemp -u)"; ttl_skips="$(mktemp -u)"
export HOST_CAPACITY_DRIVE_WANTED="$ttl_wanted" HOST_CAPACITY_DRIVE_SKIPS="$ttl_skips"
export HOST_CAPACITY_DRIVE_WANTED_TTL=900
trap 'rm -f "$slot1" "$slot2" "$side" "$ttl_wanted" "$ttl_skips"' EXIT
bash -c '. "$1"; host_capacity_drive_reserve' _ "$lib"
bash -c '. "$1"; host_capacity_drive_wanted' _ "$lib" \
  || fail "a just-declared reservation must be honoured"
touch -d '@1' "$ttl_wanted"
bash -c '. "$1"; host_capacity_drive_wanted' _ "$lib" \
  && fail "a reservation older than the TTL must EXPIRE — an abandoned one must never wedge the host"
bash -c '. "$1"; host_capacity_drive_reserve' _ "$lib"
bash -c '. "$1"; host_capacity_drive_wanted' _ "$lib" \
  || fail "re-declaring must refresh the reservation (a starving drive re-reserves every tick)"
bash -c '. "$1"; host_capacity_drive_release' _ "$lib"
pass=$((pass+1))

bash -c '. "$1"; host_capacity_drive_wanted' _ "$lib" \
  && fail "a released reservation must not be wanted"
pass=$((pass+1))

bash -c '. "$1"; host_capacity_drive_reserve' _ "$lib"
out="$(bash -c '. "$1"; host_capacity_acquire_heavy && echo "$HOST_CAPACITY_HELD_SLOT"' _ "$lib")"
[ "$out" = "$slot1" ] || fail "a standing reservation must not itself block the pool, got: $out"
bash -c '. "$1"; host_capacity_drive_release' _ "$lib"
pass=$((pass+1))

# --- per-consumer drive-defer counter (#664): each caller's own path ------
# Takes the counter PATH directly (like HOST_CAPACITY_DRIVE_WANTED/_SKIPS
# above) so an offline test never touches real host-global /tmp state.
defer_a="$(mktemp -u)"; defer_b="$(mktemp -u)"
trap 'rm -f "$slot1" "$slot2" "$side" "$defer_a" "$defer_b"' EXIT
out="$(bash -c '
  . "$1"
  echo "bump=$(host_capacity_consumer_defer_bump "$2")"    # 1
  echo "bump=$(host_capacity_consumer_defer_bump "$2")"    # 2
  host_capacity_consumer_defer_reset "$2"
  echo "afterreset=$(host_capacity_consumer_defer_bump "$2")"  # back to 1
' _ "$lib" "$defer_a")"
[[ "$out" == *"bump=1"* && "$out" == *"bump=2"* ]] \
  || fail "consumer defer counter did not climb 1,2 across ticks: $out"
[[ "$out" == *"afterreset=1"* ]] \
  || fail "consumer defer reset did not bring the next bump back to 1: $out"
rm -f "$defer_a"
pass=$((pass+1))

# two different consumer counter files must never share state — a swarm
# streak and a triage streak on the SAME host are independent (#664:
# different cadences, different paths).
out="$(bash -c '
  . "$1"
  host_capacity_consumer_defer_bump "$2" >/dev/null
  host_capacity_consumer_defer_bump "$2" >/dev/null
  host_capacity_consumer_defer_bump "$2" >/dev/null
  echo "a=$(host_capacity_consumer_defer_bump "$2")"   # 4
  echo "b=$(host_capacity_consumer_defer_bump "$3")"   # 1, unaffected by a
' _ "$lib" "$defer_a" "$defer_b")"
[[ "$out" == *"a=4"* ]] || fail "consumer a's counter did not reach 4: $out"
[[ "$out" == *"b=1"* ]] || fail "consumer b's counter was not independent of a's: $out"
rm -f "$defer_a" "$defer_b"
pass=$((pass+1))


echo "host-capacity-lib: $pass groups passed"
