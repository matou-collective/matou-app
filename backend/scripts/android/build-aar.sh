#!/usr/bin/env bash
#
# build-aar.sh — gomobile bind the embedded backend into an Android .aar,
# with the issue #98 seccomp-safe modernc.org/libc patch applied for the
# duration of the build only.
#
# The patch (scripts/android/patch-libc.sh) rewrites libc's legacy path
# syscalls to their `*at` equivalents so the backend doesn't SIGSYS under
# Android's seccomp policy on android/amd64. We wire it in via a `replace`
# directive that is added to go.mod ONLY while gomobile runs and stripped
# again on exit (success or failure) — so it never lands in the committed
# go.mod and desktop/server builds (`go build ./...`) are unaffected.
#
# Env:
#   ANDROID_ENV  path to the toolchain env.sh (from setup-toolchain.sh)
#   ANDROID_AAR  output .aar path
#   ANDROID_TARGETS  gomobile -target value (default android/arm64,android/amd64)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$BACKEND_DIR"

: "${ANDROID_ENV:?ANDROID_ENV must be set (path to toolchain env.sh)}"
: "${ANDROID_AAR:?ANDROID_AAR must be set (output .aar path)}"
ANDROID_TARGETS="${ANDROID_TARGETS:-android/arm64,android/amd64}"

test -f "$ANDROID_ENV" || {
    echo "Missing $ANDROID_ENV — run scripts/android/setup-toolchain.sh first" >&2
    exit 1
}

# 1. Generate the patched libc copy (build/android-libc-patched, gitignored).
# env.sh puts gomobile on PATH and, on CI runner hosts whose daemon PATH lacks
# go, falls back to ~/go-sdk — patch-libc.sh needs `go` too, so source it first.
. "$ANDROID_ENV"
PATCHED="$(scripts/android/patch-libc.sh)"

# 2. Apply the replace to go.mod for the build only; always restore it.
cp go.mod go.mod.aarbak
restore() { mv -f go.mod.aarbak go.mod 2>/dev/null || true; }
trap restore EXIT INT TERM
# Relative path so the module stays relocatable; local replacements need no go.sum entry.
go mod edit -replace "modernc.org/libc=./build/android-libc-patched"
echo "build-aar: modernc.org/libc replaced with patched copy for this build" >&2

# 3. Bind.
mkdir -p "$(dirname "$ANDROID_AAR")"
# Link every native LOAD segment at a 16 KB max page size so libgojni.so is
# 16 KB page-aligned (issue #167). Without this the bind links at the default
# 4 KB page size, which trips Android 15's "not 16 KB compatible … LOAD
# segment not aligned" compatibility dialog and fails to load on devices
# booted with 16 KB pages. common-page-size keeps BSS/data segment alignment
# consistent with max-page-size. Append so any toolchain-set flags survive.
export CGO_LDFLAGS="${CGO_LDFLAGS:-} -Wl,-z,max-page-size=16384 -Wl,-z,common-page-size=16384"
# shellcheck disable=SC1090
gomobile bind \
    -target="$ANDROID_TARGETS" -androidapi 21 \
    -javapkg nz.matou.backend \
    -o "$ANDROID_AAR" ./cmd/mobile

echo "build-aar: wrote $ANDROID_AAR" >&2
