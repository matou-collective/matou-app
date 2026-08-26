# Mobile Phase 0 Spike — gomobile bind of the full backend (Android arm64)

**Issue:** [Matou/matou-app#23](https://git.matou.nz/Matou/matou-app/issues/23)
**Date:** 2026-08-12
**Scope:** Android `arm64` only (per human decision on #23). iOS `arm64` is
parked in #29 pending a macOS/Xcode host.
**Plan reference:** `docs/plans/2026-08-08-mobile-build-plan.md` (branch
`mobile-dev`) — Phase 0, spike 1.

## Result: ✅ PASS — go for the embedded-backend architecture (Android)

`gomobile bind -target=android/arm64` of the **entire** Go backend — including
on-device any-sync and the known-risk `quic-go v0.59.0` — **succeeds with zero
blockers**. No cgo or raw-syscall portability problems were found. This clears
the load-bearing risk for the embedded-backend architecture on Android.

## What was built

A minimal gomobile entry-point package, `backend/cmd/mobile`, that blank-imports
every `internal/…` backend package. The Go compiler compiles a blank-imported
package's full transitive dependency graph, so binding this one package is
equivalent to binding the whole backend (669 packages for the target). It
exposes one placeholder exported symbol (`Version()`) as the bindable surface;
the real mobile API is Phase 1 work.

## How to reproduce

```bash
cd backend
export ANDROID_NDK_HOME=/path/to/android-ndk-r27c   # NDK 27.2.12479018 (r27c)
export ANDROID_HOME=/path/to/android-sdk            # platform android-34 + build-tools 34.0.0
export JAVA_HOME=/path/to/jdk-17                     # Temurin JDK 17
export PATH="$(go env GOPATH)/bin:$JAVA_HOME/bin:$PATH"

go install golang.org/x/mobile/cmd/gomobile@latest
go install golang.org/x/mobile/cmd/gobind@latest
gomobile init

# -androidapi 21 is required: NDK r27c dropped API < 21 (gomobile still
# defaults to API 16, which the NDK rejects).
gomobile bind -target=android/arm64 -androidapi 21 \
    -javapkg=nz.matou.backend -o matou.aar \
    github.com/matou-dao/backend/cmd/mobile
```

### Toolchain used for this spike

| Component | Version |
|-----------|---------|
| Go | 1.25.5 (linux/amd64 host) |
| gomobile / gobind | `golang.org/x/mobile` pseudo-version `v0.0.0-20260812174124-2f419b2fb945` (`@latest`, 2026-08-12) |
| Android NDK | r27c (27.2.12479018) |
| Android SDK platform | android-34, build-tools 34.0.0 |
| JDK | Temurin 17.0.13+11 |
| Host | Linux x86_64, headless (no GUI, no preinstalled Android toolchain) |

The NDK, SDK commandline-tools/platform, and JDK were all installed headlessly
via direct `dl.google.com` / Adoptium downloads + `sdkmanager` — no GUI, no
macOS. Total toolchain footprint ≈ 3–4 GB.

## Evidence the artifact is real

Build wall-clock: ~71 s. Output `matou.aar` (10.6 MB) contains:

- `jni/arm64-v8a/libgojni.so` — **21.3 MB ELF, `ARM aarch64`**, dynamically
  linked, not stripped.
- `classes.jar` with the generated Java bindings
  (`nz/matou/backend/mobile/Mobile.class`).

The native library genuinely links the risk dependencies (strings embedded from
the linked packages, including the exact module versions from `go.sum`):

```
quic-go/quic-go            v0.59.0   h1:OLJkp1Mlm/aS7dpKgTc6cnpynnD2Xg7C1pwL6vy/SAw=
anyproto/any-sync          v0.11.9   h1:KS0+CFQZndCzaW67EPkHu9OKzUfMyoJsYQ1JIUNQm3k=
matou-dao/backend/internal/api ...   (also anysync, sync, notifications, keri, …)
```

Its only dynamic dependencies are standard Android system libraries —
`liblog.so`, `libandroid.so`, `libdl.so`, `libc.so` — i.e. nothing exotic that
would complicate packaging.

## Blockers found

**None.** Full enumeration of what was checked:

- **cgo:** For the `android/arm64` target the entire 669-package dependency
  graph of the backend contains **no third-party cgo** (`go list -deps` reports
  zero `CgoFiles` outside the Go standard library). The only cgo in the linked
  binary is the Go stdlib's own `net` resolver (`cgo_android.go`) and
  `runtime/cgo`, both of which gomobile + the NDK handle as a matter of course.
  Notably `any-store`'s SQLite is `modernc.org/sqlite` (pure-Go transpilation) —
  **no native libsqlite**, so there is no C library to cross-compile.
- **raw syscalls / GOOS portability:** The full module also cross-compiles
  cleanly with `GOOS=android GOARCH=arm64 CGO_ENABLED=0 go build ./...`
  (exit 0), which rules out any pure-Go build-constraint / unsupported-syscall
  breakage independent of gomobile.
- **quic-go v0.59.0 (the flagged risk):** compiles **and links** into the
  arm64 `.so`. No remediation needed.

Because there were no failures, there is no replace/patch/upstream remediation
list to produce.

## Two environment gotchas (not code blockers)

1. **`-androidapi 21` is mandatory** with NDK r27c. gomobile still defaults its
   minimum to API 16; r27c only supports 21–35 and aborts otherwise. Bake
   `-androidapi 21` (or higher) into the mobile build invocation / CI.
2. **Writable `GOPATH`/`GOBIN`.** `gomobile init` and `go install` write to
   `$GOPATH/{bin,pkg/gomobile}`. On a runner with a read-only `GOPATH` root
   (as here), point `GOPATH`/`GOBIN` at a writable path and reuse the existing
   module cache via `GOMODCACHE`. Also set `GOSUMDB=off` (or provide a writable
   sumdb cache) if the runner's default sumdb cache dir is not writable.
3. **The bind touches `go.mod`/`go.sum`.** `gomobile bind` needs
   `golang.org/x/mobile` in the module graph (the generated glue imports
   `golang.org/x/mobile/bind`), so it runs with `-mod=mod` and will add
   `golang.org/x/mobile` + transitive deps (e.g. `golang.org/x/image`) to
   `go.mod`/`go.sum`. This spike deliberately does **not** commit that churn —
   `cmd/mobile` itself imports only existing `internal/…` packages and needs no
   new dependency. A Phase 1 mobile CI job should either run the bind against a
   throwaway checkout, `git checkout -- go.mod go.sum` afterwards, or adopt
   `golang.org/x/mobile` as a tracked tool dependency on purpose.

## Recommendation

**Go** for the embedded-backend architecture on Android. The whole backend,
including on-device any-sync and quic-go v0.59.0, binds through gomobile to a
clean arm64 `.aar` with no cgo/syscall blockers. Recommended follow-ups (Phase
1, out of scope here):

- Add a CI job that runs `gomobile bind -target=android/arm64 -androidapi 21`
  against `cmd/mobile` so regressions (e.g. a future dependency that pulls in
  cgo or a non-portable syscall) are caught early.
- Confirm the same on iOS `arm64` (#29) once a macOS/Xcode host is available —
  the pure-Go, no-cgo result here is a strong positive indicator for iOS too,
  but iOS linking must be verified independently.
- Design the real gomobile binding surface (identity, sync, org operations) to
  replace the placeholder `Version()` in `cmd/mobile`.
