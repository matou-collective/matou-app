#!/usr/bin/env bash
# Offline test for run-swarm.sh's trigger coalescing. Exercises the decision in
# isolation (the surrounding script needs pnpm, docker and a live tracker), so
# the logic below is kept a byte-for-byte copy of the block in run-swarm.sh.
# Run: bash .sandcastle/tests/debounce-test.sh
set -euo pipefail
fail() { echo "FAIL: $1" >&2; exit 1; }
stamp="$(mktemp)"; trap 'rm -f "$stamp"' EXIT
pass=0

# The decision under test, verbatim from run-swarm.sh (stamp path injected).
decide() { # decide <ready-json> <debounce-seconds> → "run" | "coalesce"
  local ready="$1" SWARM_DEBOUNCE="$2" ready_hash last_hash last_at
  ready_hash="$(printf '%s' "$ready" | sha1sum | cut -c1-16)"
  if [ -s "$stamp" ]; then
    read -r last_hash last_at < "$stamp" || true
    if [ "$last_hash" = "$ready_hash" ] &&
       [ $(( $(date +%s) - ${last_at:-0} )) -lt "$SWARM_DEBOUNCE" ]; then
      echo coalesce; return
    fi
  fi
  printf '%s %s\n' "$ready_hash" "$(date +%s)" > "$stamp"
  echo run
}

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
