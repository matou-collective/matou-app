#!/usr/bin/env bash
# Build the Matou iOS app — the iOS counterpart of scripts/android/build-aab.sh.
#
#   scripts/ios/build-ipa.sh                     signed .xcarchive + App Store IPA (needs signing env, below)
#   scripts/ios/build-ipa.sh --simulator         unsigned Debug build for the iOS Simulator (no Apple account needed)
#   scripts/ios/build-ipa.sh --unsigned-archive  unsigned Release device archive (proves the device build; not installable)
#
# Every mode: bakes the config-server URL into the MatouBackend plugin config,
# makes sure the gomobile Matou.xcframework exists, builds the web assets with
# Quasar, `cap sync ios` (runs `pod install`), then xcodebuild. Outputs under
# frontend/dist/capacitor/ios/:
#   simulator/Matou.app          (--simulator)      xcrun simctl install booted <that>
#   archive/Matou.xcarchive      (default, --unsigned-archive)
#   ipa/matou-<version>-ios.ipa  (default)
#
# Env:
#   VITE_PROD_CONFIG_URL          config server (falls back to frontend/.env.production)
#   MATOU_VERSION_NAME            CFBundleShortVersionString (default frontend/package.json version)
#   MATOU_VERSION_CODE            CFBundleVersion, integer, must increase per TestFlight upload (default 1)
#   MATOU_IOS_TEAM_ID             Apple Developer team id                 (signed mode)
#   MATOU_IOS_PROFILE_NAME        provisioning profile name for nz.matou.app (signed mode)
#   MATOU_IOS_SIGNING_IDENTITY    default "Apple Distribution"            (signed mode)
#   MATOU_IOS_EXPORT_METHOD       default app-store-connect               (signed mode)
#   MATOU_XCODEBUILD_FLAGS        default "-quiet"
#
# Guards (same as build-aab.sh): refuses a config-server URL that points at
# localhost / private networks, warns on plain http.
#
# macOS + Xcode only. Needs gomobile/gobind on PATH for the xcframework step
# (see backend/scripts/ios/build-xcframework.sh) and CocoaPods for cap sync.
set -euo pipefail

MODE=ipa
for arg in "$@"; do
  case "$arg" in
    --simulator) MODE=simulator ;;
    --unsigned-archive) MODE=unsigned-archive ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "ERROR: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FRONTEND="$ROOT_DIR/frontend"
CAP="$FRONTEND/src-capacitor"
IOS="$CAP/ios/App"
OUT="$FRONTEND/dist/capacitor/ios"
XCFW="$IOS/Frameworks/Matou.xcframework"
XCODEBUILD_FLAGS="${MATOU_XCODEBUILD_FLAGS--quiet}"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "ERROR: iOS builds need macOS + Xcode (got $(uname -s))" >&2
  exit 1
fi
command -v xcodebuild >/dev/null || { echo "ERROR: xcodebuild not found — install Xcode" >&2; exit 1; }
command -v pod >/dev/null || { echo "ERROR: CocoaPods not found — sudo gem install cocoapods (or brew install cocoapods)" >&2; exit 1; }

# --- config server URL ------------------------------------------------------
if [ -z "${VITE_PROD_CONFIG_URL:-}" ] && [ -f "$FRONTEND/.env.production" ]; then
  VITE_PROD_CONFIG_URL="$(sed -n 's/^VITE_PROD_CONFIG_URL=//p' "$FRONTEND/.env.production" | tail -1 | tr -d '"' )"
fi
if [ -z "${VITE_PROD_CONFIG_URL:-}" ]; then
  echo "ERROR: VITE_PROD_CONFIG_URL not set and not found in frontend/.env.production" >&2
  exit 1
fi
case "$VITE_PROD_CONFIG_URL" in
  *localhost*|*127.0.0.1*|*://192.168.*|*://10.*|*://172.1[6-9].*|*://172.2[0-9].*|*://172.3[01].*)
    echo "ERROR: VITE_PROD_CONFIG_URL=$VITE_PROD_CONFIG_URL looks like dev/test infra." >&2
    echo "       An App Store / TestFlight build must point at the production config server." >&2
    exit 1 ;;
  http://*)
    # Go's net/http (not the WebView) fetches it, so ATS doesn't block it — but
    # flag it so nobody forgets when the config server moves to https.
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

# --- versions ---------------------------------------------------------------
VERSION_NAME="${MATOU_VERSION_NAME:-$(node -p "require('$FRONTEND/package.json').version")}"
VERSION_CODE="${MATOU_VERSION_CODE:-1}"
case "$VERSION_CODE" in ''|*[!0-9]*) echo "ERROR: MATOU_VERSION_CODE must be an integer (got '$VERSION_CODE')" >&2; exit 1 ;; esac
echo "==> CFBundleShortVersionString=$VERSION_NAME CFBundleVersion=$VERSION_CODE mode=$MODE"

# --- signing sanity (signed mode only) --------------------------------------
if [ "$MODE" = ipa ]; then
  : "${MATOU_IOS_TEAM_ID:?MATOU_IOS_TEAM_ID is required for a signed build (or use --simulator / --unsigned-archive)}"
  : "${MATOU_IOS_PROFILE_NAME:?MATOU_IOS_PROFILE_NAME is required for a signed build}"
  SIGNING_IDENTITY="${MATOU_IOS_SIGNING_IDENTITY:-Apple Distribution}"
  EXPORT_METHOD="${MATOU_IOS_EXPORT_METHOD:-app-store-connect}"
fi

# --- embedded backend xcframework -------------------------------------------
# A stale framework silently ships an old backend (cf. issue #130 on Android):
# rebuild when missing or older than any backend source.
if [ ! -d "$XCFW" ]; then
  echo "==> Matou.xcframework missing — building it"
  make -C "$ROOT_DIR/backend" build-ios-xcframework
elif [ -n "$(find "$ROOT_DIR/backend" \( -name '*.go' -o -name 'go.mod' -o -name 'go.sum' \) -type f -newer "$XCFW/Info.plist" -print -quit)" ]; then
  echo "==> Matou.xcframework is older than backend sources — rebuilding it"
  make -C "$ROOT_DIR/backend" build-ios-xcframework
fi
echo "==> Packaging $XCFW (mtime $(date -r "$XCFW/Info.plist" '+%Y-%m-%d %H:%M:%S'))"

# --- web assets + cap sync (pod install) ------------------------------------
[ -d "$CAP/node_modules" ] || (cd "$CAP" && npm ci)
cd "$FRONTEND"
npx quasar build -m capacitor -T ios --skip-pkg
cd "$CAP"
npx cap sync ios

# --- xcodebuild -------------------------------------------------------------
cd "$IOS"
mkdir -p "$OUT"
DERIVED="$OUT/DerivedData"
COMMON=(-workspace App.xcworkspace -scheme App -derivedDataPath "$DERIVED"
        "MARKETING_VERSION=$VERSION_NAME" "CURRENT_PROJECT_VERSION=$VERSION_CODE")
# shellcheck disable=SC2086
case "$MODE" in
  simulator)
    xcodebuild $XCODEBUILD_FLAGS "${COMMON[@]}" -configuration Debug \
      -destination 'generic/platform=iOS Simulator' \
      CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO build
    APP="$DERIVED/Build/Products/Debug-iphonesimulator/App.app"
    [ -d "$APP" ] || { echo "ERROR: expected app not found at $APP" >&2; exit 1; }
    rm -rf "$OUT/simulator"; mkdir -p "$OUT/simulator"
    cp -R "$APP" "$OUT/simulator/Matou.app"
    echo "==> Simulator app: $OUT/simulator/Matou.app  (xcrun simctl install booted <path>)"
    ;;
  unsigned-archive)
    rm -rf "$OUT/archive"; mkdir -p "$OUT/archive"
    xcodebuild $XCODEBUILD_FLAGS "${COMMON[@]}" -configuration Release \
      -destination 'generic/platform=iOS' -archivePath "$OUT/archive/Matou.xcarchive" \
      CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" archive
    echo "==> Unsigned archive: $OUT/archive/Matou.xcarchive"
    ;;
  ipa)
    rm -rf "$OUT/archive" "$OUT/ipa"; mkdir -p "$OUT/archive" "$OUT/ipa"
    xcodebuild $XCODEBUILD_FLAGS "${COMMON[@]}" -configuration Release \
      -destination 'generic/platform=iOS' -archivePath "$OUT/archive/Matou.xcarchive" \
      CODE_SIGN_STYLE=Manual "DEVELOPMENT_TEAM=$MATOU_IOS_TEAM_ID" \
      "CODE_SIGN_IDENTITY=$SIGNING_IDENTITY" "PROVISIONING_PROFILE_SPECIFIER=$MATOU_IOS_PROFILE_NAME" \
      archive
    EXPORT_PLIST="$OUT/archive/ExportOptions.plist"
    cat > "$EXPORT_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>$EXPORT_METHOD</string>
  <key>teamID</key><string>$MATOU_IOS_TEAM_ID</string>
  <key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>$SIGNING_IDENTITY</string>
  <key>provisioningProfiles</key><dict><key>nz.matou.app</key><string>$MATOU_IOS_PROFILE_NAME</string></dict>
  <key>destination</key><string>export</string>
  <key>uploadSymbols</key><true/>
</dict></plist>
PLIST
    xcodebuild $XCODEBUILD_FLAGS -exportArchive -archivePath "$OUT/archive/Matou.xcarchive" \
      -exportOptionsPlist "$EXPORT_PLIST" -exportPath "$OUT/ipa"
    IPA="$(ls "$OUT"/ipa/*.ipa | head -1)"
    [ -f "$IPA" ] || { echo "ERROR: export produced no .ipa in $OUT/ipa" >&2; exit 1; }
    mv -f "$IPA" "$OUT/ipa/matou-${VERSION_NAME}-ios.ipa"
    echo "==> IPA: $OUT/ipa/matou-${VERSION_NAME}-ios.ipa"
    codesign -dv --verbose=2 "$OUT/archive/Matou.xcarchive/Products/Applications/App.app" 2>&1 | grep -E "Authority|TeamIdentifier|Identifier=" | head -5 || true
    ;;
esac
