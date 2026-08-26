#!/usr/bin/env bash
# Offline test for the swarm/triage host-lock YIELD behaviour (#238 AC1).
# swarm.yml and triage.yml used to CAMP on /tmp/matou-swarm.lock with
# `flock -w 7200` — a second run blocked up to 2h, serializing hour-class waits
# and starving the sibling repo. They now `flock -n` and exit 0 cleanly instead,
# so queued runs drain in seconds. This pins that: while another process holds
# the lock, the yield snippet exits 0 FAST (it does not block), and when the
# lock is free it acquires and proceeds.
#
# The snippet below is kept byte-identical to the block in swarm.yml/triage.yml
# (only the lock path is injected, exactly as the debounce test mirrors its
# source). Run: bash .sandcastle/tests/swarm-lock-yield-test.sh
set -euo pipefail
fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0

lock="$(mktemp)"; ready="$(mktemp)"
trap 'rm -f "$lock" "$ready"' EXIT

# The decision under test, verbatim from swarm.yml (lock path injected).
# Echoes "yield" + exits 0 if the host is held; echoes "run" if it acquired.
yield_or_run() { # yield_or_run <lockpath>
  (
    exec 9>"$1"
    if ! flock -n 9; then
      echo "yield"
      exit 0
    fi
    echo "run"
  )
}

# --- free lock: the snippet acquires and proceeds ---
[ "$(yield_or_run "$lock")" = "run" ] || fail "a free lock must let the run proceed"
pass=$((pass+1))

# --- held lock: a second run must YIELD, exit 0, and NOT block ---
# A holder grabs the lock for 30s and signals readiness; we must never wait for
# it. A camping `flock -w` would hang here — the elapsed-time assertion is the
# real check that we yield instead of camp. The subshell `exec sleep`s so it
# leaves no child holding an inherited copy of the locked fd — killing $! then
# releases the lock cleanly (a plain `flock -c` would strand the sleep child).
( exec 9>"$lock"; flock -x 9; echo held > "$ready"; exec sleep 30 ) &
holder=$!
trap 'kill "$holder" 2>/dev/null || true; rm -f "$lock" "$ready"' EXIT
for _ in $(seq 1 50); do [ -s "$ready" ] && break; sleep 0.1; done
[ -s "$ready" ] || fail "the lock holder never acquired the lock — test setup broken"

start="$(date +%s)"
out="$(yield_or_run "$lock")"; rc=$?
elapsed="$(( $(date +%s) - start ))"

[ "$rc" -eq 0 ]      || fail "a yielding run must exit 0 (got $rc), so the healer's if:failure() never fires"
[ "$out" = "yield" ] || fail "a held lock must make the second run yield, got: $out"
[ "$elapsed" -lt 5 ] || fail "the second run camped ${elapsed}s instead of yielding fast — flock is not -n"
pass=$((pass+1))

# --- lock released: the next run acquires again (yield left no residue) ---
kill "$holder" 2>/dev/null || true; wait "$holder" 2>/dev/null || true
[ "$(yield_or_run "$lock")" = "run" ] || fail "once the holder is gone the lock must be acquirable again"
pass=$((pass+1))

echo "swarm-lock-yield: $pass groups passed"
