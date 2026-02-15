#!/usr/bin/env bash
#
# clean.sh — Remove dev runtime data and browser storage for a fresh start.
#
# Usage:
#   ./scripts/clean.sh          # clean dev data (prompts for confirmation)
#   ./scripts/clean.sh --dry    # show what would be removed without deleting
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
echo -e "${BOLD}Matou App — Clean Dev Data${NC}"
echo ""

if [ "$DRY_RUN" = true ]; then
  echo -e "  ${YELLOW}DRY RUN — nothing will be deleted${NC}"
  echo ""
fi

# --- Stop dev sessions first ---
DEV_SESSIONS_SCRIPT="$ROOT/scripts/dev-sessions.sh"
if [ "$DRY_RUN" = false ] && [ -x "$DEV_SESSIONS_SCRIPT" ]; then
  # Check if any dev session ports are in use
  if ss -tlnp 2>/dev/null | grep -qE ':(4000|5100|5101|5102) '; then
    echo -e "${BOLD}Stopping dev sessions${NC}"
    "$DEV_SESSIONS_SCRIPT" stop 2>&1 | sed 's/^/  /'
    echo ""
  fi
fi

# --- Backend runtime data (dev only) ---
echo -e "${BOLD}Backend runtime data${NC}"
for dir in "$ROOT"/backend/data*/; do
  # Skip data-test/ — that belongs to clean-test.sh
  case "$dir" in
    *data-test*) continue ;;
  esac
  [ -d "$dir" ] && remove "${dir%/}"
done

# --- Backend generated config (dev only) ---
echo -e "${BOLD}Backend generated config${NC}"
remove "$ROOT/backend/config/client-dev.yml"

# --- Browser storage ---
echo -e "${BOLD}Browser storage${NC}"
CLEAR_PAGE="/tmp/matou-clear-storage.html"
if [ "$DRY_RUN" = true ]; then
  echo -e "  ${YELLOW}would open${NC} browser storage cleaner for localhost:5100-5102"
else
  # Create a temporary HTML page that clears all browser storage for dev origins
  cat > "$CLEAR_PAGE" << 'HTMLEOF'
<!DOCTYPE html>
<html><head><title>Matou — Clearing Storage</title>
<style>
  body { font-family: monospace; background: #1a1a2e; color: #e0e0e0; padding: 2rem; }
  .ok { color: #4ecca3; } .err { color: #e74c3c; } .info { color: #f0c040; }
  h2 { color: #4ecca3; margin-top: 2rem; }
  pre { background: #16213e; padding: 1rem; border-radius: 4px; overflow-x: auto; }
</style>
</head><body>
<h1>Matou — Browser Storage Cleaner</h1>
<pre id="log"></pre>
<script>
const log = document.getElementById('log');
function out(msg, cls) {
  const span = document.createElement('span');
  span.className = cls || '';
  span.textContent = msg + '\n';
  log.appendChild(span);
}

async function clearCurrentOrigin() {
  out(`Clearing storage for ${location.origin} ...`, 'info');

  // localStorage
  try { localStorage.clear(); out('  localStorage cleared', 'ok'); }
  catch(e) { out('  localStorage: ' + e.message, 'err'); }

  // sessionStorage
  try { sessionStorage.clear(); out('  sessionStorage cleared', 'ok'); }
  catch(e) { out('  sessionStorage: ' + e.message, 'err'); }

  // IndexedDB
  try {
    const dbs = await indexedDB.databases();
    for (const db of dbs) {
      indexedDB.deleteDatabase(db.name);
      out('  IndexedDB deleted: ' + db.name, 'ok');
    }
    if (dbs.length === 0) out('  IndexedDB: no databases', 'ok');
  } catch(e) { out('  IndexedDB: ' + e.message, 'err'); }

  // Cache Storage
  try {
    const keys = await caches.keys();
    for (const key of keys) {
      await caches.delete(key);
      out('  Cache deleted: ' + key, 'ok');
    }
    if (keys.length === 0) out('  Cache Storage: no caches', 'ok');
  } catch(e) { out('  Cache Storage: ' + e.message, 'err'); }

  // Service Workers
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const reg of regs) {
      await reg.unregister();
      out('  Service Worker unregistered: ' + reg.scope, 'ok');
    }
    if (regs.length === 0) out('  Service Workers: none registered', 'ok');
  } catch(e) { out('  Service Workers: ' + e.message, 'err'); }

  out('Done for ' + location.origin, 'ok');
}

clearCurrentOrigin().then(() => {
  out('\nAll storage cleared. You can close this tab.', 'info');
});
</script>
</body></html>
HTMLEOF

  # Serve the clear page on each dev session origin so browser storage is
  # cleared for the correct localhost:<port> origin.
  # Kill any leftover processes on storage-cleaner ports
  for port in 5100 5101 5102; do
    if ss -tlnp 2>/dev/null | grep -q ":${port} "; then
      pid=$(lsof -ti :"$port" 2>/dev/null || true)
      if [ -n "$pid" ]; then
        kill -9 $pid 2>/dev/null || true
        sleep 0.3
      fi
    fi
  done

  STARTED_PORTS=()
  for port in 5100 5101 5102; do
    python3 -c "
import http.server, threading, time

class Handler(http.server.SimpleHTTPRequestHandler):
    def translate_path(self, path):
        return '$CLEAR_PAGE'
    def log_message(self, *a): pass

srv = http.server.HTTPServer(('localhost', $port), Handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
time.sleep(6)
srv.shutdown()
" &
    STARTED_PORTS+=("$port")
  done

  if [ ${#STARTED_PORTS[@]} -gt 0 ]; then
    sleep 0.5
    for port in "${STARTED_PORTS[@]}"; do
      xdg-open "http://localhost:${port}/clear-storage.html" 2>/dev/null &
    done
    echo -e "  ${GREEN}opened${NC} browser storage cleaner for localhost:${STARTED_PORTS[*]// /, }"
    echo -e "  ${YELLOW}note:${NC} wait for pages to finish, then close tabs (~5s)"
    wait 2>/dev/null
  fi

  # Clean up the HTML file
  rm -f "$CLEAR_PAGE"
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
