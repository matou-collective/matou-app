#!/usr/bin/env bash
# Offline unit test for verdict-lib.sh's explicit error-line capture (#9).
#
# A guard that FATAL-s to the job's stderr (the cold-pnpm-store / .env-allowlist
# guards in run-swarm.sh) has no errlog file for verdict_write to grep, so the
# verdict's `--- error lines ---` block used to come out EMPTY and the healer
# keyed its signature on the bare stage. verdict_error <line> records the FATAL
# so the writer emits it as the run's error line. Run:
#   bash .sandcastle/tests/verdict-lib-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sc="$here/.."
. "$sc/verdict-lib.sh"
. "$sc/heal-lib.sh"   # seam_verdict_signal — the healer's reader

fail() { echo "FAIL: $1" >&2; exit 1; }
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
pass=0

# --- 1. verdict_error is emitted as the error line when there is no errlog. ---
vp="$tmp/v1.txt"
( verdict_begin "$vp"; verdict_stage "pnpm store warm check (#489)"
  verdict_error "run-swarm: FATAL — pnpm store /x/pnpm-store is EMPTY: workers cannot install (GOTCHAS #20, #489)."
  verdict_write 1 )
[ -f "$vp" ] || fail "verdict_write produced no artifact on a non-zero exit"
grep -q '^stage=pnpm store warm check (#489)$' "$vp" || fail "stage= not recorded:
$(cat "$vp")"
grep -q 'pnpm store /x/pnpm-store is EMPTY' "$vp" || fail "the FATAL was not captured as the error line:
$(cat "$vp")"
# The healer's own parser must recover a non-empty signal (stage :: error) — the
# whole point of #9 is that it no longer degrades to a bare stage / unknown.
sig="$(seam_verdict_signal "$vp")"
case "$sig" in
  "pnpm store warm check (#489) :: run-swarm: FATAL"*) ;;
  *) fail "seam_verdict_signal did not recover stage :: FATAL, got: $sig" ;;
esac
pass=$((pass+1))

# --- 2. verdict_stage clears a prior stage's explicit error (no leak). ---
vp="$tmp/v2.txt"
( verdict_begin "$vp"; verdict_stage "guard A"; verdict_error "FATAL A"
  verdict_stage "guard B"   # a later stage with its OWN, unrelated failure
  verdict_write 1 )
grep -q '^stage=guard B$' "$vp" || fail "stage B not recorded"
grep -q 'FATAL A' "$vp" && fail "a prior stage's FATAL leaked into guard B's verdict:
$(cat "$vp")"
pass=$((pass+1))

# --- 3. An errlog still wins: verdict_error is only the fallback for a stage
#        that has no readable log. ---
vp="$tmp/v3.txt"; errlog="$tmp/e3.log"
printf 'compiling\nerror: undefined symbol foo\n' > "$errlog"
( verdict_begin "$vp"; verdict_stage "build" "$errlog"; verdict_error "unused fallback"
  verdict_write 3 )
grep -q 'undefined symbol foo' "$vp" || fail "errlog error line was not used:
$(cat "$vp")"
grep -q 'unused fallback' "$vp" && fail "verdict_error overrode a real errlog line:
$(cat "$vp")"
pass=$((pass+1))

# --- 4. A clean (exit 0) run writes nothing, even with an error queued. ---
vp="$tmp/v4.txt"
( verdict_begin "$vp"; verdict_stage "guard"; verdict_error "FATAL never happened"
  verdict_write 0 )
[ ! -f "$vp" ] || fail "verdict_write wrote a verdict on a CLEAN run"
pass=$((pass+1))

echo "verdict-lib: $pass scenarios passed"
