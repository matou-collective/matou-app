#!/usr/bin/env bash
# Offline tests for ../evidence-lib.sh (#596): picking one representative
# screenshot out of a run dir's evidence tree. No network.
# Run: bash .sandcastle/tests/evidence-lib-test.sh
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../evidence-lib.sh
. "$here/../evidence-lib.sh"

pass=0 fail=0
check() { if eval "$2"; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL: $1"; fi; }

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

# no run dir at all / an empty tree -> empty, never errors
check "a missing dir yields nothing (never errors)" \
  '[ -z "$(pick_representative_screenshot "$tmp/no-such-dir" 2>/dev/null)" ]'
mkdir -p "$tmp/empty"
check "an empty tree yields nothing" '[ -z "$(pick_representative_screenshot "$tmp/empty")" ]'

# newest *.png wins, regardless of how deep it is nested
mkdir -p "$tmp/run/artifacts/ceremony" "$tmp/run/artifacts/nextcloud"
: > "$tmp/run/artifacts/ceremony/step1.png"; sleep 0.05
: > "$tmp/run/artifacts/nextcloud/login.png"; sleep 0.05
: > "$tmp/run/artifacts/nextcloud/branded-chrome.png"
check "picks the newest png across nested artifact dirs" \
  '[ "$(pick_representative_screenshot "$tmp/run")" = "$tmp/run/artifacts/nextcloud/branded-chrome.png" ]'

# a non-png file never wins even when it is the newest thing in the tree
sleep 0.05; : > "$tmp/run/artifacts/notes.txt"
check "non-png files are ignored" \
  '[ "$(pick_representative_screenshot "$tmp/run")" = "$tmp/run/artifacts/nextcloud/branded-chrome.png" ]'

# a missing dir must never kill a `set -euo pipefail` caller — find failing
# to stat a nonexistent path fails the FIRST stage of the pipeline, and
# without the function's own `|| true`, pipefail would propagate that
# failure through sort/head/cut and trip the caller's `set -e`
# (rehearsal-cycle.sh's own shell options; #596 live-testing surfaced this).
out="$(bash -c 'set -euo pipefail; . "$1"; shot="$(pick_representative_screenshot "$2")"; echo "reached:[$shot]"' _ "$here/../evidence-lib.sh" "$tmp/no-such-dir" 2>&1)"
check "a missing dir never trips a set -euo pipefail caller" '[ "$out" = "reached:[]" ]'

echo "evidence-lib: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
