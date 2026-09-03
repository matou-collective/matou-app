#!/usr/bin/env bash
# The fleet monitor's guard from the bash side. fleet-tui/ is OPERATOR-side
# and never vendored (onboarding/vendor-exclude), so the structural checks
# are inverted from tui-test.sh's: the exclusion itself, and the no-literal
# rule (deployment facts reach the app only via fleet.conf at run time).
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
fleet="$repo/fleet-tui"

# fleet-tui/ is operator-side and vendor-excluded (onboarding/vendor-exclude),
# so it is ABSENT from a consumer's .sandcastle/ checkout even though this suite
# IS vendored there (tests/**). Skip LOUDLY rather than fail every structural
# check on a missing dir — matching the no-pytest SKIP posture below and
# tui-test.sh's — so a consumer's "run every vendored suite" contract stays
# honest and this factory-root-only suite never reads as a bare "6 checks
# failed" (#87). Factory-side the dir is present and the checks run in full.
if [ ! -d "$fleet" ]; then
  echo "fleet-tui-test: SKIPPED — fleet-tui/ is operator-side and vendor-excluded,"
  echo "  so it is absent from this (consumer) checkout. Nothing to check here;"
  echo "  run this suite from the factory checkout where fleet-tui/ lives."
  exit 0
fi

pass=0 fail=0
check() { if eval "$2"; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL: $1"; fi; }

check "fleet-tui/ exists" '[ -d "$fleet" ]'
check "fleet-tui/** is vendor-excluded" \
  'grep -qx "fleet-tui/\*\*" "$repo/onboarding/vendor-exclude"'

check "run.sh launcher parses" 'bash -n "$fleet/run.sh"'

sources="$(find "$fleet" -type f \( -name "*.py" -o -name "*.sh" \) ! -path "*/.venv/*" ! -path "*/__pycache__/*" | sort)"
# limit-lib.sh's own marker literals are the one allowed exception (hostpoll.py).
literals="$(grep -rilE 'idss|ourcloud|git\.matou' $sources 2>/dev/null || true)"
check "no product literal under fleet-tui/" \
  '[ -z "$literals" ] || { echo "  named a product: $literals"; false; }'
matou_hits="$(grep -rn 'matou' $sources 2>/dev/null | grep -v '/tmp/matou-swarm-claude' || true)"
check "matou appears only in limit-lib.sh's verbatim marker paths" \
  '[ -z "$matou_hits" ] || { printf "%s\n" "$matou_hits"; false; }'

# The name `app` is shadowable in production (tui/app.py; the fleet app runs
# as __main__ under run.sh), so no sibling module may ever import it — the
# Drive/Usage/Loss blackout shipped exactly this way. fmtlib.py holds what
# they share (tests/test_prod_imports.py is the venv-side twin of this check).
# (tests/ are exempt: pytest imports through conftest, whose order is pinned.)
app_imports="$(grep -rnE '^\s*(from app import|import app\b)' $sources 2>/dev/null | grep -vE "fleet-tui/(app\.py|tests/)" || true)"
check "no fleet-tui module imports the shadowable name 'app'" \
  '[ -z "$app_imports" ] || { printf "%s\n" "$app_imports"; false; }'

py=""
if [ -x "$fleet/.venv/bin/python" ]; then py="$fleet/.venv/bin/python"
elif [ -x "$repo/tui/.venv/bin/python" ]; then py="$repo/tui/.venv/bin/python"
elif python3 -c "import pytest, textual" >/dev/null 2>&1; then py="python3"; fi

if [ -z "$py" ]; then
  echo "fleet-tui-test: $pass/$((pass + fail)) structural checks; SKIPPED the pytest suite"
  echo "  no pytest/textual available. Set it up once:"
  echo "    (cd $fleet && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt)"
  echo "  then re-run — the Python behaviour is UNCOVERED by this run."
  [ "$fail" -eq 0 ] || exit 1
  exit 0
fi

if (cd "$fleet" && PYTHONDONTWRITEBYTECODE=1 "$py" -m pytest -q); then
  pass=$((pass + 1))
else
  fail=$((fail + 1)); echo "FAIL: fleet-tui/tests pytest suite"
fi

echo "fleet-tui-test: $pass/$((pass + fail)) checks passed"
[ "$fail" -eq 0 ]
