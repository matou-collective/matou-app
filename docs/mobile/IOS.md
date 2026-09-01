# iOS Build Guide

The iOS app is the same shape as Android (`ANDROID.md`): the full Go backend is
compiled with `gomobile bind` into `Matou.xcframework` and embedded in a
Capacitor shell; the WebView talks to it on `http://127.0.0.1:<port>` with a
per-launch API token. Two app-local Swift plugins expose exactly the JS contract
the Java plugins do, so `frontend/src/lib/capacitor.ts` is shared.

| Piece | Where |
| --- | --- |
| Backend bind | `backend/scripts/ios/build-xcframework.sh` (`make -C backend build-ios-xcframework`) → `frontend/src-capacitor/ios/App/Frameworks/Matou.xcframework` (git-ignored) |
| Linking | `frontend/src-capacitor/ios/App/Frameworks/MatouBackend.podspec` — a local pod with `vendored_frameworks`, pulled in by the Podfile. `project.pbxproj` never has to be hand-edited for the framework. |
| Shell | `frontend/src-capacitor/ios/App/` (Capacitor 7 template, bundle id `nz.matou.app`, deployment target iOS 15) |
| Plugins | `App/App/MatouBackendPlugin.swift` (boots the backend, `getInfo() → {port, token}`), `App/App/SecureStoragePlugin.swift` (Keychain `getItem/setItem/removeItem`), registered in `App/App/MatouViewController.swift` (Main.storyboard points at it) |
| App build | `scripts/ios/build-ipa.sh` (`--simulator`, `--unsigned-archive`, or signed IPA) |
| CI | `.github/workflows/build.yml` job `ios` — `workflow_dispatch` with `platform: ios` (WP4 of `docs/plans/2026-08-31-github-release-builds-spec.md`) |

The backend link itself was proven by the `ios-spike` job (Forgejo #29): the
whole dependency graph — any-sync, quic-go, modernc sqlite, KERI — builds for
`ios` and `iossimulator` with the committed `go.mod` and **no** libc patch (the
Android seccomp patch is Android-only).

## Prerequisites (local, macOS only)

Nothing here needs a Mac for CI — GitHub's hosted `macos-latest` runners do it
all. Locally you need:

- Xcode 16+ with the iOS platform installed (`xcodebuild -runFirstLaunch`, `xcodebuild -downloadPlatform iOS`)
- Go per `backend/go.mod` (1.25.x)
- gomobile + gobind at the pinned revision (the same `XMOBILE_VERSION` as `scripts/android/setup-toolchain.sh`):
  ```bash
  go install golang.org/x/mobile/cmd/gomobile@v0.0.0-20260812174124-2f419b2fb945
  go install golang.org/x/mobile/cmd/gobind@v0.0.0-20260812174124-2f419b2fb945
  gomobile init
  ```
- Node 22, CocoaPods (`brew install cocoapods`)
- `frontend/.env.production` with `VITE_PROD_CONFIG_URL` (or export it)

## Simulator recipe

```bash
cd backend && make build-ios-xcframework     # ~4 min; device + simulator slices
cd .. && scripts/ios/build-ipa.sh --simulator
xcrun simctl boot "iPhone 16" ; open -a Simulator
xcrun simctl install booted frontend/dist/capacitor/ios/simulator/Matou.app
xcrun simctl launch --console booted nz.matou.app        # Go backend logs come out on stderr
```

The first `getBackendInfo()` from the WebView calls `MobileStart`; the plugin
logs `backend up on 127.0.0.1:<port>` to os_log (`subsystem == "nz.matou.app"`).
The Simulator shares the Mac's loopback, so `curl http://127.0.0.1:<port>/health`
works from a terminal. For day-to-day iteration `npx cap open ios` in
`frontend/src-capacitor` opens the workspace in Xcode; run `npx cap sync ios`
after every `quasar build -m capacitor -T ios --skip-pkg`.

The same steps run in CI: dispatch `Matou App Build` with `platform: ios`. It
builds the Simulator app, boots a simulator on the runner, waits for
`backend up`, hits `/health`, screenshots the app (artefact `ios-smoke`), then
does an unsigned Release device archive and uploads the Simulator app zip
(`xcrun simctl install booted Matou.app` after unzipping).

## Signed build / TestFlight (WP5)

`scripts/ios/build-ipa.sh` with no flag archives with manual signing and
exports an App Store IPA. Inputs: `MATOU_IOS_TEAM_ID`, `MATOU_IOS_PROFILE_NAME`
(a distribution profile for `nz.matou.app`), optional
`MATOU_IOS_SIGNING_IDENTITY` (default `Apple Distribution`) and
`MATOU_IOS_EXPORT_METHOD` (default `app-store-connect`). `MATOU_VERSION_CODE`
becomes `CFBundleVersion` and must increase per upload — CI derives it from the
tag (`MMMmmmppp`, same number as the Android `versionCode`). The one-time Apple
setup (certificate, profile, App Store Connect record, API key role) and the CI
keychain + `altool` upload are §3 / WP5 of the spec; they are not wired yet.

## Gotchas

- **gomobile emits a static framework.** `otool -L` on `Matou.framework/Matou`
  lists archive members, `vtool` errors — expected. It is linked, not embedded,
  by the `MatouBackend` pod.
- **`-lresolv`.** Go's resolver on Darwin calls `res_search`; the podspec adds
  `s.libraries = 'resolv'`. Without it the final app link fails with undefined
  `_res_9_*` symbols.
- **Registering app-local plugins.** Capacitor auto-registers only npm-packaged
  plugins (`packageClassList`). Ours live in the app target, so
  `MatouViewController.capacitorDidLoad()` calls `registerPluginInstance` —
  and `Main.storyboard`'s view controller must stay `MatouViewController`
  (`customModule="App"`). Reverting it to `CAPBridgeViewController` gives a
  WebView with no `MatouBackend` plugin and a "plugin unavailable" error.
- **`cap sync ios` rewrites `App/App/capacitor.config.json`** from
  `src-capacitor/capacitor.config.json` — that is how the baked
  `configServerUrl` reaches `getConfig()`. It is git-ignored; the source file's
  `configServerUrl` is `""` on purpose (the build scripts fill it).
- **ATS / cleartext.** `Info.plist` sets `NSAllowsLocalNetworking` so the WebView
  may talk to `http://127.0.0.1`. Nothing more is opened, deliberately: this
  mirrors Android's `network_security_config`, which permits cleartext to
  loopback only. The WebView **cannot** fetch the plain-http config server
  directly on either platform — `capacitor://localhost` (iOS) and
  `https://localhost` (Android) are secure origins, so a plain-http subresource
  is blocked as mixed content no matter what ATS allows. That is why
  `clientConfig.ts` sources the client config from the embedded backend's
  loopback endpoint (issue #99); Go's `net/http` is not subject to either
  policy. Adding an `NSExceptionDomains` entry does **not** work around this and
  would only put iOS below Android's posture — don't.
- **"Cannot connect to config server" on a fresh install** is expected today and
  is not iOS-specific. `fetchOrgConfig()` asks the backend first, and the
  backend's `/api/v1/org/config` serves only its own cache — it mirrors org
  config *to* the config server and never fetches *from* it — so a device with
  no org yet gets a 404 and then falls back to the direct fetch that the
  paragraph above blocks. Android shows the same screen when pointed at a
  remote plain-http config server; the dev/e2e recipes avoid it by pointing at
  a localhost config server (`adb reverse`). Fixing it properly means giving
  org config the same #99 treatment (proxy it through the backend) or moving
  the config server to https — an app-level change, tracked separately.
- **Data dir** is `<Application Support>/matou`, excluded from backup (key
  material + any-sync state; same device-bound posture as Android). Keychain
  items use `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` — no iCloud
  Keychain sync.
- **Backgrounding.** iOS suspends the process when the app leaves the foreground,
  so the embedded backend (any-sync, KERIA sessions) stops until the user comes
  back. `MobileStart` is idempotent and `capacitor.ts` retries a failed
  `getBackendInfo()`, so resume works; expect sync catch-up latency. Background
  modes are a later product decision.
- **Export compliance.** The app ships KERI signing and any-sync encryption, so
  `ITSAppUsesNonExemptEncryption = false` would be wrong. Either answer the
  export-compliance questionnaire once in App Store Connect (open-source /
  standard-algorithm exemption) and add the compliance code to `Info.plist`, or
  accept the manual prompt per TestFlight build. Not a build blocker for
  internal testers.
- **`PrivacyInfo.xcprivacy`** declares the required-reason APIs Capacitor core
  and the Go runtime touch (file timestamps, UserDefaults, disk space); no
  tracking. Required for App Store submission.
- **A flaky `xcodebuild archive`.** Run 33463417761 failed with
  `rsync: Capacitor.framework/...: write: Input/output error` during the pod
  framework copy. It was **not** disk exhaustion — `df` reported ~96 GiB free
  on the same runner — and the identical job passed on the next run, so treat a
  one-off I/O error there as a runner fault and re-dispatch. The Simulator app
  is zipped and uploaded *before* the archive step so a repeat still leaves you
  with a testable artefact and the smoke evidence.
- **CocoaPods, not SPM.** Capacitor 7 supports both; CocoaPods was chosen so the
  xcframework can be linked from a podspec without hand-editing the pbxproj, and
  `pod install` runs inside `cap sync ios`. `App/Pods` is git-ignored.
