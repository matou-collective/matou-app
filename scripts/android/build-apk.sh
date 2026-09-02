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

# --- Firebase google-services.json (push notifications, #177) ----------------
# Materialised from a base64 secret ($GOOGLE_SERVICES_JSON, as CI injects it —
# `base64 -w0` of the file) or an explicit local file ($GOOGLE_SERVICES_JSON_FILE).
# Absent → the google-services Gradle plugin is skipped (see android/app/build.gradle)
# and the build still succeeds without push, so local dev without Firebase is
# unaffected.
GS_DEST="$CAP/android/app/google-services.json"
if [ -n "${GOOGLE_SERVICES_JSON:-}" ]; then
  echo "==> Writing google-services.json from GOOGLE_SERVICES_JSON secret"
  printf '%s' "$GOOGLE_SERVICES_JSON" | base64 -d > "$GS_DEST"
  chmod 600 "$GS_DEST"
elif [ -n "${GOOGLE_SERVICES_JSON_FILE:-}" ]; then
  echo "==> Copying google-services.json from $GOOGLE_SERVICES_JSON_FILE"
  cp "$GOOGLE_SERVICES_JSON_FILE" "$GS_DEST"
  chmod 600 "$GS_DEST"
else
  echo "==> No google-services.json (GOOGLE_SERVICES_JSON / GOOGLE_SERVICES_JSON_FILE unset) — building WITHOUT push (Firebase Gradle plugin skipped)"
fi

# --- embedded backend .aar --------------------------------------------------
# The .aar embeds the Go backend, so a stale one silently ships an old client
# (issue #130: the phone 404'd on /api/v1/client-config because the AAR predated
# a backend change). Rebuild when it is missing OR when any backend source is
# newer than it, then always report which AAR is being packaged.
AAR="$CAP/android/app/libs/matou.aar"
aar_state="reused"
if [ ! -f "$AAR" ]; then
  echo "==> matou.aar missing — building it"
  make -C "$ROOT_DIR/backend" build-android-aar
  aar_state="rebuilt (was missing)"
elif [ -n "$(find "$ROOT_DIR/backend" \
    \( -name '*.go' -o -name 'go.mod' -o -name 'go.sum' \) \
    -type f -newer "$AAR" -print -quit)" ]; then
  echo "==> matou.aar is older than backend sources — rebuilding it"
  make -C "$ROOT_DIR/backend" build-android-aar
  aar_state="rebuilt (backend changed)"
fi
echo "==> Packaging AAR: $AAR ($aar_state, mtime $(date -r "$AAR" '+%Y-%m-%d %H:%M:%S'))"

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
