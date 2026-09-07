# Getting Mātou into the stores proper

What it takes to go from where we are — Play **open testing** (auto-published
on tags) and TestFlight (upload proven, open-beta automation in flight) — to a
public **Play production** listing and an **App Store** release. Researched
2026-09-04. Companion docs: `PLAY_STORE.md` (pipeline + Console mechanics),
`IOS.md` (build + signing), `store-listing/` (finished Play listing copy and
assets).

**TL;DR** — Android is close: Console paperwork plus one possible policy gate
(account type). iOS has four real blockers, one of which is a product gap:
no in-app account deletion.

---

## 1. Android → Play production

### 1.1 The one potentially decisive gate: account type

Personal Play Console accounts created **after 2023-11-13** must run a closed
test with **12 testers opted in continuously for 14 days** before they can
apply for production access (and since 2026 Google checks the testers
actually used the app). **Organization accounts are exempt**, as are personal
accounts created before that date.

→ Check Play Console → Settings → Developer account. If it's an organization
account, skip to 1.2. If it's a post-2023 personal account, the 14-day
closed-test clock is the long pole — start it before anything else
(the existing internal testers can seed the closed track).

### 1.2 App content declarations

All of these must be green in **Policy → App content** before the Console
offers *Send for review* (most were needed for open testing already — verify
rather than redo):

- [ ] Privacy policy URL — `https://matou.nz/privacy` (live, verified 2026-09-04;
      `/terms` also live)
- [ ] App access — the members-only declaration drafted in
      `PLAY_STORE.md` §Policy. See 1.3.
- [ ] Ads declaration (none)
- [ ] Content rating (IARC questionnaire)
- [ ] Target audience & content
- [ ] Data safety form — encrypted P2P sync, no analytics/tracking SDKs,
      device-held identity; the "data deletion" question can point at
      `DELETE /api/v1/identity` semantics (see 2.3 — the same story Apple
      forces us to build UI for)

The main store listing is done: `store-listing/LISTING.md` + graphics +
six framed screenshots, all length-checked by `store-listing/scripts/`.

### 1.3 Reviewer access (members-only app)

Open-testing review already accepted (or will accept) the "no reviewer
credentials" instruction text in `PLAY_STORE.md`. Production review reads the
same declaration, and Google is generally tolerant of it. The robust fix —
which Apple will likely force anyway (2.4) — is a **review-sandbox
community**: the config server's tenant mode (coa ADR 0005, live at
`coa-infra.matou.nz`) makes this cheap. A dedicated sandbox tenant + a build
or server-side flag pointing reviewers at it gives a full walkthrough without
touching the real community's encrypted space.

### 1.4 Promotion

Deliberately human, and stays that way: Console → Testing → Open testing →
release → **Promote to production**, staged rollout percentage of choice.
The auto-publish pipeline (`scripts/android/play-upload.sh`) keeps feeding
the open track; production promotions are picked from it when wanted.

---

## 2. iOS → App Store

In dependency order. Items 2.1 and 2.3 have lead time — start them first.

### 2.1 Convert the Apple account: Individual → Organization

The account (team `N6M9P5C7LU`) is **Individual** — the public App Store
seller name would be a person's name, not Mātou. Conversion is far easier
**before** the first App Store submission. Needs a **D-U-N-S number** for the
Mātou legal entity; the whole process takes days to weeks. TestFlight is not
blocked by this — only the public listing is.

### 2.2 Export compliance

The app ships KERI signing + any-sync encryption, so the one-click "no
encryption" answer would be untrue. Decide the classification (standard /
open-source published algorithms typically qualify for the mass-market /
exemption path, with a US BIS annual self-classification report), then bake
`ITSAppUsesNonExemptEncryption` (+ compliance code if applicable) into
Info.plist. This also unblocks TestFlight **external** testing — 
`scripts/ios/testflight-release.sh` deliberately stalls on missing
compliance.

### 2.3 In-app account deletion — product gap, hard requirement

Guideline 5.1.1(v) is strictly enforced: an app with account creation must
offer account **deletion in the app** — email/support flows are explicitly
not acceptable. The backend endpoint exists
(`backend/internal/api/identity.go` — `DELETE /api/v1/identity`) but
**no frontend surface calls it**. Needed before submission: a settings-screen
"Delete my identity / leave community" flow (confirmation + recovery-phrase
warning + what happens to already-shared community records). Design note:
device-held KERI identity means "deletion" = destroy local keys + remove
membership; the copy should say exactly that rather than promise erasure of
peer-replicated history.

### 2.4 Reviewer access — Apple is stricter than Google

Apple's guidance is blunt: login-gated features require a working **demo
account**, and the "we cannot provide credentials" argument frequently fails
at Apple even where Google accepts it. Plan on the review-sandbox community
(1.3) doing double duty, with a pre-provisioned reviewer identity documented
in the App Review notes. The in-flight TestFlight open beta goes through
**Beta App Review** first — treat it as the cheap dry run of exactly this
fight, and keep whatever notes text passes.

### 2.5 The listing

Everything Play already has, in Apple's shape:

- Name / subtitle / keywords / description — adapt `store-listing/LISTING.md`
- Privacy **nutrition labels** (App Store Connect questionnaire — same
  answers as Play's data safety form)
- Age rating questionnaire
- Screenshots: iPhone 6.9"/6.5" — the Play screenshots re-frame with the
  existing `store-listing/scripts/frame-screenshot.py` tooling. **Note:** the
  Xcode project targets iPhone *and* iPad (`TARGETED_DEVICE_FAMILY = "1,2"`
  in `project.pbxproj`), which drags in iPad 13" screenshots and
  iPad-layout review. Dropping to `"1"` (iPhone-only) is a one-line change
  that meaningfully shrinks the review surface — recommended for v1.

### 2.6 Submission — first one manual, then automate

The App Store Connect API cannot create the app-record/listing anyway, so do
the first submission by hand in the Console. After that, the
`testflight-release.sh` bash+openssl pattern extends naturally to
`appStoreVersions` submission if we ever want tag-triggered App Store
releases (probably not — production stays human on Android too).

---

## 3. Branded coa apps in the stores — don't

For the per-community apps built by `matou-collective/coa-builds`: Apple
guideline **4.2.6/4.3** requires template/white-label apps to be submitted
**under each client's own developer account** — the Mātou account cannot
publish `ngati-example`'s app. Google's repetitive-content policy is the
looser cousin of the same rule. Store presence for a community is therefore a
per-community commercial undertaking (their own Apple org account at $99/yr,
their own Play account with the 12-tester gate of 1.1), not a pipeline
feature. The GitHub-Release sideload distribution coa ships today is the
right default.

---

## 4. Suggested order

1. Check the Play account type (1.1) — it decides the Android critical path.
2. Land the TestFlight open beta (forces export compliance 2.2 and the first
   Apple-review contact 2.4).
3. In parallel: start the Individual→Organization conversion (2.1) and build
   the account-deletion UI (2.3).
4. Stand up the review-sandbox tenant (1.3/2.4).
5. Play production promotion, then App Store submission, land on prepared
   ground.

## Sources

- Play: [testing requirements for new personal accounts](https://support.google.com/googleplay/android-developer/answer/14151465),
  [12-testers community guide](https://support.google.com/googleplay/android-developer/community-guide/255621488/everything-about-the-12-testers-requirement)
- Apple: [App Review](https://developer.apple.com/distribute/app-review/),
  [5.1.1(v) account deletion](https://developer.apple.com/forums/thread/693997),
  [App Store Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
