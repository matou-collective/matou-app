#!/usr/bin/env bash
# Build the Matou Android *release* App Bundle for the Play Store (issue #176).
#
#   scripts/android/build-aab.sh [--allow-unsigned]
#
# Same preparation as build-apk.sh (bakes the config-server URL into the
# MatouBackend plugin config, makes sure the gomobile .aar exists), then runs
# the Quasar Capacitor build in release mode and `gradlew bundleRelease`.
# Output:
#   frontend/dist/capacitor/android/bundle/release/app-release.aab
#
# Signing / version inputs (see frontend/src-capacitor/android/app/build.gradle):
#   MATOU_KEYSTORE_FILE, MATOU_KEYSTORE_PASSWORD, MATOU_KEY_ALIAS, MATOU_KEY_PASSWORD
#     — or frontend/src-capacitor/android/keystore.properties (git-ignored)
#   MATOU_VERSION_CODE (integer, must increase every Play upload)
#   MATOU_VERSION_NAME (defaults to frontend/package.json version)
#
# Guards:
#   * refuses a config-server URL that points at localhost / private networks
#     — a Play build must never talk to dev/test infra (warns on plain http);
#   * refuses to produce an UNSIGNED bundle unless --allow-unsigned is given
#     (Play rejects unsigned bundles; useful only for smoke-testing the build).
#
# Needs the toolchain from scripts/android/setup-toolchain.sh.
set -euo pipefail

ALLOW_UNSIGNED=0
for arg in "$@"; do
  case "$arg" in
    --allow-unsigned) ALLOW_UNSIGNED=1 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "ERROR: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FRONTEND="$ROOT_DIR/frontend"
CAP="$FRONTEND/src-capacitor"
ANDROID="$CAP/android"

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
case "$VITE_PROD_CONFIG_URL" in
  *localhost*|*127.0.0.1*|*10.0.2.2*|*://192.168.*|*://10.*|*://172.1[6-9].*|*://172.2[0-9].*|*://172.3[01].*)
    echo "ERROR: VITE_PROD_CONFIG_URL=$VITE_PROD_CONFIG_URL looks like dev/test infra." >&2
    echo "       A Play Store build must point at the production config server." >&2
    exit 1 ;;
  http://*)
    # The prod config server is currently served over plain http (network_security_config
    # allows it); flag it so nobody forgets when it moves to https.
    echo "WARN: VITE_PROD_CONFIG_URL=$VITE_PROD_CONFIG_URL is plain http" >&2 ;;
esac
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

# --- signing sanity ---------------------------------------------------------
have_signing=0
if [ -n "${MATOU_KEYSTORE_FILE:-}" ] && [ -n "${MATOU_KEYSTORE_PASSWORD:-}" ] \
   && [ -n "${MATOU_KEY_ALIAS:-}" ] && [ -n "${MATOU_KEY_PASSWORD:-}" ]; then
  have_signing=1
  if [ ! -f "$MATOU_KEYSTORE_FILE" ]; then
    echo "ERROR: MATOU_KEYSTORE_FILE=$MATOU_KEYSTORE_FILE does not exist" >&2
    exit 1
  fi
elif [ -f "$ANDROID/keystore.properties" ]; then
  have_signing=1
fi
if [ "$have_signing" = 0 ]; then
  if [ "$ALLOW_UNSIGNED" = 1 ]; then
    echo "WARN: no signing config — building an UNSIGNED bundle (--allow-unsigned)" >&2
  else
    echo "ERROR: no release signing config." >&2
    echo "       Set MATOU_KEYSTORE_FILE/MATOU_KEYSTORE_PASSWORD/MATOU_KEY_ALIAS/MATOU_KEY_PASSWORD" >&2
    echo "       or create $ANDROID/keystore.properties (see keystore.properties.example)." >&2
    echo "       Pass --allow-unsigned to build anyway for a smoke test." >&2
    exit 1
  fi
fi
echo "==> versionCode=${MATOU_VERSION_CODE:-1 (default)} versionName=${MATOU_VERSION_NAME:-<package.json>}"

# --- Firebase google-services.json (push notifications, #177) ----------------
# Materialised from a base64 secret ($GOOGLE_SERVICES_JSON, as CI injects it —
# `base64 -w0` of the file) or an explicit local file ($GOOGLE_SERVICES_JSON_FILE).
# Absent → the google-services Gradle plugin is skipped (see android/app/build.gradle)
# and the build still succeeds without push, so a smoke build without Firebase
# is unaffected.
GS_DEST="$ANDROID/app/google-services.json"
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
if [ ! -f "$ANDROID/app/libs/matou.aar" ]; then
  echo "==> matou.aar missing — building it"
  make -C "$ROOT_DIR/backend" build-android-aar
fi

# --- Quasar Capacitor build (release web assets) + cap sync -----------------
# Quasar's own capacitor release build only runs assembleRelease (APK), so we
# build just the UI (--skip-pkg fills src-capacitor/www), sync it into the
# Android project ourselves, then run bundleRelease.
cd "$FRONTEND"
npx quasar build -m capacitor -T android --skip-pkg
cd "$CAP"
npx cap sync android

# --- Gradle bundleRelease ---------------------------------------------------
cd "$ANDROID"
./gradlew --no-daemon bundleRelease

AAB="$ANDROID/app/build/outputs/bundle/release/app-release.aab"
OUT_DIR="$FRONTEND/dist/capacitor/android/bundle/release"
if [ ! -f "$AAB" ]; then
  echo "ERROR: expected bundle not found at $AAB" >&2
  exit 1
fi
mkdir -p "$OUT_DIR"
cp "$AAB" "$OUT_DIR/app-release.aab"
echo "==> AAB: $OUT_DIR/app-release.aab"

# Report what was actually baked in, so CI logs show the version + signer.
if command -v jarsigner >/dev/null 2>&1 && [ "$have_signing" = 1 ]; then
  echo "==> signer:"
  jarsigner -verify -verbose:summary -certs "$OUT_DIR/app-release.aab" 2>/dev/null \
    | grep -E "CN=|jar verified|signature was verified" | sort -u | head -3 || true
fi
