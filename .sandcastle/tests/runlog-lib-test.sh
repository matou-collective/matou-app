#!/usr/bin/env bash
# Offline tests for runlog-lib.sh — the host-side exit-reason log and the green
# wedge predicate that run-swarm.sh uses so a run with a non-empty ready set
# either spawns a worker or fails loud, never green-and-empty (#435).
# Run: bash .sandcastle/tests/runlog-lib-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../runlog-lib.sh
. "$here/../runlog-lib.sh"
fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0

# --- runlog_line: deterministic format, ready-set numbers, duration ----------
line="$(runlog_line 1000 1042 Matou/ourcloud 432 completed 0)"
[ "$line" = "1970-01-01T00:17:22Z repo=Matou/ourcloud ready=[432] reason=completed exit=0 duration=42s" ] \
  || fail "unexpected line format: $line"
pass=$((pass+1))

# a multi-issue ready set is carried verbatim; a red exit code is preserved
line="$(runlog_line 500 560 Matou/ourcloud '426,432' no-worker-spawned 1)"
case "$line" in
  *"ready=[426,432]"*) : ;; *) fail "ready set not carried: $line" ;;
esac
case "$line" in
  *"reason=no-worker-spawned exit=1 duration=60s"* ) : ;; *) fail "reason/exit/duration wrong: $line" ;;
esac
pass=$((pass+1))

# an empty ready set (the no-ready-tasks exit) still logs a clean line
line="$(runlog_line 10 11 Matou/ourcloud '' no-ready-tasks 0)"
case "$line" in *"ready=[]"*"duration=1s"*) : ;; *) fail "empty ready line wrong: $line" ;; esac
pass=$((pass+1))

# --- runlog_append: creates the dir, appends one line per call ----------------
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
log="$tmp/nested/dir/run-swarm-verdicts.log"   # dir does not exist yet
runlog_append "$log" "$(runlog_line 0 5 r a completed 0)"
runlog_append "$log" "$(runlog_line 5 9 r b coalesced 0)"
[ "$(wc -l < "$log")" -eq 2 ] || fail "expected 2 appended lines, got $(wc -l < "$log")"
grep -q "reason=coalesced" "$log" || fail "second line missing"
pass=$((pass+1))

# an unwritable log path must never fail the caller (returns 0, run stays green)
if runlog_append /proc/nonexistent/cannot "line"; then : ; else fail "runlog_append must not fail its caller"; fi
pass=$((pass+1))

# --- worker_wedge: the green-empty predicate ---------------------------------
# non-empty ready + success + zero workers born => the #435 wedge
[ "$(worker_wedge 1 0 0)" = wedge ] || fail "1 ready, success, 0 workers must be a wedge"
[ "$(worker_wedge 3 0 0)" = wedge ] || fail "3 ready, success, 0 workers must be a wedge"
pass=$((pass+1))

# a worker was born => not a wedge (the normal healthy run)
[ -z "$(worker_wedge 1 0 1)" ] || fail "a spawned worker is never a wedge"
[ -z "$(worker_wedge 3 0 2)" ] || fail "partial-but-present workers is not a wedge"
pass=$((pass+1))

# already failed loud (exit != 0) => not THIS wedge; it is already red
[ -z "$(worker_wedge 1 1 0)" ] || fail "a loud failure is not the green wedge"
pass=$((pass+1))

# empty ready set is never a wedge (run-swarm exits before this in practice)
[ -z "$(worker_wedge 0 0 0)" ] || fail "an empty ready set is not a wedge"
pass=$((pass+1))

echo "runlog-lib: $pass groups passed"
