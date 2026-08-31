# Play Store release guide (Android)

How a signed release App Bundle (`.aab`) of `nz.matou.app` is built and gets
onto the Google Play internal-testing track. Issue #176; auto-upload from CI
is a follow-up (#202). For the toolchain and debug builds see
[ANDROID.md](ANDROID.md).

## Pieces

| Piece | Where |
| --- | --- |
| Signing + version wiring | `frontend/src-capacitor/android/app/build.gradle` (top of file) |
| Local secrets file | `frontend/src-capacitor/android/keystore.properties` (git-ignored; copy `keystore.properties.example`) |
| Build script | `scripts/android/build-aab.sh` → `frontend/dist/capacitor/android/bundle/release/app-release.aab` |
| CI job | `build-aab` in `.forgejo/workflows/android.yml` — runs on `v*` tag push, or `workflow_dispatch` with `release=true` |
| Policies Play links to | `docs/mobile/PRIVACY_POLICY.md`, `TERMS_OF_USE.md`, `CHILD_SAFETY_STANDARDS.md` (must be hosted at public URLs — see below) |

Inputs the gradle file understands (env wins over `keystore.properties`):

| Env | `keystore.properties` key | Meaning |
| --- | --- | --- |
| `MATOU_KEYSTORE_FILE` | `storeFile` | path to the upload keystore (`.jks`) |
| `MATOU_KEYSTORE_PASSWORD` | `storePassword` | |
| `MATOU_KEY_ALIAS` | `keyAlias` | `matou-upload` |
| `MATOU_KEY_PASSWORD` | `keyPassword` | |
| `MATOU_VERSION_CODE` | — | integer, must strictly increase per Play upload (default `1`) |
| `MATOU_VERSION_NAME` | — | shown to users (default: `frontend/package.json` version) |

With no signing input the release build is produced **unsigned** (gradle
prints a warning; `build-aab.sh` refuses unless `--allow-unsigned`).
`minifyEnabled` stays off — R8 keep rules for the gomobile JNI bridge
(`go.Seq`, `matou.*`) have not been validated on-device.

## 1. Upload keystore (one-time)

Matou uses **Play App Signing**: Google holds the app signing key; we hold
only an *upload* key. If the upload key is lost it can be reset through Play
support, so its custody is important but not catastrophic.

Generate it on a trusted machine (never inside the repo):

```sh
mkdir -p ~/.matou-secrets && chmod 700 ~/.matou-secrets
keytool -genkeypair -v \
  -keystore ~/.matou-secrets/matou-upload.jks \
  -alias matou-upload -keyalg RSA -keysize 4096 -validity 10000 \
  -dname "CN=Matou, O=Matou, L=Wellington, C=NZ"
```

Then:

1. Put the keystore + both passwords in the org password manager (entry
   "Play upload key — nz.matou.app"). This is the source of truth.
2. GitHub (`matou-collective/matou-app`, where release builds run) → Settings →
   Secrets and variables → Actions — and Forgejo → Settings → Actions → Secrets
   for the manual smoke job:
   - `ANDROID_KEYSTORE_B64` = `base64 -w0 ~/.matou-secrets/matou-upload.jks`
   - `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` (`matou-upload`),
     `ANDROID_KEY_PASSWORD`
   (`gh secret set` one-liners in `docs/SECRETS_CHECKLIST.md`.)
3. For local signed builds, `cp keystore.properties.example keystore.properties`
   in `frontend/src-capacitor/android/` and fill it in.

Export the upload certificate for Play Console if it asks for it:

```sh
keytool -export -rfc -keystore ~/.matou-secrets/matou-upload.jks \
  -alias matou-upload -file matou-upload-cert.pem
```

## 2. Build

Local:

```sh
export VITE_PROD_CONFIG_URL=http://config.matou.nz    # or leave unset: frontend/.env.production
MATOU_VERSION_CODE=4000 MATOU_VERSION_NAME=0.4.0 scripts/android/build-aab.sh
```

The script refuses `localhost`/private-network config-server URLs (a Play
build must only ever talk to production infrastructure) and warns if the
URL is plain `http://`.

CI: release through `scripts/release.sh`, which bumps `frontend/package.json`,
tags, and pushes to Forgejo and GitHub (GitHub is also a push-mirror).

```sh
cd frontend && npm run release -- 0.4.0
```

The tag runs `.github/workflows/build.yml` on GitHub: its `android` job builds
the signed `.aab` **and** a signed sideload `.apk`, verifies applicationId /
versionCode / versionName / signer, and the `release` job attaches both to the
draft GitHub release next to the desktop installers (spec:
`docs/plans/2026-08-31-github-release-builds-spec.md`). The workflow fails if
the tag does not match `package.json`'s version.

`versionName` = tag without `v`; `versionCode` = `MAJOR*1_000_000 + MINOR*1_000 + PATCH`
(`v0.4.0` → `4000`, `v1.2.3` → `1002003`) so codes are monotonic across
tags. A manual `workflow_dispatch` (GitHub `platform=android`, or Forgejo
`android.yml` with `release=true`) on a non-tag ref uses
`versionCode=<run number>` — fine for a smoke build, **do not upload those to
Play** (the code would collide with or jump ahead of the tag scheme).

## 3. Verify before uploading

```sh
AAB=frontend/dist/capacitor/android/bundle/release/app-release.aab
# signer + version
keytool -printcert -jarfile "$AAB" | grep -E 'Owner|SHA256'
unzip -p "$AAB" base/manifest/AndroidManifest.xml | strings | grep -E 'versionCode|versionName' || true
# install on the emulator/device exactly as Play would deliver it
bundletool build-apks --bundle="$AAB" --output=/tmp/matou.apks --connected-device \
  --ks ~/.matou-secrets/matou-upload.jks --ks-key-alias matou-upload
bundletool install-apks --apks=/tmp/matou.apks
```

(`bundletool` jar: https://github.com/google/bundletool/releases; `java -jar bundletool.jar …`.)

Then walk registration → approval → chat against prod infra on the device
before uploading.

## 4. Play Console (manual — one person with Release-manager access)

First release only:

- App exists as `nz.matou.app` (create it if the Console doesn't list it —
  the HRDAO app `nz.matou.hrdao` is a different app with a different key).
- **Setup → App signing**: accept Play App Signing; if it asks for an upload
  certificate, provide `matou-upload-cert.pem` from step 1.
- **Policy → App content**: privacy policy URL, data-safety form, child-safety
  standards (required because the app has chat), target audience (18+),
  ads (none). Answers that match what the app actually does:
  - Personal info collected: name, email, profile fields the member enters;
    messages. Purpose: app functionality. Shared: with other members of the
    member's own community only; not with third parties; not sold.
  - Encrypted in transit: yes. Deletion request path: contact address in the
    privacy policy.
  - The recovery phrase (mnemonic) stays on the device in
    `EncryptedSharedPreferences` (#71) and is never transmitted.
  - No analytics / crash SDKs, no advertising ID.
- **Store listing**: app name "Matou", short + full description, icon
  (512×512), feature graphic (1024×500), ≥ 2 phone screenshots (use the
  `pr-e2e` screenshot recipe against prod-like data, not test seed data).

Every release:

1. **Testing → Internal testing → Create new release**, upload the `.aab`.
2. Add release notes (from the tag annotation).
3. Add testers (email list) → Save → Review release → Start rollout.
4. Testers get the opt-in link; install from Play (not sideloaded) and
   re-run the device walkthrough.
5. Promote internal → closed → production from the Console when happy.

## Policy documents

Play needs public URLs for the privacy policy (and the child-safety
standards page). Host `docs/mobile/PRIVACY_POLICY.md`,
`TERMS_OF_USE.md` and `CHILD_SAFETY_STANDARDS.md` somewhere stable
(e.g. `https://matou.nz/privacy`, `/terms`, `/child-safety`) and keep the
in-app `PrivacyPolicyPage.vue` consistent with the hosted text when either
changes.

## Blockers / known issues

- #167 — `libgojni.so` not 16 KB page-aligned: Android 15 warns on launch and
  Play flags it; must be fixed before a production rollout (internal
  testing tolerates the warning).
- #202 — automatic upload to the internal track from CI (needs a Play
  service account; the *first* upload of an app must be manual regardless).
