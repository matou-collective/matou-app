#!/usr/bin/env bash
#
# clean-test.sh — Remove test runtime data, test artifacts, and coverage output.
#
# Usage:
#   ./scripts/clean-test.sh          # clean test data
#   ./scripts/clean-test.sh --dry    # show what would be removed without deleting
#

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DRY_RUN=false

for arg in "$@"; do
  case "$arg" in
    --dry)     DRY_RUN=true ;;
    --help|-h) echo "Usage: $0 [--dry]"; exit 0 ;;
    *)         echo "Unknown option: $arg"; exit 1 ;;
  esac
done

BOLD='\033[1m'
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

removed=0

remove() {
  local target="$1"
  local label="${target#"$ROOT"/}"

  if [ ! -e "$target" ]; then
    return
  fi

  if [ "$DRY_RUN" = true ]; then
    if [ -d "$target" ]; then
      local size
      size=$(du -sh "$target" 2>/dev/null | cut -f1)
      echo -e "  ${YELLOW}would remove${NC} $label/ ($size)"
    else
      echo -e "  ${YELLOW}would remove${NC} $label"
    fi
  else
    rm -rf "$target"
    echo -e "  ${RED}removed${NC} $label"
  fi
  removed=$((removed + 1))
}

echo ""
echo -e "${BOLD}Matou App — Clean Test Data${NC}"
echo ""

if [ "$DRY_RUN" = true ]; then
  echo -e "  ${YELLOW}DRY RUN — nothing will be deleted${NC}"
  echo ""
fi

# --- Kill stale test backend on port 9080 ---
if [ "$DRY_RUN" = false ]; then
  pid=$(lsof -ti :9080 2>/dev/null || true)
  if [ -n "$pid" ]; then
    echo -e "${BOLD}Killing stale test backend (port 9080)${NC}"
    kill -9 $pid 2>/dev/null || true
    echo -e "  ${RED}killed${NC} PID $pid"
    echo ""
  fi
else
  if lsof -ti :9080 >/dev/null 2>&1; then
    echo -e "${BOLD}Stale test backend (port 9080)${NC}"
    echo -e "  ${YELLOW}would kill${NC} process on port 9080"
    echo ""
  fi
fi

# --- Test backend data ---
echo -e "${BOLD}Test backend data${NC}"
remove "$ROOT/backend/data-test"

# --- Test backend generated config ---
echo -e "${BOLD}Test backend generated config${NC}"
remove "$ROOT/backend/config/client-test.yml"

# --- Test artifacts ---
echo -e "${BOLD}Test artifacts${NC}"
remove "$ROOT/frontend/playwright-report"
remove "$ROOT/frontend/test-results"
remove "$ROOT/frontend/tests/e2e/results"
remove "$ROOT/frontend/tests/e2e/test-accounts.json"

# --- Go test/coverage output ---
echo -e "${BOLD}Go test/coverage output${NC}"
for f in "$ROOT"/backend/*.out "$ROOT"/backend/coverage.html; do
  [ -f "$f" ] && remove "$f"
done

# --- Summary ---
echo ""
if [ "$removed" -eq 0 ]; then
  echo -e "${GREEN}Already clean — nothing to remove.${NC}"
elif [ "$DRY_RUN" = true ]; then
  echo -e "${YELLOW}$removed item(s) would be removed. Run without --dry to delete.${NC}"
else
  echo -e "${GREEN}Done — $removed item(s) removed.${NC}"
fi
echo ""
