#!/usr/bin/env bash
# Offline test for run-swarm.sh's trigger coalescing.
#
# Until #2 this file kept a byte-for-byte COPY of the decision block from
# run-swarm.sh, because the surrounding script needed pnpm, docker and a live
# tracker to reach it. The coalescer now lives in schedule-lib.sh (the SCHEDULE
# seam) and this test drives the REAL function — a copy that can silently drift
# from its original is exactly the hazard the decomposition removed.
#
# The scenarios below are unchanged: they are the behaviour the copy pinned.
# Run: bash .sandcastle/tests/debounce-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/../schedule-lib.sh"

fail() { echo "FAIL: $1" >&2; exit 1; }
stamp="$(mktemp)"; trap 'rm -f "$stamp"' EXIT
pass=0

# decide <ready-json> <debounce-seconds> → "run" | "coalesce"
# schedule_debounce_decide additionally carries the coalesced age (so run-swarm
# can say "attempted Ns ago"); these scenarios only care about the ruling.
decide() { local d; d="$(schedule_debounce_decide "$1" "$stamp" "$2")"; printf '%s' "${d%% *}"; }

SET_A='[{"number":162},{"number":165},{"number":171}]'
SET_B='[{"number":165},{"number":171}]'   # 162 closed — the set changed

# first trigger always runs
[ "$(decide "$SET_A" 600)" = "run" ] || fail "a cold stamp must run"
pass=$((pass+1))

# the burst: four more triggers for the SAME ready set are dropped
for i in 1 2 3 4; do
  [ "$(decide "$SET_A" 600)" = "coalesce" ] || fail "duplicate trigger $i must coalesce"
done
pass=$((pass+1))

# work landed → the set changed → the next trigger runs IMMEDIATELY, no waiting
[ "$(decide "$SET_B" 600)" = "run" ] || fail "a changed ready set must run at once"
pass=$((pass+1))

# …and the new set is what's now being debounced
[ "$(decide "$SET_B" 600)" = "coalesce" ] || fail "the new set should debounce in turn"
[ "$(decide "$SET_A" 600)" = "run" ]      || fail "reverting to an older set is a real change"
pass=$((pass+1))

# window expiry: a zero-second window never coalesces, so the cron backstop and
# a genuine retry are never blocked by this
[ "$(decide "$SET_A" 0)" = "run" ] || fail "an expired window must run"
[ "$(decide "$SET_A" 0)" = "run" ] || fail "debounce must not latch once expired"
pass=$((pass+1))

# an empty ready set is still a set — but run-swarm exits before this point
# when n=0, so coalescing must not be what decides that case
[ "$(decide '[]' 600)" = "run" ] || fail "the empty set is just another change"
pass=$((pass+1))

echo "debounce: $pass groups passed"
