# Play Store release guide (Android)

How a signed release App Bundle (`.aab`) of `nz.matou.app` is built and gets
onto the Google Play internal-testing track, and from there to open testing
(§5). Issue #176; auto-upload from CI is a follow-up (#202). For the toolchain and debug builds see
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
- **Policy → App content → App access**: declare *"All or some
  functionality is restricted"*. Matou is a members-only community: the
  Play binary is bound to the single production community published by
  `config.matou.nz/api/config`, and everything past onboarding lives in that
  community's encrypted any-sync space. Any account Google could log in with
  is therefore a real member of the real community — so **do not create a
  reviewer account by default**. Instead fill the form with instructions,
  no credentials:
  - What reviewers can reach unaided: splash → *Register* (profile form,
    recovery phrase, credential request) → *Pending approval* screen, plus
    *Recover* and *Have an invite code?* entry points. That is the entire
    public surface; membership is granted by community stewards and cannot
    be self-served.
  - State that the restricted area is a private Indigenous community's
    space (members' messages and records), that no demo/test community is
    available in this binary, and give the support address for questions.
  - If Google rejects with "unable to access" and insists on credentials,
    escalate here before complying. The only ways in both expose community
    data to the reviewer: (a) a pre-provisioned identity delivered as an
    invite code (claim flow — instant, no steward wait), or (b) approving
    a reviewer registration. If forced, do it time-boxed: name the member
    "Google Play Review", tell the community, and remove it from the
    space (and rotate) as soon as the review clears. The proper fix is a
    review sandbox community served by the config server for a dedicated
    invite code — file it as a ticket rather than improvising.
  - Internal testing normally isn't reviewed; this bites at closed →
    production promotion, so have the text ready before then.

  Ready-to-paste form text. The "other information" field is capped at
  500 characters (this is exactly 500 — re-count after any edit);
  username/password fields can't be blank, enter "N/A — see instructions".

  > **Instruction name:** Members-only community — no reviewer credentials
  >
  > **Other information:** Matou is a private, members-only app for the Matou community only. There is no password login or demo account: identity is a device-held key (12-word recovery phrase) and membership is granted by community stewards who verify each applicant. We cannot issue a reviewer account: every member joins the community's encrypted space of real members' messages and records. Reviewable: Join Now → profile → recovery phrase → "Pending approval" screen. Questions or supervised walkthrough: sysadmin@matou.nz

- **Store listing**: all text, the 512×512 icon, the 1024×500 feature graphic
  and the six framed phone screenshots are in `docs/mobile/store-listing/`
  (`LISTING.md` has the paste blocks, the shot-list and the capture recipe;
  `scripts/make-assets.py` regenerates the graphics). Upload
  `store-listing/screenshots/*.png` (`raw/` holds the unframed captures).

Every release:

1. **Testing → Internal testing → Create new release**, upload the `.aab`.
2. Add release notes (from the tag annotation).
3. Review release → **Start rollout to Internal testing**. The release must
   show *Available to internal testers*, not *Draft*, or the opt-in link
   reports the app as unavailable.
4. Testers are managed on the **Testers** tab (next to Releases), not on
   the release: *Create email list* → add Google addresses (≤ 100) → Save.
   Then under *How testers join your test* → **Copy link**. Play does not
   notify anyone; send the link yourself.
5. Each tester opens the link on a phone signed into the listed account →
   *Become a tester* → *Download it on Google Play*. The app is not in Play
   search; the link is the only way in. Allow a few minutes after adding an
   address. Install from Play (not sideloaded) and re-run the device
   walkthrough.
6. Promote internal → open/closed → production from the Console when happy.

## 5. Open testing

Internal testing is **not reviewed** by Google. Open testing is: the first
open-testing release goes through full app review, and the whole *App
content* section must be complete before the Console will let you send it.
Budget days, not minutes.

Open testing also means **anyone with the link can install, and the app
becomes discoverable on Play**. For a members-only app that is a deliberate
choice — non-members get as far as the *Pending approval* screen and no
further — but it is the thing that makes review scrutinise the app-access
declaration above. If public discoverability is not wanted, closed testing
(email list or Google Group, also reviewed) is the alternative.

Everything below must be green before the Console offers *Send for review*:

- [ ] **Store listing** — name, short + full description, 512×512 icon,
      1024×500 feature graphic, **≥ 2 phone screenshots**. All of it is in
      `docs/mobile/store-listing/` (`LISTING.md`).
- [ ] **App content** — privacy policy URL, app access, ads, content
      rating (IARC questionnaire), target audience & content, data safety,
      child-safety standards, plus the "does not apply" declarations
      (news, health, financial features, government).
- [ ] **Countries / regions** for the open-testing track.
- [ ] Store settings: category, contact details.

Then: **Testing → Open testing → Create new release** — either upload the
`.aab` or *Promote release* from the internal track (promoting reuses the
reviewed artefact and is the normal path) → release notes → *Review
release* → *Start rollout to Open testing* → *Send for review*.

Once live, the opt-in link is `https://play.google.com/apps/testing/nz.matou.app`
and needs no email list.

If review rejects on app access, do not improvise a reviewer account —
see the escalation note in §4.

## 6. Automated publishing (#202)

Once the first upload has been done by hand, a `v*` tag publishes on its
own — from **GitHub Actions**, not Forgejo: release AABs are built by
`.github/workflows/build.yml`'s `android` job (WP2 of the release-builds
spec; the tag mirrors from Forgejo to GitHub on commit), and that job ends
with a *Publish AAB to Play open testing* step running
`scripts/android/play-upload.sh`. Forgejo's `android.yml` `build-aab` is a
manual smoke build only and never publishes. Learned the hard way on
v0.6.0 — see the post-mortem in the actions-observability issue (#335).

The script talks to the Play Developer API v3 with nothing but bash,
openssl, curl and python3 — no marketplace action (they are fetched from
data.forgejo.org, which fast-fails intermittently) and no Ruby/fastlane. It
mints an RS256 JWT from the service-account key, trades it for an access
token, then `edits.insert` -> `bundles.upload` -> `tracks.patch` ->
`edits.commit`.

**Tag pushes only.** A `workflow_dispatch` build derives its versionCode
from the run number, which does not order against the tag scheme
(`vX.Y.Z` -> `X*1000000 + Y*1000 + Z`), so dispatch builds produce an
artefact and publish nothing.

### One-time provisioning

The old *Setup -> API access* page **no longer exists** in the Play
Console (checked 2026-09-02: "Setup" is now "Settings", and it has no API
section). Create the service account in Google Cloud and grant it in Play
Console as a user instead:

1. Google Cloud Console, project `matou-app` (already exists from the
   Firebase/FCM work) -> enable **Google Play Android Developer API**.
2. **IAM & Admin -> Service accounts** -> create `play-publisher` ->
   **Keys -> Add key -> JSON** -> download.
3. Play Console -> **Users and permissions -> Invite new users** -> paste
   `play-publisher@matou-app.iam.gserviceaccount.com` -> grant **Release
   manager**, scoped to `nz.matou.app` only.
4. Store the key JSON as the **GitHub** repo secret `PLAY_SERVICE_ACCOUNT_JSON`
   (`gh secret set PLAY_SERVICE_ACCOUNT_JSON < key.json`); the same value in
   Forgejo is only needed if a smoke publish is ever wired there.

Permission propagation is not instant — allow a few minutes before the
first run.

### Checking it before trusting it

```bash
export PLAY_SERVICE_ACCOUNT_JSON_FILE=~/.matou-android/secrets/matou-play-service-account.json

# Credentials + permissions only; seconds, no .aab needed.
scripts/android/play-upload.sh --no-bundle

# Full rehearsal: uploads the bundle, patches the track, validates, then
# discards the edit. Nothing is published and no versionCode is consumed.
scripts/android/play-upload.sh --dry-run
```

Both dry-run modes print the app's real track ids and store-listing
languages — set `PLAY_TRACK` and `PLAY_RELEASE_NOTES_LANG` from that output
rather than assuming (`beta` is Play's id for the *open* testing track, and
the listing language decides whether release notes must be `en-GB` or
`en-NZ`).

### Knobs

| Variable | Default | Meaning |
| --- | --- | --- |
| `PLAY_TRACK` | `beta` | `internal`, `alpha` (closed), `beta` (open), `production` |
| `PLAY_STATUS` | `completed` | `draft` lands it in the Console for a human to release |
| `PLAY_USER_FRACTION` | – | staged rollout, with `PLAY_STATUS=inProgress` |
| `PLAY_RELEASE_NOTES` | tag subject, else a generic line | capped at Play's 500 chars |
| `PLAY_RELEASE_NOTES_LANG` | `en-GB` | must be a language the listing has |
| `PLAY_PACKAGE_NAME` | `nz.matou.app` | |

The service account cannot create an app's **first** release, and it is
deliberately not granted anything beyond `nz.matou.app`. Promotion from
open testing to production stays a human decision in the Console.

## Policy documents

Play needs public URLs for the privacy policy (and the child-safety
standards page). Host `docs/mobile/PRIVACY_POLICY.md`,
`TERMS_OF_USE.md` and `CHILD_SAFETY_STANDARDS.md` somewhere stable
(e.g. `https://matou.nz/privacy`, `/terms`, `/child-safety`) and keep the
in-app `PrivacyPolicyPage.vue` consistent with the hosted text when either
changes.

## Blockers / known issues

- ~~#202 — automatic upload from CI~~ — implemented; see §6. Still needs
  the `PLAY_SERVICE_ACCOUNT_JSON` secret provisioned before a `v*` tag
  will publish (the job fails loudly if it is missing).
- ~~#167 — `libgojni.so` not 16 KB page-aligned~~ — fixed in #171;
  `build-aar.sh` links with `-Wl,-z,max-page-size=16384`. Re-check with
  `unzip -p "$AAB" base/lib/arm64-v8a/libgojni.so > /tmp/l.so && \
  llvm-readelf -l /tmp/l.so | grep LOAD` if the warning ever returns.
