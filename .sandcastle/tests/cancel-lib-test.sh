#!/usr/bin/env bash
# Offline tests for cancel-lib.sh — the operator-cancel kill-path (#612,
# idss ADR 0186). Two independent surfaces:
#   1. the marker-file protocol the TUI and main.mts agree on
#   2. the log-side detector run-swarm.sh's retry loop uses, byte-for-byte
#      the same shape as limit-lib.sh's claude_limit_hit (tests/limit-lib-test.sh)
# Run: bash tests/cancel-lib-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0

SWARM_CANCEL_DIR="$(mktemp -d)"
export SWARM_CANCEL_DIR
trap 'rm -rf "$SWARM_CANCEL_DIR"' EXIT
. "$here/../cancel-lib.sh"

# --- marker-file protocol -----------------------------------------------

run_id="idss-1755600000-12345"

if swarm_cancel_requested "$run_id"; then
  fail "no marker written yet — must read as not-requested"
fi
pass=$((pass+1))

swarm_cancel_request "$run_id" "operator: stuck on iteration 2"
swarm_cancel_requested "$run_id" || fail "a written marker must read as requested"
[ "$(swarm_cancel_reason "$run_id")" = "operator: stuck on iteration 2" ] \
  || fail "reason must round-trip through the marker file"
pass=$((pass+1))

# a DIFFERENT run's marker must never be visible to this run_id (#612: one
# file per run_id, never a shared/global marker)
other_run="idss-1755600001-99999"
swarm_cancel_requested "$other_run" && fail "an unrelated run must never read as cancelled"
pass=$((pass+1))

swarm_cancel_clear "$run_id"
swarm_cancel_requested "$run_id" && fail "clearing the marker must consume the request"
pass=$((pass+1))

# clearing an already-absent marker (a second clear, or a run that was never
# cancelled) must be a quiet no-op, never an error under set -e
swarm_cancel_clear "$run_id"
pass=$((pass+1))

# request must mkdir -p a not-yet-existing SWARM_CANCEL_DIR (the TUI may be
# the very first writer on a fresh host)
rm -rf "$SWARM_CANCEL_DIR"
swarm_cancel_request "$run_id" "" || fail "request must succeed even when the dir doesn't exist yet"
swarm_cancel_requested "$run_id" || fail "request must have created the dir and the marker"
pass=$((pass+1))

# an EMPTY reason is a valid request (TUI operator declined to type one) —
# distinct from "no marker at all", never conflated
[ -z "$(swarm_cancel_reason "$run_id")" ] || fail "an empty reason must round-trip as empty, not fabricated"
pass=$((pass+1))

# --- log-side detector: main.mts's SANDCASTLE_CANCELLED marker line -----

tmp="$(mktemp)"; trap 'rm -f "$tmp"; rm -rf "$SWARM_CANCEL_DIR"' EXIT

printf 'Iteration 1/3\nAgent started\n' > "$tmp"
swarm_cancel_hit "$tmp" && fail "an ordinary log must never read as cancelled"
pass=$((pass+1))

printf 'Iteration 2/3\nSANDCASTLE_CANCELLED run=%s reason=operator: stuck\nworker: exiting\n' "$run_id" > "$tmp"
swarm_cancel_hit "$tmp" || fail "the SANDCASTLE_CANCELLED marker line must be detected"
[ "$(swarm_cancel_hit_reason "$tmp")" = "operator: stuck" ] \
  || fail "the reason= tail must be extracted, got: $(swarm_cancel_hit_reason "$tmp")"
pass=$((pass+1))

# an UNSPECIFIED reason (operator cancelled with no text) must still detect
# as cancelled, with an empty (not fabricated) reason
printf 'SANDCASTLE_CANCELLED run=%s reason=\n' "$run_id" > "$tmp"
swarm_cancel_hit "$tmp" || fail "a cancel marker with an empty reason must still be detected"
[ -z "$(swarm_cancel_hit_reason "$tmp")" ] || fail "an empty reason= tail must not be fabricated"
pass=$((pass+1))

# must NOT fire on a merely-mentioned word "cancelled" in unrelated prose — a
# false positive here would misreport a real crash as an intentional stop
printf 'the agent said the task was not cancelled, just blocked\n' > "$tmp"
swarm_cancel_hit "$tmp" && fail "prose containing the word cancelled must not false-positive"
pass=$((pass+1))

# realistic multi-line worker log, marker buried mid-stream
printf '%s\n' \
  "Iteration 1/3" \
  "Setting up sandbox done (5.8s)" \
  "Agent started" \
  "SANDCASTLE_CANCELLED run=$run_id reason=operator: wrong ticket picked up" \
  "worker: run() rejected (AbortError) — exiting 1" > "$tmp"
swarm_cancel_hit "$tmp" || fail "must find the marker line inside a full worker log"
[ "$(swarm_cancel_hit_reason "$tmp")" = "operator: wrong ticket picked up" ] \
  || fail "reason extraction must survive surrounding log noise"
pass=$((pass+1))

echo "cancel-lib: $pass groups passed"
