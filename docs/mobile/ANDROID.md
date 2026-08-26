# Android Build Guide

How to build the Matou backend as an Android library (`matou.aar`) with an
embedded, in-process backend via [gomobile](https://pkg.go.dev/golang.org/x/mobile).
Validated by the Phase 0 spike: `docs/spikes/2026-08-12-mobile-gomobile-android-spike.md`.

## Prerequisites

One-time host setup (Linux x86_64; ~1.5 GB of downloads):

```bash
./scripts/android/setup-toolchain.sh
```

This installs, idempotently, under `$HOME/.matou-android` (override with
`MATOU_ANDROID_HOME`):

| Component | Version |
|-----------|---------|
| Temurin JDK | 21.0.5+11 (Capacitor 7 needs source level 21) |
| Android cmdline-tools | 11076708 |
| Android platforms | android-34, android-35 (Capacitor 7 compileSdk) |
| Android build-tools | 34.0.0 |
| Android NDK | r27c (27.2.12479018) |
| gomobile / gobind | `golang.org/x/mobile` @ `v0.0.0-20260812174124-2f419b2fb945` |

It also writes `$HOME/.matou-android/env.sh`; source it in any shell that runs
Android builds by hand. `make build-android-aar` sources it automatically.

The script accepts the Android SDK licenses non-interactively
(`sdkmanager --licenses`) — running it implies agreeing to those terms.

Go itself is not installed by the script: any Go ≥ 1.21 on the host works,
because `GOTOOLCHAIN=auto` resolves the version pinned in `backend/go.mod`.

## Building the .aar

```bash
cd backend
make build-android-aar
```

This runs `gomobile bind` over `backend/cmd/mobile` for `android/arm64`
(devices) and `android/amd64` (emulator) and writes
`frontend/src-capacitor/android/app/libs/matou.aar`. The `.aar` is a build
artifact — never commit it (ignored via `frontend/src-capacitor/.gitignore`).

A full bind compiles the entire backend dependency graph twice (once per
architecture); expect several minutes on the first run.

`make build-android-aar` delegates to `scripts/android/build-aar.sh`, which
first runs `scripts/android/patch-libc.sh` to produce a seccomp-safe copy of
`modernc.org/libc` (see gotcha 5) and wires it in with a `replace` directive
that only exists for the duration of the bind — the committed `go.mod` is never
modified, so `go build ./...` and the desktop/server builds are unaffected.

Verify the result contains both native libraries:

```bash
unzip -l frontend/src-capacitor/android/app/libs/matou.aar | grep libgojni.so
#   jni/arm64-v8a/libgojni.so
#   jni/x86_64/libgojni.so
```

## Gotchas (from the spike)

1. **`-androidapi 21` is mandatory.** NDK r27c dropped support for API < 21,
   but gomobile still defaults to API 16, which the NDK rejects. The Makefile
   target always passes it; do the same in any manual invocation.
2. **Writable `GOPATH`/`GOBIN`.** `gomobile init` and the bind write to the Go
   module cache and `GOBIN`; don't run them in a read-only environment.
3. **`golang.org/x/mobile` is a pinned tool dependency.** The generated bind
   glue imports `golang.org/x/mobile/bind`, so `backend/go.mod` pins the module
   via `tool` directives (`cmd/gomobile`, `cmd/gobind`). This keeps
   `gomobile bind` reproducible and removes the spike-era need for `-mod=mod`.
   Keep the `go install` pin in `scripts/android/setup-toolchain.sh` and the
   `go.mod` version in sync when upgrading.
4. **cgo stays off.** The backend builds with `CGO_ENABLED=0` for
   `GOOS=android` (modernc sqlite, pure-Go quic-go). Check any new dependency
   keeps this true: `GOOS=android GOARCH=arm64 CGO_ENABLED=0 go build ./...`.
5. **`modernc.org/libc` legacy-syscall patch (issue #98).** `modernc.org/libc`
   (pulled in transitively via anystore → modernc sqlite) ships musl-derived
   `linux/amd64` codegen (`ccgo_linux_amd64.go`) that issues *legacy* path
   syscalls — `lstat`/`stat`/`unlink`/`rmdir`/`mkdir`/`rename`/`access`/`chmod`/
   `chown`/`readlink`/`link`/`symlink`/`open`. Android's app seccomp policy
   blocks all of them and only allows the `*at`-family variants, so any one =
   `SIGSYS` = the embedded backend dies on the `android/amd64` emulator.
   (`android/arm64` real devices are unaffected — the arm64 kernel ABI has no
   legacy path syscalls, so musl's arm64 codegen already uses `*at`.)

   `scripts/android/patch-libc.sh` copies the pinned libc out of the module
   cache into `backend/build/android-libc-patched/` (gitignored) and rewrites
   every legacy call site to its `*at` equivalent (routed through `AT_FDCWD`).
   `build-aar.sh` wires that copy in with a build-scoped `replace` so nothing
   is committed and non-Android builds are untouched. The `*at` variants are
   semantically identical and predate Linux 2.6.16, so the patch is a safe
   drop-in on any `linux/amd64` target.

   The rewrite is **asserted**: each substitution has an exact expected hit
   count and a final sweep fails the build if any legacy path syscall survives.
   So when you **bump `modernc.org/libc`** and its codegen shifts, the next
   `make build-android-aar` errors loudly instead of silently shipping a
   crashing `.aar`. When that happens, open the new
   `ccgo_linux_amd64.go` and re-derive the substitution table (the `__DATA__`
   block in `patch-libc.sh`) against the new call sites, then rebuild.

## Exposed API

`backend/cmd/mobile` is the bind surface (Java package `nz.matou.backend`).
See its package docs for the current exported API; issue #67 tracks the real
`Start`/`Stop` surface replacing the spike-era placeholder.
