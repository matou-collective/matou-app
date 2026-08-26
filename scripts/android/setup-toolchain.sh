#!/usr/bin/env bash
# Idempotent Android toolchain installer for the Matou mobile build (issue #68).
#
# Installs everything `make build-android-aar` needs under $HOME/.matou-android
# (override with MATOU_ANDROID_HOME) and writes an env.sh to source:
#
#   Temurin JDK 17, Android cmdline-tools + platform-34 + build-tools 34.0.0,
#   NDK r27c (27.2.12479018), gomobile/gobind pinned to the spike-validated
#   golang.org/x/mobile pseudo-version.
#
# Versions come from the Phase 0 spike: docs/spikes/2026-08-12-mobile-gomobile-android-spike.md
# Safe to re-run: each step is skipped when its install marker already exists.
#
# NOTE: installing Android SDK packages requires accepting Google's SDK
# licenses; this script does so non-interactively (sdkmanager --licenses).
set -euo pipefail

ROOT="${MATOU_ANDROID_HOME:-$HOME/.matou-android}"
SDK="$ROOT/sdk"
GOBIN_DIR="$ROOT/gobin"

NDK_VERSION="27.2.12479018"            # r27c
PLATFORM="android-34"
PLATFORM_CAP="android-35"   # Capacitor 7 gradle project compiles against SDK 35
BUILD_TOOLS="34.0.0"
CMDLINE_TOOLS_ZIP="commandlinetools-linux-11076708_latest.zip"
CMDLINE_TOOLS_SHA256="2d2d50857e4eb553af5a6dc3ad507a17adf43d115264b1afc116f95c92e5e258"
# Capacitor 7's android library sets Java sourceCompatibility 21, so JDK 17 is
# not enough for the APK build; 21 also satisfies gomobile/gradle.
JDK_MAJOR="21"
JDK_VER="21.0.5"
JDK_BUILD="11"
XMOBILE_VERSION="v0.0.0-20260812174124-2f419b2fb945"

log() { printf '\n==> %s\n' "$*"; }

# CI runner hosts don't all have unzip; python3 is guaranteed there instead.
extract_zip() { # extract_zip <zip> <dest-dir>
  if command -v unzip >/dev/null 2>&1; then
    unzip -q "$1" -d "$2"
  else
    python3 -m zipfile -e "$1" "$2"
    # python's zipfile drops the executable bit; restore it on bin/ entries
    find "$2" -path '*/bin/*' -type f -exec chmod +x {} +
  fi
}

mkdir -p "$ROOT" "$GOBIN_DIR"
cd "$ROOT"

# --- Temurin JDK 17 ---------------------------------------------------------
JAVA_HOME_DIR="$ROOT/jdk-${JDK_VER}+${JDK_BUILD}"
if [ -x "$JAVA_HOME_DIR/bin/java" ]; then
  log "JDK already installed: $JAVA_HOME_DIR"
else
  log "Downloading Temurin JDK ${JDK_VER}+${JDK_BUILD}"
  jdk_tar="OpenJDK${JDK_MAJOR}U-jdk_x64_linux_hotspot_${JDK_VER}_${JDK_BUILD}.tar.gz"
  jdk_url="https://github.com/adoptium/temurin${JDK_MAJOR}-binaries/releases/download/jdk-${JDK_VER}%2B${JDK_BUILD}/${jdk_tar}"
  curl -fL --retry 3 -o "$jdk_tar" "$jdk_url"
  curl -fL --retry 3 -o "$jdk_tar.sha256.txt" "$jdk_url.sha256.txt"
  (cd "$ROOT" && sha256sum -c "$jdk_tar.sha256.txt")
  tar xzf "$jdk_tar"
  rm -f "$jdk_tar" "$jdk_tar.sha256.txt"
  [ -x "$JAVA_HOME_DIR/bin/java" ] || { echo "ERROR: JDK extract did not produce $JAVA_HOME_DIR" >&2; exit 1; }
fi
export JAVA_HOME="$JAVA_HOME_DIR"

# --- Android cmdline-tools --------------------------------------------------
SDKMANAGER="$SDK/cmdline-tools/latest/bin/sdkmanager"
if [ -x "$SDKMANAGER" ]; then
  log "cmdline-tools already installed"
else
  log "Downloading Android cmdline-tools"
  curl -fL --retry 3 -o "$CMDLINE_TOOLS_ZIP" "https://dl.google.com/android/repository/$CMDLINE_TOOLS_ZIP"
  echo "$CMDLINE_TOOLS_SHA256  $CMDLINE_TOOLS_ZIP" | sha256sum -c -
  mkdir -p "$SDK/cmdline-tools"
  extract_zip "$CMDLINE_TOOLS_ZIP" "$SDK/cmdline-tools"
  mv "$SDK/cmdline-tools/cmdline-tools" "$SDK/cmdline-tools/latest"
  rm -f "$CMDLINE_TOOLS_ZIP"
fi

# --- SDK packages (platform, build-tools, NDK) ------------------------------
NDK_HOME="$SDK/ndk/$NDK_VERSION"
if [ -d "$NDK_HOME" ] && [ -d "$SDK/platforms/$PLATFORM" ] && [ -d "$SDK/platforms/$PLATFORM_CAP" ] && [ -d "$SDK/build-tools/$BUILD_TOOLS" ]; then
  log "SDK packages already installed (platform, build-tools, NDK r27c)"
else
  log "Accepting SDK licenses + installing platform/build-tools/NDK (large download, ~1 GB)"
  # `yes` dies with SIGPIPE when sdkmanager stops reading; don't let
  # pipefail+errexit abort the script on that (the package install below
  # still fails loudly if licenses weren't actually accepted).
  yes | "$SDKMANAGER" --sdk_root="$SDK" --licenses > /dev/null || true
  "$SDKMANAGER" --sdk_root="$SDK" \
    "platforms;$PLATFORM" "platforms;$PLATFORM_CAP" "build-tools;$BUILD_TOOLS" "ndk;$NDK_VERSION"
fi

# --- gomobile / gobind ------------------------------------------------------
if [ -x "$GOBIN_DIR/gomobile" ] && [ -x "$GOBIN_DIR/gobind" ] && \
   [ "$(cat "$ROOT/.xmobile-version" 2>/dev/null)" = "$XMOBILE_VERSION" ]; then
  log "gomobile/gobind already installed at $XMOBILE_VERSION"
else
  log "Installing gomobile + gobind @ $XMOBILE_VERSION"
  GOBIN="$GOBIN_DIR" go install "golang.org/x/mobile/cmd/gomobile@$XMOBILE_VERSION"
  GOBIN="$GOBIN_DIR" go install "golang.org/x/mobile/cmd/gobind@$XMOBILE_VERSION"
  echo "$XMOBILE_VERSION" > "$ROOT/.xmobile-version"
  log "Running gomobile init"
  PATH="$GOBIN_DIR:$PATH" ANDROID_HOME="$SDK" ANDROID_NDK_HOME="$NDK_HOME" \
    "$GOBIN_DIR/gomobile" init
fi

# --- env.sh -----------------------------------------------------------------
cat > "$ROOT/env.sh" <<EOF
# Generated by scripts/android/setup-toolchain.sh — source before Android builds.
export MATOU_ANDROID_HOME="$ROOT"
export JAVA_HOME="$JAVA_HOME_DIR"
export ANDROID_HOME="$SDK"
export ANDROID_SDK_ROOT="$SDK"
export ANDROID_NDK_HOME="$NDK_HOME"
export PATH="$GOBIN_DIR:\$JAVA_HOME/bin:\$ANDROID_HOME/cmdline-tools/latest/bin:\$ANDROID_HOME/platform-tools:\$PATH"
# CI runner daemons use a non-login PATH without go — same guard as run-smoke-drive.sh
command -v go >/dev/null 2>&1 || export PATH="\$HOME/go-sdk/go/bin:\$HOME/.nix-profile/bin:\$PATH"
EOF

log "Done. Toolchain in $ROOT — source $ROOT/env.sh to use it."
