#!/usr/bin/env bash
# Build the Matou Android debug APK (issue #69).
#
#   scripts/android/build-apk.sh
#
# Bakes the config-server URL (from $VITE_PROD_CONFIG_URL, falling back to
# frontend/.env.production) into the MatouBackend plugin config, makes sure the
# gomobile .aar exists, then runs the Quasar Capacitor build. Output:
#   frontend/dist/capacitor/android/apk/debug/app-debug.apk
#
# Needs the toolchain from scripts/android/setup-toolchain.sh.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FRONTEND="$ROOT_DIR/frontend"
CAP="$FRONTEND/src-capacitor"

ENV_SH="${MATOU_ANDROID_HOME:-$HOME/.matou-android}/env.sh"
if [ ! -f "$ENV_SH" ]; then
  echo "ERROR: $ENV_SH missing — run scripts/android/setup-toolchain.sh first" >&2
  exit 1
fi
# shellcheck disable=SC1090
. "$ENV_SH"

# --- config server URL ------------------------------------------------------
if [ -z "${VITE_PROD_CONFIG_URL:-}" ] && [ -f "$FRONTEND/.env.production" ]; then
  VITE_PROD_CONFIG_URL="$(sed -n 's/^VITE_PROD_CONFIG_URL=//p' "$FRONTEND/.env.production" | tail -1 | tr -d '"' )"
fi
if [ -z "${VITE_PROD_CONFIG_URL:-}" ]; then
  echo "ERROR: VITE_PROD_CONFIG_URL not set and not found in frontend/.env.production" >&2
  exit 1
fi
echo "==> Baking configServerUrl=$VITE_PROD_CONFIG_URL into capacitor.config.json"
python3 - "$CAP/capacitor.config.json" "$VITE_PROD_CONFIG_URL" <<'PY'
import json, sys
path, url = sys.argv[1], sys.argv[2]
cfg = json.load(open(path))
cfg.setdefault("plugins", {}).setdefault("MatouBackend", {})["configServerUrl"] = url
with open(path, "w") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
PY

# --- embedded backend .aar --------------------------------------------------
if [ ! -f "$CAP/android/app/libs/matou.aar" ]; then
  echo "==> matou.aar missing — building it"
  make -C "$ROOT_DIR/backend" build-android-aar
fi

# --- Quasar Capacitor build -------------------------------------------------
cd "$FRONTEND"
npx quasar build -m capacitor -T android --debug

APK="$FRONTEND/dist/capacitor/android/apk/debug/app-debug.apk"
if [ -f "$APK" ]; then
  echo "==> APK: $APK"
else
  echo "ERROR: expected APK not found at $APK" >&2
  exit 1
fi
