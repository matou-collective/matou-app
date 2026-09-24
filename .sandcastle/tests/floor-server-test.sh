#!/usr/bin/env bash
# floor-server-test.sh — the factory floor server's guard from the bash side
# (issue #150). The floor (fleet-tui/floor/) is the browser SVG companion to
# fleet-tui; its server re-broadcasts collector.py's one versioned JSON
# document to WebSocket clients, validating only snapshot_version + well-
# formedness. Its unit tests are Node (`node --test`), fed a recorded fixture
# in place of the live collector — no ssh, no network, no browser.
#
# fleet-tui/ is operator-side and vendor-excluded (onboarding/vendor-exclude),
# so it is ABSENT from a consumer's .sandcastle/ checkout even though this suite
# IS vendored there (tests/**). Skip LOUDLY on a missing dir — matching
# fleet-tui-test.sh — so a consumer's "run every vendored suite" contract stays
# honest. Node is operator-side too, so SKIP loudly (never fail) when it is
# absent, matching the pytest-suite posture in fleet-tui-test.sh.
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
floor="$repo/fleet-tui/floor"

if [ ! -d "$floor" ]; then
  echo "floor-server-test: SKIPPED — fleet-tui/floor/ is operator-side and"
  echo "  vendor-excluded, so it is absent from this (consumer) checkout."
  exit 0
fi

pass=0 fail=0
check() { if eval "$2"; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL: $1"; fi; }

# Structural, always run: the server must own no fleet arithmetic — it validates
# and re-broadcasts, the shape stays owned by Python. Guard against it ever
# reaching around the collector seam into fleet-tui internals.
check "server/ exists" '[ -d "$floor/server" ]'
check "web/ page exists" '[ -f "$floor/web/index.html" ]'
check "run.sh launcher parses" 'bash -n "$floor/run.sh"'
check "the floor reaches for NO python fleet module (one seam only)" \
  '! grep -rqE "require\(.*(snapshot|repostats|hostpoll|drives)|import .*(snapshot|repostats|hostpoll)" "$floor/server" "$floor/web"'

if ! command -v node >/dev/null 2>&1; then
  echo "floor-server-test: $pass/$((pass + fail)) structural checks; SKIPPED the node suite"
  echo "  no node on PATH. The floor server behaviour is UNCOVERED by this run."
  [ "$fail" -eq 0 ] || exit 1
  exit 0
fi

if (cd "$floor" && node --test server/*.test.js >/dev/null 2>&1); then
  pass=$((pass + 1))
else
  fail=$((fail + 1)); echo "FAIL: floor/server node --test suite"
  (cd "$floor" && node --test server/*.test.js 2>&1 | tail -20)
fi

echo "floor-server-test: $pass/$((pass + fail)) checks passed"
[ "$fail" -eq 0 ]
