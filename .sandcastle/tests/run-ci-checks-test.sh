#!/usr/bin/env bash
# Offline test for run-ci-checks.sh (#388): the `ci` workflow's build + checks
# ran inline in ci.yml and wrote NO seam verdict, so heal.sh degraded EVERY red
# ci to the constant `ci|` signature (error_line found no verdict, no breadcrumb,
# dropped seam-degraded). run-ci-checks.sh now drops a stage/exit/error verdict
# in the exact format verdict-lib.sh's other callers use, keyed on the ACTUAL
# failing leg — so two ci failures with different legs yield two different
# signatures. No network, no real docker: `docker` and the toolchain (npm/go/
# make/golangci-lint/git) are fakes on PATH; host-slot-wait rides temp slots.
# Run: bash .sandcastle/tests/run-ci-checks-test.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sc="$here/.."
fail() { echo "FAIL: $1" >&2; exit 1; }
. "$sc/heal-lib.sh"   # compute_signature, seam_verdict_signal

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
mkdir -p "$work/ws/frontend" "$work/ws/backend"

# --- fake toolchain -----------------------------------------------------------
# One dispatcher stands in for every tool the container script invokes. It exits
# 0 unless "<name> <args>" contains $FAIL_MATCH, so a test can push a chosen leg
# red while every other leg stays green.
bin="$work/bin"; mkdir -p "$bin"
cat > "$bin/_tool" <<'EOF'
#!/usr/bin/env bash
line="$(basename "$0") $*"
if [ -n "${FAIL_MATCH:-}" ] && printf '%s' "$line" | grep -qF -- "$FAIL_MATCH"; then
  echo "FAKE-FAIL: $line" >&2
  exit 1
fi
exit 0
EOF
chmod +x "$bin/_tool"
for t in npm go make golangci-lint git; do ln -sf _tool "$bin/$t"; done

# fake docker: `build` honours DOCKER_BUILD_FAIL; `run` executes the embedded
# `-lc` script in-place (fake tools already on PATH, CWD is the fake workspace),
# so the ::ci-stage:: breadcrumbs and set -euo pipefail behaviour are exercised
# for real — the failing leg's breadcrumb is genuinely the last one printed.
cat > "$bin/docker" <<'EOF'
#!/usr/bin/env bash
sub="$1"; shift || true
if [ "$sub" = build ]; then
  [ -n "${DOCKER_BUILD_FAIL:-}" ] && { echo "FAKE-FAIL: docker build" >&2; exit 1; }
  echo "fake docker build ok"; exit 0
fi
if [ "$sub" = run ]; then
  script=""
  while [ $# -gt 0 ]; do
    [ "$1" = -lc ] && { script="$2"; break; }
    shift
  done
  bash -c "$script"
  exit $?
fi
exit 0
EOF
chmod +x "$bin/docker"

verdict="$work/seam-verdict.txt"
run_ci() { # run_ci [FAIL_MATCH] [DOCKER_BUILD_FAIL]
  ( cd "$work/ws" && \
    PATH="$bin:$PATH" \
    HOST_CAPACITY_SLOTS="$work/slot1 $work/slot2" \
    HOST_CAPACITY_DRIVE_WANTED="$work/drive-wanted" \
    REPO_SLUG="x/y" CI_CONTAINER="ci-test" CI_RUN_ID="1" \
    CI_SLOT_WAIT_TIMEOUT="10" \
    SEAM_VERDICT_PATH="$verdict" \
    FAIL_MATCH="${1:-}" DOCKER_BUILD_FAIL="${2:-}" \
    bash "$sc/run-ci-checks.sh" )
}

# --- 1) a clean run leaves no verdict, and clears a stale one ------------------
printf 'stage=stale from a previous incident\nexit=1\n--- error lines ---\nold\n' > "$verdict"
if ! run_ci "" "" >/dev/null 2>&1; then fail "an all-green ci run must exit 0"; fi
[ -f "$verdict" ] && fail "a clean ci run must leave no verdict (verdict_write's contract)"

# --- 2) a docker-build failure writes a build-stage verdict -------------------
rm -f "$verdict"
if run_ci "" "1" >/dev/null 2>&1; then fail "a failing docker build must fail the run"; fi
[ -f "$verdict" ] || fail "a docker-build failure must write a verdict"
grep -q "^stage=docker build" "$verdict" || fail "verdict must name the docker-build stage, got: $(cat "$verdict")"
grep -q "^exit=[1-9]" "$verdict" || fail "verdict must carry a non-zero exit, got: $(cat "$verdict")"

# --- 3) the FAILING LEG names the stage, and distinct legs -> distinct sigs ----
declare -A sigs
check_leg() { # check_leg <FAIL_MATCH> <expected-stage-substring>
  rm -f "$verdict"
  if run_ci "$1" "" >/dev/null 2>&1; then fail "leg '$1' should have failed the run"; fi
  [ -f "$verdict" ] || fail "leg '$1' failure must write a verdict"
  grep -q "^stage=.*$2" "$verdict" || fail "verdict must name the '$2' leg, got: $(cat "$verdict")"
  seam_verdict_signal "$verdict" | grep -qi 'fake-fail' || fail "seam_verdict_signal must recover the error line for '$1', got: $(seam_verdict_signal "$verdict")"
  sigs["$2"]="$(compute_signature ci "$(seam_verdict_signal "$verdict")")"
}
check_leg "npm ci"          "frontend npm ci"
check_leg "run test:script" "frontend test:script"
check_leg "make test"       "backend make test"
check_leg "golangci-lint"   "backend golangci-lint"
check_leg "git diff"        "frontend kit:apply drift"

# Every leg above must hash to a DIFFERENT incident signature — the whole point
# of #388 (a moved fault must re-trigger investigation, not dedup onto `ci|`).
mapfile -t vals < <(printf '%s\n' "${sigs[@]}" | sort -u)
[ "${#vals[@]}" -eq "${#sigs[@]}" ] || fail "distinct failing legs must yield distinct signatures, got: ${sigs[*]}"

echo "run-ci-checks: $(( 2 + ${#sigs[@]} )) scenarios passed"
