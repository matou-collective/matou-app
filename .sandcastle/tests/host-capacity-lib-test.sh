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

# --- HOST_CAPACITY_DRIVE_MODE (#46) ----------------------------------------
# single-slot: the drive keeps slot 1 (and any sibling lock it names) but hands
# every pooled slot past the first back to the pool, so one worker can run
# beside it on a big host. exclusive (set OR unset) grabs every pooled slot —
# byte-identical to the pre-#46 behaviour.

# single-slot, only the pooled slots named -> holds EXACTLY slot 1, leaves slot 2.
: > "$slot1"; : > "$slot2"
out="$(bash -c '
  . "$1"
  export HOST_CAPACITY_DRIVE_MODE=single-slot
  host_capacity_acquire_exclusive "$2" "$3" && echo ok
  # slot 1 held (a fresh flock -n on it must FAIL); slot 2 left to the pool
  # (a fresh flock -n on it must SUCCEED).
  exec 8>"$2"; flock -n 8 && echo "LEAK:slot1-not-held"
  exec 7>"$3"; flock -n 7 && echo slot2-free
  echo "fds=$(set -- $HOST_CAPACITY_EXCLUSIVE_FDS; echo $#)"
  true
' _ "$lib" "$slot1" "$slot2")"
[[ "$out" == *ok* ]]          || fail "single-slot exclusive acquire must succeed, got: $out"
[[ "$out" != *LEAK* ]]        || fail "single-slot must still HOLD slot 1: $out"
[[ "$out" == *slot2-free* ]]  || fail "single-slot must LEAVE slot 2 to the pool, got: $out"
[[ "$out" == *fds=1* ]]       || fail "single-slot must hold exactly one lock (slot 1), got: $out"
pass=$((pass+1))

# single-slot still HOLDS a sibling lock the drive names (only pooled slots past
# the first are released) — a drive's healer/session-runner lock is unaffected.
: > "$slot1"; : > "$slot2"; : > "$side"
out="$(bash -c '
  . "$1"
  export HOST_CAPACITY_DRIVE_MODE=single-slot
  host_capacity_acquire_exclusive "$2" "$3" "$4" && echo ok
  exec 8>"$2"; flock -n 8 && echo "LEAK:slot1-not-held"
  exec 9>"$4"; flock -n 9 && echo "LEAK:side-not-held"
  exec 7>"$3"; flock -n 7 && echo slot2-free
  echo "fds=$(set -- $HOST_CAPACITY_EXCLUSIVE_FDS; echo $#)"
  true
' _ "$lib" "$slot1" "$slot2" "$side")"
[[ "$out" == *ok* ]]          || fail "single-slot acquire with a sibling lock must succeed, got: $out"
[[ "$out" != *LEAK* ]]        || fail "single-slot must hold slot 1 AND the sibling lock: $out"
[[ "$out" == *slot2-free* ]]  || fail "single-slot must still leave slot 2 to the pool: $out"
[[ "$out" == *fds=2* ]]       || fail "single-slot must hold slot 1 + the sibling (2 fds), got: $out"
pass=$((pass+1))

# exclusive, set EXPLICITLY -> grabs BOTH pooled slots (old behaviour).
: > "$slot1"; : > "$slot2"
out="$(bash -c '
  . "$1"
  export HOST_CAPACITY_DRIVE_MODE=exclusive
  host_capacity_acquire_exclusive "$2" "$3" && echo ok
  exec 7>"$3"; flock -n 7 && echo "LEAK:slot2-not-held"
  echo "fds=$(set -- $HOST_CAPACITY_EXCLUSIVE_FDS; echo $#)"
  true
' _ "$lib" "$slot1" "$slot2")"
[[ "$out" == *ok* ]]     || fail "explicit exclusive acquire must succeed, got: $out"
[[ "$out" != *LEAK* ]]   || fail "explicit exclusive must grab BOTH pooled slots: $out"
[[ "$out" == *fds=2* ]]  || fail "explicit exclusive must hold both pooled slots (2 fds), got: $out"
pass=$((pass+1))

# UNSET == exclusive -> byte-identical, grabs BOTH pooled slots.
: > "$slot1"; : > "$slot2"
out="$(bash -c '
  . "$1"
  unset HOST_CAPACITY_DRIVE_MODE
  host_capacity_acquire_exclusive "$2" "$3" && echo ok
  exec 7>"$3"; flock -n 7 && echo "LEAK:slot2-not-held"
  echo "fds=$(set -- $HOST_CAPACITY_EXCLUSIVE_FDS; echo $#)"
  true
' _ "$lib" "$slot1" "$slot2")"
[[ "$out" == *ok* ]]     || fail "unset drive-mode acquire must succeed, got: $out"
[[ "$out" != *LEAK* ]]   || fail "unset drive-mode must default to exclusive (grab both slots): $out"
[[ "$out" == *fds=2* ]]  || fail "unset drive-mode must hold both pooled slots (2 fds), got: $out"
pass=$((pass+1))

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

# --- drive reservation carries the reserving issue number (#24) ------------
# The predicate still yields on an EMPTY reservation (today's touch-file, and any
# producer still on the pre-#24 pin — backward compatible); the new helper reads
# the drive number ONLY when the producer wrote one, so the consumer's admit
# exception (proceed iff the next claim unblocks THIS drive) can never fire on an
# empty file. A malformed reservation carries no number — never mis-admits.
res="$(mktemp -u)"
export HOST_CAPACITY_DRIVE_WANTED="$res"
trap 'rm -f "$slot1" "$slot2" "$side" "$res"' EXIT
bash -c '. "$1"; host_capacity_drive_reserve' _ "$lib"           # empty touch-file
bash -c '. "$1"; host_capacity_drive_wanted' _ "$lib" \
  || fail "an empty reservation must STILL be wanted (unconditional-yield preserved)"
out="$(bash -c '. "$1"; host_capacity_drive_wanted_issue' _ "$lib")"
[ -z "$out" ] || fail "an empty reservation must carry NO issue number, got: $out"
printf '668\n' > "$res"                                          # producer names the drive
bash -c '. "$1"; host_capacity_drive_wanted' _ "$lib" \
  || fail "a numbered reservation must still be wanted"
out="$(bash -c '. "$1"; host_capacity_drive_wanted_issue' _ "$lib")"
[ "$out" = 668 ] || fail "the helper must return the reserving drive number, got: $out"
printf 'garbage\n' > "$res"                                      # malformed → no number
out="$(bash -c '. "$1"; host_capacity_drive_wanted_issue' _ "$lib")"
[ -z "$out" ] || fail "a non-numeric reservation must carry no issue number, got: $out"
rm -f "$res"
out="$(bash -c '. "$1"; host_capacity_drive_wanted_issue' _ "$lib")"       # absent
[ -z "$out" ] || fail "an absent reservation must carry no issue number, got: $out"
unset HOST_CAPACITY_DRIVE_WANTED
trap 'rm -f "$slot1" "$slot2" "$side"' EXIT
pass=$((pass+1))

# --- drive reservation age (#30): the yield log line reports how old the ------
# reservation is, so a consumer's "yielded" line and the executor's "skipped N
# ticks" line corroborate on the SAME reservation. A fresh reserve reads ~0s; a
# back-dated file reads its real age (independent of the TTL); an absent file
# yields nothing at rc 1.
age_wanted="$(mktemp -u)"
export HOST_CAPACITY_DRIVE_WANTED="$age_wanted"
trap 'rm -f "$slot1" "$slot2" "$side" "$age_wanted"' EXIT
bash -c '. "$1"; host_capacity_drive_wanted_age' _ "$lib" \
  && fail "an absent reservation must report no age (rc 1)"
bash -c '. "$1"; host_capacity_drive_reserve' _ "$lib"
age="$(bash -c '. "$1"; host_capacity_drive_wanted_age' _ "$lib")" \
  || fail "a fresh reservation must report an age"
case "$age" in ''|*[!0-9]*) fail "age must be a whole number of seconds, got: '$age'" ;; esac
[ "$age" -lt 5 ] || fail "a just-declared reservation must read a small age, got: ${age}s"
touch -d '@1' "$age_wanted"
age="$(bash -c '. "$1"; host_capacity_drive_wanted_age' _ "$lib")" \
  || fail "a back-dated reservation must still report its age (independent of the TTL)"
[ "$age" -gt 900 ] || fail "a 1970-dated reservation must read a large age, got: ${age}s"
bash -c '. "$1"; host_capacity_drive_release' _ "$lib"
unset HOST_CAPACITY_DRIVE_WANTED
trap 'rm -f "$slot1" "$slot2" "$side"' EXIT
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

# --- reservation WINDOW (#93): the full posted->started span, not per-tick -----
# host_capacity_drive_wanted_age reads WANTED's mtime, which every re-declaring
# tick refreshes for the TTL — so it can only report the per-tick age. The window
# must survive re-declares: the SINCE marker is created once per episode and its
# mtime is NEVER disturbed by a re-reserve, so a drive that starved across many
# ticks still reads its TRUE deferred-work window. Absent episode -> rc 1.
win_wanted="$(mktemp -u)"; win_since="${win_wanted}-since"
export HOST_CAPACITY_DRIVE_WANTED="$win_wanted"
unset HOST_CAPACITY_DRIVE_WANTED_SINCE  # let it derive from WANTED (test isolation)
trap 'rm -f "$slot1" "$slot2" "$side" "$win_wanted" "$win_since"' EXIT
bash -c '. "$1"; host_capacity_drive_wanted_window' _ "$lib" \
  && fail "no open reservation episode must report no window (rc 1)"
bash -c '. "$1"; host_capacity_drive_reserve' _ "$lib"
[ -e "$win_since" ] || fail "reserve must create the first-post SINCE marker"
win="$(bash -c '. "$1"; host_capacity_drive_wanted_window' _ "$lib")" \
  || fail "an open reservation must report a window"
case "$win" in ''|*[!0-9]*) fail "window must be a whole number, got: '$win'" ;; esac
[ "$win" -lt 5 ] || fail "a just-opened episode must read a small window, got: ${win}s"
# Back-date the FIRST-POST marker to 1970, then re-reserve: WANTED's mtime is
# refreshed (small age) but SINCE is untouched (large window) — the whole point.
touch -d '@1' "$win_since"
bash -c '. "$1"; host_capacity_drive_reserve' _ "$lib"   # a later starving tick re-declares
age="$(bash -c '. "$1"; host_capacity_drive_wanted_age' _ "$lib")"
win="$(bash -c '. "$1"; host_capacity_drive_wanted_window' _ "$lib")"
[ "$age" -lt 5 ]   || fail "a re-declare must refresh the per-tick age, got: ${age}s"
[ "$win" -gt 900 ] || fail "a re-declare must NOT reset the reservation window, got: ${win}s"
bash -c '. "$1"; host_capacity_drive_release' _ "$lib"
[ ! -e "$win_since" ] || fail "release must remove the first-post SINCE marker"
bash -c '. "$1"; host_capacity_drive_wanted_window' _ "$lib" \
  && fail "a released episode must report no window (rc 1)"
unset HOST_CAPACITY_DRIVE_WANTED
trap 'rm -f "$slot1" "$slot2" "$side"' EXIT
pass=$((pass+1))

# --- durable drive-lifecycle log (#93): append-only start/end records ----------
# The live drive-status file is overwritten by the next drive; this JSONL log is
# the permanent host-side record. Start captures box/target/mode + the
# reservation window; end is a separate appended line so it survives the next
# drive; a later drive NEVER overwrites an earlier one's lines.
if command -v jq >/dev/null 2>&1; then
  dlog="$(mktemp -u)"; dwanted="$(mktemp -u)"; dsince="${dwanted}-since"
  export HOST_CAPACITY_DRIVE_LOG="$dlog" HOST_CAPACITY_DRIVE_WANTED="$dwanted"
  unset HOST_CAPACITY_DRIVE_WANTED_SINCE
  trap 'rm -f "$slot1" "$slot2" "$side" "$dlog" "$dwanted" "$dsince"' EXIT
  bash -c '
    . "$1"
    host_capacity_drive_reserve
    touch -d "@1" "$2"                                  # a long-starved episode
    export HOST_CAPACITY_DRIVE_MODE=exclusive
    host_capacity_drive_log_start d1 box-alpha 42 single-slot   # explicit mode wins
    host_capacity_drive_log_start d2 box-alpha Acme/widget      # mode defaults to env
    host_capacity_drive_log_end d1 completed
  ' _ "$lib" "$dsince"
  [ -f "$dlog" ] || fail "drive log was never written"
  lines="$(wc -l <"$dlog")"
  [ "$lines" -eq 3 ] || fail "append-only log must hold 3 lines (2 starts + 1 end), got: $lines"
  # d1 start: box/target/mode captured, reservation window credited from SINCE.
  s1="$(jq -c 'select(.event=="start" and .id=="d1")' "$dlog")"
  [ "$(jq -r '.box' <<<"$s1")" = box-alpha ]      || fail "d1 box not recorded: $s1"
  [ "$(jq -r '.target' <<<"$s1")" = 42 ]          || fail "d1 target not recorded: $s1"
  [ "$(jq -r '.mode' <<<"$s1")" = single-slot ]   || fail "d1 explicit mode not recorded: $s1"
  win="$(jq -r '.reservation_window_s' <<<"$s1")"
  case "$win" in ''|null|*[!0-9]*) fail "d1 reservation window not captured: $s1" ;; esac
  [ "$win" -gt 900 ] || fail "d1 must credit the FULL reservation window, got: ${win}s"
  # d2 start: mode falls back to the live HOST_CAPACITY_DRIVE_MODE.
  s2="$(jq -c 'select(.event=="start" and .id=="d2")' "$dlog")"
  [ "$(jq -r '.mode' <<<"$s2")" = exclusive ]     || fail "d2 mode did not default to env: $s2"
  [ "$(jq -r '.target' <<<"$s2")" = Acme/widget ] || fail "d2 target not recorded: $s2"
  # end line for d1 present, independent and permanent.
  e1="$(jq -c 'select(.event=="end" and .id=="d1")' "$dlog")"
  [ "$(jq -r '.verdict' <<<"$e1")" = completed ]  || fail "d1 end verdict not recorded: $e1"
  # No reservation open -> window records null, and a default verdict applies.
  bash -c '. "$1"; host_capacity_drive_release; host_capacity_drive_log_start d3 box-alpha 9; host_capacity_drive_log_end d3' _ "$lib"
  s3="$(jq -c 'select(.event=="start" and .id=="d3")' "$dlog")"
  [ "$(jq -r '.reservation_window_s' <<<"$s3")" = null ] || fail "d3 with no reservation must record null window: $s3"
  e3="$(jq -c 'select(.event=="end" and .id=="d3")' "$dlog")"
  [ "$(jq -r '.verdict' <<<"$e3")" = ended ] || fail "d3 end must default to 'ended': $e3"
  unset HOST_CAPACITY_DRIVE_LOG HOST_CAPACITY_DRIVE_WANTED HOST_CAPACITY_DRIVE_MODE
  trap 'rm -f "$slot1" "$slot2" "$side"' EXIT
  pass=$((pass+1))
else
  echo "host-capacity-lib: jq absent — skipping drive-log group" >&2
fi


echo "host-capacity-lib: $pass groups passed"
