#!/usr/bin/env bash
#
# clean.sh — Remove all dev/test data, build artifacts, and caches for a fresh start.
#
# Usage:
#   ./scripts/clean.sh          # clean everything (prompts for confirmation)
#   ./scripts/clean.sh --all    # clean everything including node_modules
#   ./scripts/clean.sh --dry    # show what would be removed without deleting
#

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DRY_RUN=false
CLEAN_NODE_MODULES=false

for arg in "$@"; do
  case "$arg" in
    --dry)     DRY_RUN=true ;;
    --all)     CLEAN_NODE_MODULES=true ;;
    --help|-h) echo "Usage: $0 [--all] [--dry]"; exit 0 ;;
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
echo -e "${BOLD}Matou App — Clean Start${NC}"
echo ""

if [ "$DRY_RUN" = true ]; then
  echo -e "  ${YELLOW}DRY RUN — nothing will be deleted${NC}"
  echo ""
fi

# --- Backend build artifacts ---
echo -e "${BOLD}Backend build artifacts${NC}"
remove "$ROOT/backend/bin"
remove "$ROOT/backend/server"

# --- Backend runtime data ---
echo -e "${BOLD}Backend runtime data${NC}"
for dir in "$ROOT"/backend/data*/; do
  [ -d "$dir" ] && remove "${dir%/}"
done

# --- Backend generated config ---
echo -e "${BOLD}Backend generated config${NC}"
for f in "$ROOT"/backend/config/client-*.yml; do
  [ -f "$f" ] && remove "$f"
done
remove "$ROOT/backend/config/bootstrap.yaml"
remove "$ROOT/backend/config/.env"
remove "$ROOT/backend/config/.org-passcode"
remove "$ROOT/backend/config/.keria-config.json"
remove "$ROOT/backend/config/secrets.yaml"
remove "$ROOT/backend/.env"

# --- Frontend build output ---
echo -e "${BOLD}Frontend build output${NC}"
remove "$ROOT/frontend/dist"
remove "$ROOT/frontend/.quasar"

# --- Frontend generated env ---
echo -e "${BOLD}Frontend generated env files${NC}"
remove "$ROOT/frontend/.env.production"
remove "$ROOT/frontend/.env.local"
remove "$ROOT/frontend/.env.development.local"
remove "$ROOT/frontend/.env.test.local"
remove "$ROOT/frontend/.env.production.local"

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

# --- Node modules (only with --all) ---
if [ "$CLEAN_NODE_MODULES" = true ]; then
  echo -e "${BOLD}Node modules${NC}"
  remove "$ROOT/frontend/node_modules"
fi

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
