#!/usr/bin/env bash
# Offline test for run-ci-checks.sh's capacity-deferral path (#548).
#
# A contended ci camps host-slot-wait.sh for a bounded window and then gives up
# with exit 75 (EX_TEMPFAIL). Before this, that exit red main: the job failed,
# the healer was invoked on a non-fault, and the seam verdict named a stage that
# never ran. pr-e2e already solved the same problem the other way (#278: a loud
# state=pending placeholder plus a scheduled sweep that re-dispatches).
#
# What this proves:
#   1. a capacity give-up exits 75, prints the CI_DEFERRED marker, and writes NO
#      seam verdict — the healer's no-fresh-verdict branch is never reached
#      because there is no fault to investigate;
#   2. a REAL stage failure still exits non-zero AND still writes the verdict
#      with its stage and error lines — the #197 writer half is untouched;
#   3. the deferral marker names the stage that could not start, so the sweep's
#      log and the commit status can say which half of ci was starved.
#
# No network, no docker. Run: bash .sandcastle/tests/ci-deferral-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
script="$root/run-ci-checks.sh"
fail() { echo "FAIL: $1" >&2; exit 1; }
pass=0

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
verdict="$tmp/seam-verdict.txt"

# run_ci <host-slot-wait-exit> [docker-exit] -> RC, OUT
# Shims BOTH heavy commands the script wraps: host-slot-wait.sh (the camp) and
# docker (the work). The real script calls host-slot-wait.sh by path from its
# own dir, so the shim is installed there and restored afterwards.
run_ci() {
  local slot_exit="$1" docker_exit="${2:-0}"
  cat > "$tmp/bin/docker" <<SH
#!/usr/bin/env bash
echo "==> stage: npm ci"
exit $docker_exit
SH
  chmod +x "$tmp/bin/docker"
  cat > "$root/host-slot-wait.sh.testshim" <<SH
#!/usr/bin/env bash
# args: <timeout> <cmd...> — mimic the real wrapper's two outcomes.
shift
if [ "$slot_exit" != 0 ]; then
  echo "host-slot-wait: host capacity still busy after 1800s — giving up" >&2
  exit $slot_exit
fi
exec "\$@"
SH
  chmod +x "$root/host-slot-wait.sh.testshim"
  cp "$root/host-slot-wait.sh" "$tmp/host-slot-wait.sh.real"
  cp "$root/host-slot-wait.sh.testshim" "$root/host-slot-wait.sh"
  RC=0
  OUT="$(PATH="$tmp/bin:$PATH" SEAM_VERDICT_PATH="$verdict" REPO_SLUG=Acme/widget \
    bash "$script" 2>&1)" || RC=$?
  cp "$tmp/host-slot-wait.sh.real" "$root/host-slot-wait.sh"
  rm -f "$root/host-slot-wait.sh.testshim"
}

# --- 1. a capacity give-up is a DEFERRAL, not a fault ---
rm -f "$verdict"
run_ci 75
[ "$RC" = 75 ] || fail "a capacity give-up must exit 75 so ci.yml can tell it from a real failure, got $RC:
$OUT"
grep -q 'CI_DEFERRED' <<<"$OUT" \
  || fail "the give-up must print the CI_DEFERRED marker ci.yml keys on:
$OUT"
[ ! -f "$verdict" ] \
  || fail "a capacity give-up must write NO seam verdict — there is no fault to investigate:
$(cat "$verdict")"
pass=$((pass+1))

# --- 2. the deferral names the stage that could not start ---
grep -q 'CI_DEFERRED.*docker build' <<<"$OUT" \
  || fail "the marker must name the starved stage so the sweep can say which half was contended:
$OUT"
pass=$((pass+1))

# --- 3. a REAL failure still reds, and still writes the verdict (#197) ---
rm -f "$verdict"
run_ci 0 1
[ "$RC" != 0 ] || fail "a failing stage must still exit non-zero:
$OUT"
[ "$RC" != 75 ] || fail "a real failure must NOT masquerade as a capacity deferral"
[ -f "$verdict" ] || fail "a real failure must still write the seam verdict (#197 writer half)"
grep -q '^stage=' "$verdict" || fail "the verdict must name its stage:
$(cat "$verdict")"
grep -q 'npm ci' "$verdict" \
  || fail "the verdict must refine the stage from the container's own marker:
$(cat "$verdict")"
grep -q 'CI_DEFERRED' <<<"$OUT" && fail "a real failure must not print the deferral marker"
pass=$((pass+1))

# --- 4. a clean run leaves neither verdict nor marker ---
rm -f "$verdict"
run_ci 0 0
[ "$RC" = 0 ] || fail "a clean run must exit 0, got $RC:
$OUT"
[ ! -f "$verdict" ] || fail "a clean run must leave no verdict:
$(cat "$verdict")"
grep -q 'CI_DEFERRED' <<<"$OUT" && fail "a clean run must not print the deferral marker"
pass=$((pass+1))

echo "ci-deferral: $pass scenarios passed"
