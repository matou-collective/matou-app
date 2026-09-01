#!/usr/bin/env bash
#
# build-xcframework.sh — gomobile bind the embedded backend (cmd/mobile) into
# an iOS Matou.xcframework. iOS counterpart of scripts/android/build-aar.sh.
#
# Requires macOS with Xcode (gomobile shells out to xcrun/clang/lipo), plus
# gomobile + gobind on PATH at the pseudo-version pinned in
# scripts/android/setup-toolchain.sh (XMOBILE_VERSION) — the same x/mobile
# revision go.mod's `tool golang.org/x/mobile/cmd/gobind` resolves to.
#
# Unlike the Android build there is NO modernc.org/libc replace here: the
# seccomp patch (issue #98) is Android-only, and go.mod is used as committed.
#
# Env:
#   IOS_XCFRAMEWORK  output path (default ../frontend/src-capacitor/ios/App/Frameworks/
#                    Matou.xcframework — gitignored, where the iOS shell's
#                    MatouBackend pod links it from)
#   IOS_TARGETS      gomobile -target value (default ios,iossimulator — device
#                    arm64 plus arm64+amd64 simulator slices; the simulator slice
#                    is what any Mac-owning contributor runs locally)
#   IOS_MIN_VERSION  -iosversion (default 15.0, the Capacitor 7 shell's target)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$BACKEND_DIR"

IOS_XCFRAMEWORK="${IOS_XCFRAMEWORK:-../frontend/src-capacitor/ios/App/Frameworks/Matou.xcframework}"
IOS_TARGETS="${IOS_TARGETS:-ios,iossimulator}"
IOS_MIN_VERSION="${IOS_MIN_VERSION:-15.0}"

if [ "$(uname -s)" != "Darwin" ]; then
    echo "build-xcframework: iOS binds need macOS + Xcode (got $(uname -s))" >&2
    exit 1
fi
command -v gomobile >/dev/null || {
    echo "build-xcframework: gomobile not on PATH — go install golang.org/x/mobile/cmd/{gomobile,gobind}@<XMOBILE_VERSION from scripts/android/setup-toolchain.sh> && gomobile init" >&2
    exit 1
}
command -v xcrun >/dev/null || {
    echo "build-xcframework: xcrun not found — install Xcode and run xcode-select" >&2
    exit 1
}

# gomobile refuses to overwrite an existing .xcframework bundle.
rm -rf "$IOS_XCFRAMEWORK"
mkdir -p "$(dirname "$IOS_XCFRAMEWORK")"

echo "build-xcframework: gomobile bind -target=$IOS_TARGETS -iosversion $IOS_MIN_VERSION ./cmd/mobile" >&2
gomobile bind \
    -target="$IOS_TARGETS" -iosversion "$IOS_MIN_VERSION" \
    -o "$IOS_XCFRAMEWORK" ./cmd/mobile

echo "build-xcframework: wrote $IOS_XCFRAMEWORK" >&2
