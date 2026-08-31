# Spec: tag-triggered Mac, Android and iOS release builds on GitHub Actions

**Status:** proposed (2026-08-31)
**Scope:** every `v*` tag produces signed installers for macOS (arm64 + x64 DMG), Android (Play AAB + sideload APK) and iOS (TestFlight IPA), built on GitHub-hosted runners, attached to one draft GitHub release. Linux and Windows keep building as they do today. Forgejo (git.matou.nz) stays the source of truth and the PR/CI host; GitHub is the release builder "for now".
**Out of scope:** PR builds on GitHub, auto-publishing to the Play production track / App Store review, a self-hosted macOS runner.

---

## 0. Where we are

| Platform | Built today? | Where | Gap |
| --- | --- | --- | --- |
| macOS (dmg, signed + notarized, arm64 & x64) | yes | `.github/workflows/build.yml` on `macos-latest` / `macos-15-intel` | tags stopped reaching GitHub: `github/main` is 272 commits behind `origin/main`, `v0.4.1` exists only on Forgejo. Last GitHub release is v0.4.0 (2026-08-07). |
| Linux AppImage, Windows NSIS | yes | same workflow | same mirror gap |
| Android AAB (signed) | yes | `.forgejo/workflows/android.yml` `build-aab` on `matou-workstation` | not on GitHub; artefact only, not attached to a release |
| Android APK (debug) | PR-only | Forgejo `build-apk` | no release APK for sideload testers |
| iOS | no | — | no Capacitor iOS platform, no Swift plugins, no signing assets; gomobile iOS link unverified (Forgejo #29, parked "needs macOS") |

Facts the design leans on:

- `matou-collective/matou-app` on GitHub is **public** → standard GitHub-hosted runners, including `macos-latest` (Apple silicon), are free. No billing change.
- `scripts/release.sh` (`npm run release -- X.Y.Z` in `frontend/`) bumps `frontend/package.json`, commits, tags, and pushes `main` + tag to **both** `origin` and `github`. The v0.4.1 tag bypassed it.
- Electron-builder `publish` is `github` / `releaseType: draft`; the desktop jobs already create the draft release the mobile jobs should attach to.
- The embedded backend API is `backend/cmd/mobile`: `Start(dataDir, configServerURL, apiToken string) (int, error)` and `Stop() error`. Android binds it with `gomobile bind` (`scripts/android/build-aar.sh`), pure Go, `CGO_ENABLED=0` semantics, no cgo deps — the Phase-0 spike's strongest indicator that iOS will link.
- The two native Capacitor plugins are small: `MatouBackendPlugin.java` (83 lines, one method `getInfo() → {port, token}`) and `SecureStoragePlugin.java` (127 lines, `getItem/setItem/removeItem`). The JS side (`frontend/src/lib/capacitor.ts`) talks to `window.Capacitor.Plugins.*` and is platform-agnostic.
- The backend's CORS allow-list already accepts `capacitor://` (iOS WKWebView origin) alongside `https://localhost` (Android) — `backend/internal/api/middleware.go:isBundledOrigin`.
- Capacitor `appId` is `nz.matou.app` (Android). Electron uses `org.matou.app`. iOS should use **`nz.matou.app`** so Play and App Store identities match.
- `build.yml` pins `setup-go@v4` to `1.21` while `backend/go.mod` says `go 1.25.5`; it only works because Go auto-downloads the newer toolchain. Fix while we are in there.

---

## 1. Target design

One workflow, one tag, one draft release:

```
push tag v*  ──► .github/workflows/build.yml
                  ├─ prepare        (matrix + version derivation, ubuntu)
                  ├─ desktop[mac-arm64, mac-x64, linux, windows]   (existing matrix)
                  ├─ android        (ubuntu-latest)     → .aab + .apk
                  ├─ ios            (macos-latest)      → .ipa → TestFlight
                  └─ release        (ubuntu-latest, needs: all) → attach mobile files to the draft release, print summary
```

Version derivation (single source, output of `prepare`, consumed by all jobs):

| Output | Rule | Used by |
| --- | --- | --- |
| `version` | `frontend/package.json` `.version` (must equal tag minus `v`; fail otherwise) | artefact names, `CFBundleShortVersionString`, `versionName` |
| `build_number` | `MMMmmmppp` from the tag (`0.4.1 → 4001`), exactly as `android.yml` does; on `workflow_dispatch` off a tag: `run_number` | Android `versionCode`, iOS `CFBundleVersion` |

Triggers: `push: tags: ['v*']` and `workflow_dispatch` with `platform` choice extended to `android`, `ios`, `mobile`, `all`. Nothing runs on PRs or branch pushes.

Failure isolation: `fail-fast: false` everywhere; a red iOS job must not cancel a green Mac build. The `release` job runs with `if: always()` and reports per-platform status in the job summary.

---

## 2. Work packages

Ordered so each lands value on its own. WP1 alone restores Mac releases.

### WP1 — Restore the GitHub release path (Mac now)

1. **Mirror Forgejo → GitHub automatically.** Forgejo repo → Settings → Repository → Mirror Settings → *Push mirror* to `https://github.com/matou-collective/matou-app.git` with a GitHub fine-grained token (Contents: read/write), *Sync when commits are pushed* on, tags included. Keep `scripts/release.sh` pushing to both as belt-and-braces; the mirror covers tags pushed any other way.
2. **Catch up now:** `git push github main && git push github v0.4.1` → kicks off the v0.4.1 desktop build. (If `main` on GitHub has diverged rather than merely lagged, force-push is acceptable — GitHub is a mirror.)
3. **`build.yml` hygiene** (small PR):
   - `setup-go@v5` with `go-version-file: backend/go.mod`, cache on.
   - `prepare` emits `version` + `build_number` as above and fails if `package.json` version ≠ tag.
   - Move the raw `run: echo "$APPLE_API_KEY_CONTENT" > AuthKey_….p8` into `$RUNNER_TEMP` and reference it by absolute path (keeps the key out of the repo checkout / artefact upload glob).
4. **Forgejo `android.yml`:** leave the tag-triggered `build-aab` job alone for now — it is the only AAB producer until WP2 is green. WP2 removes its `push: tags` trigger (or makes it `workflow_dispatch`-only) in the same PR that adds the GitHub `android` job, so there is never a tag with no AAB and never two AABs per tag on a capacity-1 runner. The PR debug-APK job stays either way.

**Done when:** pushing a `v*` tag on Forgejo produces a draft GitHub release with Mac arm64/x64 DMGs, AppImage and NSIS exe within ~20 min, with no manual `git push github`.

### WP2 — Android on GitHub (AAB + APK)

New job `android`, `runs-on: ubuntu-latest`, `needs: prepare`, `timeout-minutes: 60`.

Steps:
1. `actions/checkout@v4`, `setup-node@v4` (22, npm cache on `frontend/package-lock.json`), `setup-go@v5` (`go-version-file`).
2. `bash scripts/android/setup-toolchain.sh` — installs JDK 21 + SDK/NDK r27c + pinned gomobile into `~/.matou-android`. Cache `~/.matou-android` with `actions/cache` keyed on the script's hash (first run ~2.9 GB download, cached runs skip). `ubuntu-latest` has 16 GB RAM, so the gobind OOM that hit the Forgejo runner does not apply.
3. `make -C backend build-android-aar` (arm64 + amd64 as today) and the existing 16 KB page-alignment check from `android.yml` (copy the step verbatim).
4. `cd frontend && npm ci`.
5. Materialise keystore: `echo "$ANDROID_KEYSTORE_B64" | base64 -d > $RUNNER_TEMP/upload.jks`; export `MATOU_KEYSTORE_FILE`, `MATOU_KEYSTORE_PASSWORD`, `MATOU_KEY_ALIAS`, `MATOU_KEY_PASSWORD`, `MATOU_VERSION_CODE=${build_number}`, `MATOU_VERSION_NAME=${version}`, `VITE_PROD_CONFIG_URL`.
6. `bash scripts/android/build-aab.sh` → `frontend/dist/capacitor/android/bundle/release/app-release.aab`.
7. Release APK for testers: `cd frontend/src-capacitor/android && ./gradlew assembleRelease` (same signing config, same env) → `app-release.apk`. Rename both to `matou-${version}-android.aab` / `.apk`.
8. Verify: `apksigner verify --print-certs` on the APK; `bundletool validate` on the AAB (or `unzip -l` sanity); assert `versionCode` via `aapt2 dump badging`.
9. `actions/upload-artifact@v4` both files.

Reuse, not rewrite: the job is the Forgejo `build-aab` job with the raw-clone step replaced by `actions/checkout` and secrets renamed to the GitHub set (§4). `build-aab.sh` and `build.gradle` are unchanged.

**Done when:** the tag run's draft release carries a signed `.aab` (uploadable to Play internal testing as in `docs/mobile/PLAY_STORE.md`) and a signed `.apk` that installs on a device.

### WP3 — iOS Phase 0: prove the backend links (unparks Forgejo #29)

Before touching Xcode projects, answer the one real unknown. New `workflow_dispatch`-only job `ios-spike` on `macos-latest`:

```
go install golang.org/x/mobile/cmd/gomobile@<pinned pseudo-version from setup-toolchain.sh>
gomobile init
cd backend && gomobile bind -target=ios,iossimulator -o $RUNNER_TEMP/Matou.xcframework ./cmd/mobile
```

Upload the xcframework as an artefact and print `lipo -info` / `otool -L` on the arm64 slice. Do **not** apply the Android seccomp `libc` replace from `build-aar.sh` (Android-only).

Expected outcome: pass. Known risks to enumerate if not: `quic-go` (any-sync transport), `modernc.org/sqlite` (pure-Go SQLite; verify the `ios` build tags exist for the version in `go.mod`), anything using `syscall` directly. Record pass/fail + any blockers in #29 and close it. If it fails, the remediation estimate goes to the human before WP4 starts.

Also decide here: `-target=ios` only (device) vs `ios,iossimulator`. Ship both — the simulator slice costs nothing and is what any Mac-owning contributor will use locally.

**Done when:** #29 closed with an `.xcframework` artefact from CI and `MobileStart`/`MobileStop` visible in the generated header.

### WP4 — Capacitor iOS shell + Swift plugins

Land on a branch, build-verified by the WP5 job before merge (nobody needs a Mac, but having one shortens the loop a lot).

1. `cd frontend/src-capacitor && npm i @capacitor/ios@^7 && npx cap add ios` → `ios/App/App.xcodeproj`, bundle id `nz.matou.app`, display name Matou, deployment target iOS 15 (Capacitor 7 minimum is 14; 15 keeps SwiftUI-free code simple).
2. Vendor the backend: `Matou.xcframework` goes to `frontend/src-capacitor/ios/App/Frameworks/` (git-ignored, produced by `make -C backend build-ios-xcframework` — new Makefile target wrapping the WP3 command, mirroring `build-android-aar`). Link it in the App target (Embed & Sign).
3. `MatouBackendPlugin.swift` — port of the Java plugin:
   - `@objc(MatouBackendPlugin) class … : CAPPlugin, CAPBridgedPlugin` with one `getInfo` method.
   - dataDir = `FileManager.default.urls(for: .applicationSupportDirectory …)/matou` (excluded from iCloud backup: `isExcludedFromBackup = true` — it holds key material and any-sync state).
   - configServerUrl from `getConfig().getString("configServerUrl")` (baked by the build script exactly as Android).
   - token: 32 random bytes from `SecRandomCopyBytes`, hex — same as Android.
   - Call `MobileStart(dataDir, url, token, &port)` on a background queue; start once per process; resolve `{port, token}`; reject with the Go error message. Mirror the Android idempotency/retry semantics (`capacitor.ts` un-memoises on failure).
4. `SecureStoragePlugin.swift` — Keychain-backed `getItem/setItem/removeItem`, service `nz.matou.app`, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (no iCloud Keychain sync — these are device-bound identity secrets, same posture as Android's Keystore-held master key). Same JSON shapes as the Java plugin so `frontend/src/lib/capacitor.ts` needs no change.
5. `Info.plist`:
   - `NSAppTransportSecurity` → `NSAllowsLocalNetworking = true` (WKWebView → `http://127.0.0.1:<port>`). No arbitrary-loads exception: the WebView never talks to the config server, the Go backend does, and Go's `net/http` is not subject to ATS. Verify on-device; if ATS still blocks loopback add an `NSExceptionDomains` entry for `127.0.0.1` rather than `NSAllowsArbitraryLoads`.
   - `ITSAppUsesNonExemptEncryption = false` is **wrong** for us — we ship KERI signing and any-sync encryption. Either answer the export-compliance questionnaire in App Store Connect once (standard/open-source exemption, ECCN 5D992) and set `ITSAppUsesNonExemptEncryption = true` with `ITSEncryptionExportComplianceCode` after approval, or accept the manual prompt per build. Flag for the human; not a build blocker for TestFlight internal testers.
   - `PrivacyInfo.xcprivacy` (required for App Store submission since 2024): declare `NSPrivacyAccessedAPICategoryFileTimestamp` / `UserDefaults` reasons Capacitor already documents; no tracking.
6. `frontend/quasar.config.ts` / `capacitor.config.json`: nothing platform-specific needed; `webDir: www` is shared.
7. `scripts/ios/build-ipa.sh` — the iOS counterpart of `build-aab.sh`: same config-URL guard (refuse localhost/private, warn on plain http), bake `configServerUrl`, `quasar build -m capacitor -T ios` (or `npm run build` + `npx cap sync ios`), then `xcodebuild -workspace App.xcworkspace -scheme App -configuration Release -archivePath … archive` and `-exportArchive -exportOptionsPlist` (method `app-store-connect`, manual signing, provisioning profile by name). Inputs via env: `MATOU_IOS_TEAM_ID`, `MATOU_IOS_PROFILE_NAME`, `MATOU_VERSION_CODE`, `MATOU_VERSION_NAME` (written with `agvtool` / `PlistBuddy` into `CFBundleVersion` / `CFBundleShortVersionString` before archiving).
8. `docs/mobile/IOS.md`: local recipe (Mac required locally: Xcode 16, `make build-ios-xcframework`, `npx cap open ios`, simulator run), the CI recipe, the TestFlight steps, gotchas as they are found. Add `ios` to `CLAUDE.md`'s Mobile section.

Behavioural notes to document, not solve now: iOS suspends the process on background → the embedded backend (any-sync, KERIA sessions) stops until foreground; `capacitor.ts` already retries `getBackendInfo` on failure, and the Go side's `Start` is idempotent, so resume works, but sync catch-up latency after backgrounding is expected.

**Done when:** `xcodebuild archive` succeeds in CI (WP5 job, unsigned dry run acceptable) and a simulator build boots to the onboarding screen with the backend port resolved.

### WP5 — iOS release job (sign → IPA → TestFlight)

New job `ios`, `runs-on: macos-latest`, `needs: prepare`, `timeout-minutes: 60`.

1. checkout, setup-node, setup-go (`go-version-file`), `sudo xcode-select -s /Applications/Xcode_16.x.app` (pin the major; GitHub rotates defaults).
2. `go install gomobile@<pinned>`, `gomobile init`, `make -C backend build-ios-xcframework`. Cache `~/go/pkg/mod` and `~/Library/Caches/go-build`.
3. `cd frontend && npm ci && cd src-capacitor && npm ci`, `pod install` if Capacitor 7 generated a Podfile (it does by default; alternatively SPM — decide in WP4, prefer SPM to avoid CocoaPods on the runner).
4. **Signing keychain** (hand-rolled, no fastlane dependency):
   ```
   security create-keychain -p "$KC_PW" build.keychain
   security default-keychain -s build.keychain
   security unlock-keychain -p "$KC_PW" build.keychain
   echo "$IOS_DIST_CERT_P12_B64" | base64 -d > $RUNNER_TEMP/dist.p12
   security import $RUNNER_TEMP/dist.p12 -k build.keychain -P "$IOS_DIST_CERT_PASSWORD" -T /usr/bin/codesign
   security set-key-partition-list -S apple-tool:,apple: -s -k "$KC_PW" build.keychain
   mkdir -p ~/Library/MobileDevice/Provisioning\ Profiles
   echo "$IOS_PROVISIONING_PROFILE_B64" | base64 -d > ~/Library/MobileDevice/Provisioning\ Profiles/matou-appstore.mobileprovision
   ```
   Always-run cleanup step: `security delete-keychain build.keychain`.
5. `bash scripts/ios/build-ipa.sh` → `matou-${version}-ios.ipa`.
6. Verify: `codesign -dv --verbose=4` on the `.app` inside the IPA, check `CFBundleVersion == build_number`, `CFBundleIdentifier == nz.matou.app`.
7. Upload to App Store Connect / TestFlight with the API key already used for notarization:
   ```
   xcrun altool --upload-app -t ios -f matou-${version}-ios.ipa \
     --apiKey "$APPLE_API_KEY_ID" --apiIssuer "$APPLE_API_ISSUER"
   ```
   (`altool` upload is still supported; `xcrun notarytool` is notarization-only. If Apple removes it, swap for `iTMSTransporter` or `fastlane pilot` — same inputs.) The existing key must have the **App Manager** role for uploads; a Developer-role key that suffices for notarization will be rejected — check in App Store Connect → Users and Access → Integrations.
8. Upload artefact; TestFlight processing (5–30 min) happens on Apple's side; internal testers get it automatically once the build finishes processing, external groups need one-time Beta App Review.

Gate: `if: needs.prepare.outputs.ios_enabled == 'true'` driven by a repo variable `IOS_RELEASE_ENABLED`, so WP1/WP2 can ship and run green before WP4/WP5 land.

**Done when:** a tag run ends with a build visible in TestFlight and the IPA attached to the draft release.

### WP6 — `release` job (assemble)

`needs: [desktop, android, ios]`, `if: always()`, `ubuntu-latest`:

1. Download all artefacts.
2. `gh release view "$TAG"` — electron-builder should already have created the draft; if not (desktop failed), `gh release create "$TAG" --draft --title "$TAG" --generate-notes`.
3. `gh release upload "$TAG" *.aab *.apk *.ipa --clobber`.
4. Write a job summary table: platform / status / artefact name / size / sha256. Optionally post the same to Mattermost via the existing `notify-mattermost.sh` pattern (needs the two Mattermost secrets on GitHub; fine to defer).
5. The release stays **draft** — a human publishes after checking the Play/TestFlight side, as today.

---

## 3. One-time Apple setup (human, ~1–2 h, needs the Apple Developer account owner)

1. Certificates, Identifiers & Profiles → Identifiers → App ID `nz.matou.app` (explicit), capabilities: none beyond default (add Push later if needed).
2. Certificates → **Apple Distribution** (one cert covers iOS + Mac App Store; the existing Developer ID cert used for the DMG is a different type and cannot sign App Store builds). Export as `.p12` with a password.
3. Profiles → App Store Connect distribution profile for `nz.matou.app` → name it `matou-appstore`.
4. App Store Connect → My Apps → New app: platform iOS, bundle `nz.matou.app`, SKU `matou-ios`, primary language English (NZ). Fill Privacy Policy URL (reuse `docs/mobile/PRIVACY_POLICY.md`'s published URL), age rating, App Privacy labels (mirror the Play data-safety answers). TestFlight → Internal testing group with the same testers as Play internal.
5. Users and Access → Integrations → App Store Connect API: confirm the existing key (`APPLE_API_KEY_ID`) has App Manager access, or issue a second key for uploads.
6. Export compliance answer (see WP4 §5).

---

## 4. Secrets and variables (GitHub repo settings)

Already present (used by the Mac job): `GH_TOKEN`, `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_API_KEY_CONTENT`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `APPLE_TEAM_ID`, `VITE_PROD_CONFIG_URL`, `VITE_ENV`, `VITE_SMTP_HOST`, `VITE_SMTP_PORT`.

Add:

| Secret | Value | Used by |
| --- | --- | --- |
| `ANDROID_KEYSTORE_B64` | `base64 -w0 matou-upload.jks` (same file as Forgejo) | android |
| `ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_ALIAS` / `ANDROID_KEY_PASSWORD` | same values as Forgejo | android |
| `IOS_DIST_CERT_P12_B64` | `base64 -w0 dist.p12` | ios |
| `IOS_DIST_CERT_PASSWORD` | p12 password | ios |
| `IOS_PROVISIONING_PROFILE_B64` | `base64 -w0 matou-appstore.mobileprovision` | ios |

| Variable (not secret) | Value |
| --- | --- |
| `IOS_RELEASE_ENABLED` | `false` until WP5 is green, then `true` |
| `IOS_PROFILE_NAME` | `matou-appstore` |

Naming note: Forgejo calls the config URL `PROD_CONFIG_URL`, GitHub already calls it `VITE_PROD_CONFIG_URL`. Keep GitHub's name; the scripts read `VITE_PROD_CONFIG_URL`. Add all of the above to `docs/SECRETS_CHECKLIST.md` under a new "GitHub release secrets" section.

---

## 5. Risks and open questions

| # | Risk | Mitigation |
| --- | --- | --- |
| R1 | gomobile iOS link fails (quic-go / modernc sqlite) | WP3 is a 15-minute CI experiment before any Xcode work; blockers get an estimate before WP4 is scheduled. |
| R2 | Config server is plain `http` (`awa.matou.nz:3904`) | Not a WebView/ATS problem on iOS (Go does the fetch), but Play and App Store reviewers frown on it and `build-aab.sh` already warns. Track the TLS move separately; not blocking. |
| R3 | `altool` upload deprecated | Same inputs feed `iTMSTransporter` / `fastlane pilot`; swap the one step. |
| R4 | GitHub macOS runner Xcode version drift | Pin `xcode-select` to a major; bump deliberately. |
| R5 | Double AAB builds (Forgejo + GitHub) with the same `versionCode` | WP2 removes the Forgejo tag trigger in the same PR that adds the GitHub job. |
| R6 | Mirror token leaks / expires | Fine-grained token scoped to one repo, Contents only, 1-year expiry, calendar reminder. `release.sh` still pushes to GitHub directly, so a dead mirror degrades to today's behaviour, not silence. |
| R7 | Backgrounded iOS app stops the backend | Documented; app resumes cleanly because `Start` is idempotent. Background modes are a later product decision. |
| Q1 | Bundle id for iOS: `nz.matou.app` (match Android) vs `org.matou.app` (match Electron)? | Spec assumes `nz.matou.app`. |
| Q2 | Keep the Forgejo PR debug-APK job? | Yes — it is the only place PRs get a device build; unaffected by this spec. |
| Q3 | Should Android also go to Play internal testing automatically? | Out of scope here; that is Forgejo #202 and slots into the `android` job as one extra step later. |

---

## 6. Sequencing and estimates

| WP | Depends on | Effort | Deliverable |
| --- | --- | --- | --- |
| WP1 mirror + Mac | — | ½ day | v0.4.1 Mac/Linux/Windows release on GitHub, mirror live |
| WP2 Android on GitHub | WP1 | 1 day | AAB + APK attached to the draft release |
| WP3 iOS link spike | — (parallel with WP2) | ½ day | #29 closed, xcframework artefact |
| §3 Apple setup | account owner | 1–2 h | cert, profile, App Store Connect record |
| WP4 iOS shell + Swift plugins | WP3 pass | 3–5 days | boots in simulator/CI archive |
| WP5 iOS release job | WP4, §3 | 1–2 days | IPA in TestFlight from a tag |
| WP6 assemble job | WP2 (extend when WP5 lands) | ½ day | one draft release with every installer |

Total: roughly two working weeks elapsed, with Mac restored on day one and Android on GitHub by day two.

---

## 7. Acceptance test (end state)

```
cd frontend && npm run release -- 0.5.0
```

Within ~45 minutes, `https://github.com/matou-collective/matou-app/releases/tag/v0.5.0` (draft) lists:

- `matou-0.5.0-darwin-arm64.dmg`, `matou-0.5.0-darwin-x64.dmg` (signed, notarized, `spctl --assess` passes)
- `matou-0.5.0-linux.AppImage`, `matou-0.5.0-win32.exe`
- `matou-0.5.0-android.aab` (versionCode 5000, signed with the upload key), `matou-0.5.0-android.apk` (installs via `adb install`)
- `matou-0.5.0-ios.ipa` (CFBundleVersion 5000), and build 5000 appears under TestFlight → iOS builds

with no step run by hand other than `npm run release` and, later, clicking *Publish release*.
