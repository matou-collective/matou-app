#!/usr/bin/env bash
# The factory TUI's guard from the bash side (#29).
#
# The TUI is Python, and its own suite (tui/tests/, pytest) is the real test
# of its behaviour — this script is what makes it part of THIS repo's offline
# suite, plus the two structural conditions that keep a vendored monitor
# vendorable at all:
#
#   1. no product literal anywhere under tui/ — the TUI is copied
#      byte-identical into every consumer, so a repo name, host or product
#      path in it would be wrong in every repo but the one it came from
#      (CLAUDE.md's blast-radius rule; the reason #29 lifted it out of a
#      consumer's per-repo layer in the first place), and
#   2. the vendored worker-class table declares no hosts — which machine runs
#      which class is a per-deployment fact a consumer states in its own
#      worker-classes.local.json overlay.
#
# The pytest half runs when a venv or a system pytest is available and says so
# LOUDLY when it is not — a silent skip would read as coverage that isn't
# there. Scans the harness's own directory ($here/..), so a consumer running
# its vendored tests gets the same guard (#23).
set -u
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
harness="$(cd "$here/.." && pwd)"
tui="$harness/tui"

pass=0 fail=0
check() { if eval "$2"; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL: $1"; fi; }

check "tui/ is present in the harness dir" '[ -d "$tui" ]'
[ -d "$tui" ] || { echo "tui-test: 0/1 (no tui/ to scan)"; exit 1; }

# ── 1. no product literal ────────────────────────────────────────────────
# The owner/repo/host names this factory's own consumers use. A vendored file
# naming one is the regression; test fixtures are scrubbed too, so the
# expected count is zero, not "only in tests".
sources="$(find "$tui" -type f \
  ! -path '*/.venv/*' ! -path '*/__pycache__/*' ! -name '*.pyc' | sort)"
check "tui/ has files to scan" '[ -n "$sources" ]'

literals="$(grep -rilE 'idss|matou|ourcloud' $sources 2>/dev/null || true)"
check "no product literal under tui/" \
  '[ -z "$literals" ] || { echo "  named a product: $literals"; false; }'

# The API base, checkout path and marker paths must come from the identity
# layer, never from a default in a module — the specific defect #29 fixed.
hardcoded_api="$(grep -rn 'https://git\.' $sources 2>/dev/null || true)"
check "no forge host is hardcoded under tui/" \
  '[ -z "$hardcoded_api" ] || { printf "%s\n" "$hardcoded_api"; false; }'

# Every data/ module takes its paths and URLs from the caller. identity.py is
# the ONE place allowed to name the harness files it sources.
readers="$(ls -1 "$tui"/data/*.py 2>/dev/null | grep -v '/identity\.py$' || true)"
check "there are data/ readers to scan" '[ -n "$readers" ]'
reader_defaults="$(grep -n '^DEFAULT_[A-Z_]* *= *"[/h]' $readers 2>/dev/null || true)"
check "no data/ reader defaults a host path or URL" \
  '[ -z "$reader_defaults" ] || { printf "%s\n" "$reader_defaults"; false; }'

# ── 2. the vendored worker-class table ───────────────────────────────────
classes="$tui/worker-classes.json"
check "the worker-class table is vendored beside the reader" '[ -f "$classes" ]'
check "the worker-class table parses and declares no hosts" '
  python3 - "$classes" <<'"'"'PY'"'"'
import json, sys
data = json.load(open(sys.argv[1]))
classes = data["classes"]
assert classes, "no classes"
bad = [c["id"] for c in classes if c.get("hosts")]
assert not bad, f"vendored table names hosts for: {bad}"
PY'

# ── 3. the Python suite ──────────────────────────────────────────────────
py=""
if [ -x "$tui/.venv/bin/python" ]; then py="$tui/.venv/bin/python"
elif python3 -c "import pytest, textual" >/dev/null 2>&1; then py="python3"; fi

if [ -z "$py" ]; then
  echo "tui-test: $pass/$((pass + fail)) structural checks; SKIPPED the pytest suite"
  echo "  no pytest/textual available. Set it up once:"
  echo "    (cd $tui && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt)"
  echo "  then re-run — the Python behaviour is UNCOVERED by this run."
  [ "$fail" -eq 0 ] || exit 1
  exit 0
fi

# Offline by construction (every fetch/poster is injected), and hermetic: the
# app tests inject a whole synthetic identity layer, so the host's own env
# cannot reach an assertion.
if (cd "$tui" && "$py" -m pytest -q); then
  pass=$((pass + 1))
else
  fail=$((fail + 1)); echo "FAIL: tui/tests pytest suite"
fi

echo "tui-test: $pass/$((pass + fail)) checks passed"
[ "$fail" -eq 0 ]
