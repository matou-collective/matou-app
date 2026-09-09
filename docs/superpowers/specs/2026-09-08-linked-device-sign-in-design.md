# Linked-device sign-in (one identity on desktop and mobile) — Design

**Status:** approved design, 2026-09-08 — slices tracked on the umbrella issue.
**Date:** 2026-09-08
**Depends on:** #117 (identity.json at-rest encryption; slices #389–#392), the
existing "Recover identity" flow (`RecoveryScreen.vue`), the config server
(`matou-infrastructure/keri/config-server.py`).
**Background:** every Matou install is single-device today. The only way to
use the same identity on a second device is to type the 12-word recovery
phrase into "Already have an account? Recover identity". Nothing stops a
member from tapping "Join Now" on their phone after registering on the
laptop, which mints a **second AID** and a second any-sync account for the
same person — the split-identity problem.

## Goal

A member signs in on a second device by pointing their phone at a QR code on
the desktop. Whichever device already holds the identity hands it to the
other, after the member approves on the holding device. Afterwards both
devices are the same member: same AID, same KERIA agent, same any-sync
identity, same spaces, and profile edits made on either device converge.

## Decisions (settled during brainstorming)

1. **Same AID, same keys on both devices.** Not per-device AIDs, not a
   delegated device AID. Every ACL, credential, RBAC rule and the org
   multisig already key on the member AID and any-sync identity; nothing has
   to learn about identity groups.
2. **The pairing carries the mnemonic plus non-secret hints, then the
   receiving device runs the existing recovery path.** Nothing else is
   secret: the KERI passcode, the any-sync identity key and every space
   signing key are derived from the 12 words (`keri/client.ts
   passcodeFromMnemonic`, `anysync/peer.go DeriveKeyFromMnemonic`,
   `anysync/keys.go DeriveSpaceKeySet`). Space read keys are recovered from
   the ACL. Space IDs are deterministic from the key set
   (`DeriveSpaceIDWithKeys`).
3. **The QR carries only a pairing secret; the identity travels encrypted
   over the network.** Keys never appear in the QR image, the flow works in
   both directions and across networks.
4. **The rendezvous mailbox lives on the config server.** A fresh install
   has no AID and no any-sync account, so neither KERIA `exn` nor any-sync
   can be the channel. The config server is the one host every install
   already reaches before it has an identity.
5. **The QR is always on the desktop; the scanner is always on the phone.**
   Desktops rarely have a usable camera; phones always do.

## 1. User flows

### Entry points

| Device | Landing screen (`SplashScreen.vue`) | Signed in (`AccountSettingsPage.vue`) |
| --- | --- | --- |
| Desktop (Electron) | new button **"Sign in with your phone"** → QR screen | **"Link another device"** → QR screen |
| Mobile (Capacitor) | new button **"Sign in with your computer"** → scanner | **"Link another device"** → scanner |

The existing "I have an invite code", "Join Now" and "Recover identity"
entries stay. On mobile the new button sits above "Join Now" with copy that
says *"Already a member on your computer? Sign in here instead of joining
again."* — the cheapest possible defence against a second registration.

### Direction is decided after the scan

The phone's first message says whether it holds an identity (and which AID).
The desktop knows its own state. Exactly one side must hold an identity:

| Desktop | Phone | Outcome |
| --- | --- | --- |
| fresh | holder | phone → desktop. Phone approves, desktop receives. |
| holder | fresh | desktop → phone. Desktop approves, phone receives. |
| fresh | fresh | both show "Neither device has an identity yet. Create or recover one first." |
| holder (AID X) | holder (AID X) | both show "These devices are already linked." |
| holder (AID X) | holder (AID Y) | both refuse, showing both AIDs. **Linking never overwrites an existing identity.** The member must sign out on one device deliberately first. |

### Approval on the holder

Before the identity payload is sent, both screens show the same 6-digit
confirmation code (derived from the session key, §2). The holder screen
reads *"Sign in on ‹device name›? Only approve if the phone shows 482 913."*
and has **Approve** / **Cancel**. The fresh side shows the code and
*"Waiting for approval on your other device"*. This protects against
someone who photographs the desktop QR from across the room: they can start a
session, but the holder sees a device name and code they do not recognise.

### After receipt

The receiving side runs the existing recovery sequence, lifted out of
`RecoveryScreen.vue:199-262` into a composable shared by both screens:
validate mnemonic → `passcodeFromMnemonic` → `identityStore.connect` (this
connects to the **existing** KERIA agent; the Andrew-Weaver `boot()` guard
in `agentLifecycle.ts` classifies a fresh device as `'first'`, not
`'changed'`) → store `matou_passcode` / `matou_mnemonic` /
`matou_admin_aid` → `POST /api/v1/identity/set` with `mode: "link"` (§3.2)
→ `welcome-overlay` → dashboard. The receiving device is then
indistinguishable from a recovered one.

## 2. Pairing protocol

### Roles

- **Displayer** — the desktop. Creates the session, shows the QR.
- **Scanner** — the phone. Scans, joins the session.
- **Holder / Receiver** — whichever of the two has / lacks the identity.
  Decided from the scanner's hello (§1).

### QR payload

```
matou://pair?v=1&id=<pairId>&pk=<displayerEphPub>&s=<pairSecret>&cs=<configServerUrl>
```

| Field | Size | Meaning |
| --- | --- | --- |
| `v` | — | protocol version, `1` |
| `id` | 128-bit, base64url | pairing id; mailbox key; unguessable |
| `pk` | 32 bytes, base64url | displayer's ephemeral X25519 public key |
| `s` | 128-bit, base64url | pairing secret; **never sent to the mailbox** |
| `cs` | URL | config-server base the displayer is using (kit builds bake it, so this mostly guards dev/test against cross-environment scans) |

About 140 characters; renders at QR version 6–7, comfortably scannable.

### Key agreement

1. Scanner generates an ephemeral X25519 key pair.
2. Both sides compute `shared = X25519(ownEph, peerPub)`.
3. `K = HKDF-SHA256(ikm = shared, salt = pairSecret, info = "matou-pair-v1")`.
4. `code = decimal(HMAC-SHA256(K, "sas"))[0:6]` — the 6-digit code shown on
   both screens.

Because `pairSecret` is only ever in the QR image, a mailbox that swaps the
scanner's public key in transit computes a different `K` and every later
blob fails to decrypt. The mailbox is untrusted for confidentiality **and**
integrity.

### Mailbox (config server, `matou-infrastructure/keri/config-server.py`)

| Route | Semantics |
| --- | --- |
| `PUT /api/pair/{id}/{slot}` | store one blob (≤ 8 KB, `application/octet-stream`). `409` if the slot is already filled. Slots: `a` (scanner → displayer), `b` (displayer → scanner). |
| `GET /api/pair/{id}/{slot}?wait=25` | long-poll up to 25 s; returns the blob and **deletes it** (single read). `204` on a quiet timeout, `404` once the pairing's TTL has passed. |
| `DELETE /api/pair/{id}` | best-effort cleanup on cancel. |

- TTL 5 minutes from first write; in-memory only; no auth; per-IP rate
  limit (reuse `_check_issue_rate_limit`'s shape); CORS closed like the
  other mutating routes; tenant-prefixed like `/<slug>/api/*`.
- The server sees pairing ids, ciphertext and timing. Nothing else.

### Messages (all AES-256-GCM under `K`, nonce = 12 random bytes prefixed)

| # | Slot | From | Plaintext |
| --- | --- | --- | --- |
| 1 | `a` | scanner | `hello{ scannerEphPub (clear, outside the AEAD), role: holder\|fresh, aid?, deviceName, appVersion }` — the AEAD covers everything except `scannerEphPub`, which is needed to derive `K`; it is authenticated because a wrong key fails the tag. |
| 2 | `b` | displayer | `ack{ role: holder\|fresh, aid?, deviceName }` — lets the scanner show the same table outcome (§1) and the code. |
| 3 | `a` or `b` | holder | `identity{ mnemonic, aid, orgAid, adminAid?, configServerUrl }` — only after the holder's Approve. |
| 4 | the other | receiver | `done{ ok, error? }` — holder shows "Linked ✓" or the error. |

Each slot is reused across the session (the scanner writes `a` for
`hello` and again for `identity` or `done`); that is safe because every
write happens only after the previous message in the other slot has been
read, so the `409` on a filled slot only ever fires on a genuine race.
Replays are harmless: every slot is single-read, ids are single-use, and a
second `hello` after `ack` is rejected by the displayer's state machine.

### Where the code lives

The **Go backend owns the protocol** on both platforms:
`backend/internal/pairing/` (session state machine, X25519/HKDF/AES-GCM via
`crypto/ecdh`, `golang.org/x/crypto/hkdf`, `crypto/aes`; mailbox client)
exposed as:

| Endpoint | Who | Does |
| --- | --- | --- |
| `POST /api/v1/pairing/sessions` | displayer | new session; returns `{ sessionId, qrPayload, expiresAt }` |
| `POST /api/v1/pairing/scan` | scanner | body `{ qrPayload, deviceName }`; sends `hello`, waits for `ack`; returns `{ sessionId, outcome, code, peerDeviceName }` |
| `GET /api/v1/pairing/sessions/{id}` | both | `{ state, outcome, code, peerDeviceName, error }` (poll or SSE via the existing event broker) |
| `POST /api/v1/pairing/sessions/{id}/approve` | holder | the backend reads the mnemonic it already holds (`identity.json`) and sends `identity` |
| `POST /api/v1/pairing/sessions/{id}/cancel` | both | tear down |
| `GET /api/v1/pairing/sessions/{id}/identity` | receiver, once | `{ mnemonic, aid, orgAid, adminAid }` — returned exactly once, then wiped from memory; `409` if this backend already has an identity |

Rationale: on Capacitor the WebView cannot reach the plain-http config server
(`src/api/config.ts:108-128`, `keriproxy.go`), the backend already holds the
mnemonic once an identity is set, and one implementation beats one in Go and
one in TypeScript. The loopback API is already the trust boundary the
frontend crosses to hand the mnemonic to the backend (`identity/set`), so
handing it back the other way once is not a new exposure. The pairing routes
sit behind the existing TokenGuard/LocalhostGuard.

Session state is in memory only: never persisted, never logged (the pairing
package has a `String()` on every struct that redacts). A backend restart
cancels the session; the UI says so and offers a new QR.

### Frontend

- `src/composables/usePairing.ts` — thin client over the routes above.
- `src/components/onboarding/LinkDeviceQrScreen.vue` (desktop) — QR (rendered
  locally with `qrcode`, no network), state, code, Approve/Cancel.
- `src/components/onboarding/LinkDeviceScanScreen.vue` (mobile) — scanner,
  state, code, Approve/Cancel.
- Both are new `OnboardingScreen`s (`link-qr`, `link-scan`) on a new
  `OnboardingPath` `'link'`, and both are also reachable from Account
  Settings as a dialog.
- `src/composables/useRecoverIdentity.ts` — the sequence lifted from
  `RecoveryScreen.vue`, used by RecoveryScreen and by both link screens.
- Scanner: `@capacitor-mlkit/barcode-scanning`. Prefer its Google Code
  Scanner path on Android (`scan()`: Play-Services UI, no CAMERA permission,
  no bundled model) and fall back to the in-app `startScan()` (needs
  `android.permission.CAMERA`) on devices without Play Services; iOS needs
  `NSCameraUsageDescription`. Feature-detected off `window.Capacitor.Plugins`
  per the `src/lib/capacitor.ts` doctrine. A manual "paste the code" fallback
  accepts the `matou://pair?…` text for emulators, e2e, and dev.

## 3. Split-identity safeguards

Each of these is its own slice; the pairing UI is not safe to ship without
3.1 and 3.2.

### 3.1 Per-device any-sync peer key

Today `sdk_client.go:156-160` builds the account as
`accountdata.New(k, k)` with `k = DeriveKeyFromMnemonic(mnemonic, 0)`, so
the **peer key and the identity key are the same key** and two linked
devices would present the same peer ID to the coordinator and the nodes.
Fix: the identity (sign) key stays mnemonic-derived — ACL membership,
`bindFirstClaims` and every AID↔account mapping are unchanged — while the
peer key becomes a random per-install key persisted in `{dataDir}/peer.key`
(sealed by #392's key). `PeerKeyManager` grows a separate `identityKey`;
`GetPeerID()` reports the device key; `identity.json.peerId` becomes
informational. Migration: an existing install whose `peer.key` equals the
derived key mints a fresh device key on first start after upgrade.

**Peer-key verification (any-sync v0.11.9, module cache):**

- Two keys is the SDK's own model: `accountdata.New(peerKey, signKey)` and
  `NewRandom()` generate them independently
  (`commonspace/object/accountdata/accountdata.go:8-36`). PeerKey seeds the
  libp2p-TLS identity (`net/secureservice/secureservice.go:85`); SignKey is
  what every ACL record is signed with and what the handshake carries as
  `Identity` (`net/secureservice/credential.go:67-113`,
  `commonspace/object/acl/list/aclrecordbuilder.go`).
- The collision is real, not theoretical: `net/pool/pool.go:147-161`
  `AddPeer` **closes and replaces** an existing incoming connection with the
  same peer id, and `util/syncqueues/sync.go:42-58` keys per-peer sync
  queues and limits by peer id. Two devices on one PeerKey evict each other
  on every node they share.
- No device quota: `coordinatorproto.AccountLimits` has only
  `SharedSpacesLimit`; ACL membership is one entry per SignKey, so a second
  device is invisible to the ACL layer.
- Trap in matou-app: `users/{aid}/peer.key` (`PersistUserPeerKey`) is loaded
  by `spaces.go handleVerifyAccess` and passed to `GetPermissions` as the
  **ACL identity**. It must keep holding the mnemonic-derived sign key
  (rename to `sign.key`); only `accountdata.New`'s first argument and the
  TLS identity change. `bindFirstClaims` and the AID↔account map operate
  on `Account()` (sign key) and are unaffected. `contrib_adapter.go:57`'s
  `OwnerKey: GetPeerID()` is a dead field (never marshalled).

### 3.2 `mode: "link"` — recovery that never creates

`identity.go:186-243`: recovery mode tries `GetSpace` for 10 s and then
**creates** the private space. On a linked device that yields a local empty
space with the same deterministic ID and a second `PrivateProfile-{aid}`
tree; `deduplicateObjects` hides the symptom, not the fork. New
`req.Mode == "link"`: retry `GetSpace` with backoff for up to 60 s, and on
failure return `503 { retryable: true, reason: "private space not reachable" }`
instead of creating. The same rule applies to the community / read-only /
admin space adoption further down the handler. The UI shows *"Waiting for
your data to sync"* with a retry, never an empty app.

### 3.3 Refuse to overwrite

`GET …/pairing/sessions/{id}/identity` and the `scan` route return `409
identity-present { aid }` when this backend already has an identity and the
session outcome is not `already-linked`. The frontend never calls
`identity/set` from the link path when `identityStore.hasIdentity`. Sign-out
(`identityStore.disconnect`) remains the only way to change the identity on
a device, and its confirmation copy gains *"To use a different identity on
this device, sign out first. Your identity stays on your other devices."*

### 3.4 Hints travel with the identity

`matou_admin_aid` is a device-local hint (`stores/identity.ts:92-96`); on a
fresh device the AID pick falls back to "first non-org AID", which is wrong
for stewards whose agent also holds the group AID. The `identity` message
carries `adminAid` (when set) and `orgAid`; the receiver stores both before
`connect`.

### 3.5 KERIA notifications are claimed, not just read

Two signify clients on one agent both list the same notifications.
`useMultisigJoin.ts`, `useAdminActions.ts`, `useClaimIdentity.ts`,
`useCredentialPolling.ts`, `useRegistrationPolling.ts` act-then-mark today.
Change to **mark-then-act** with a re-read: mark read, re-list, and proceed
only if the notification is now read *and* the underlying operation is not
already done (multisig: the member's signature already in the escrow; IPEX:
credential already admitted). Idempotency on the operation, not on the
notification, is the invariant. Affects stewards and admins only; ordinary
members have no notification-driven writes after approval.

### 3.6 Read-key recovery is bounded and visible

Space read keys are random (`keys.go:101-106`) and a linked device gets them
from ACL state. Project history says that path is flaky
(`docs/anysync-matou-comparison.md`, #129, #462). `LoadOrCreateSpaceKeySet`
callers on the link path get a bounded retry with a clear
`space-access-pending` state surfaced by `GET /api/v1/spaces`, and the
welcome overlay's existing ×6 retry (`WelcomeOverlayScreen.vue:330-433`) is
extended to that state. Owner-side repair stays `backend/cmd/acl-repair`.

### What already works and needs no change

- **KERI key state.** signify-ts derives salty keys from the bran plus the
  `pidx/ridx/kidx` stored in the KERIA agent, and keeps no client-side
  keeper state. A rotation from device A is picked up by device B on its
  next `identifiers().get()`.
- **Profiles.** All three profile records are any-sync object trees
  (`ProfileTreeType`), so concurrent edits from two devices merge as CRDT
  changes. No new conflict handling.
- **Credentials.** Held by the agent (`docs/keria-per-agent-credential-isolation.md`);
  both devices share the agent.
- **Push.** `pushrelay/store.go` already maps one AID to many device tokens.

### Accepted limitation

With shared keys there is no per-device revocation. "Unlink this device" is
a local wipe (`disconnect`), not a rotation: a device that has the mnemonic
has the identity until the member rotates their AID **and** the any-sync
identity, which is not a supported operation today. This is stated in the
Account Settings copy and in `docs/mobile/PRIVACY_POLICY.md`.

## 4. Testing

- **Go unit** (`internal/pairing`): key agreement vectors, code derivation,
  state machine over every §1 outcome, wrong `pairSecret` → decrypt failure,
  replayed `hello`, expired session, `identity` returned exactly once,
  `409` on identity-present. Mailbox client against an `httptest` server.
- **Config server** (`matou-infrastructure`): PUT/GET/DELETE, single read,
  TTL, size cap, rate limit, tenant prefix.
- **Two-client e2e** on the existing `BackendManager`
  (`frontend/tests/e2e/utils/backend-manager.ts`, ports 9280+) and the
  `e2e-multi-backend.spec.ts` / `e2e-account-recovery.spec.ts` patterns:
  two backends with distinct data dirs, two Playwright contexts, one org.
  Feature specs: desktop-fresh/phone-holder, desktop-holder/phone-fresh,
  both-fresh, both-holder-different, and a profile edit on A visible on B.
  The "scanner" in e2e uses the paste fallback; the mailbox is the test
  config server the test network already runs.
- **Device acceptance** (ready-for-session): real Android phone against the
  desktop AppImage on a different network, both directions, plus a steward
  approving a registration from the phone while the desktop is online (3.5).

## 5. Sequencing

```
S1 peer key per device (3.1)            ─┐
S2 link-mode recovery (3.2, 3.6)         ├─ backend, independent, first
S3 mailbox on config server (infra)      ─┘
S4 backend pairing package + API (§2)    ← S3
S5 recover-identity composable + desktop QR screens + landing button   ← S4
S6 mobile scanner plugin + scan screen + landing button                ← S4
S7 Account Settings "Link another device" + refuse-overwrite copy (3.3, 3.4) ← S5, S6
S8 KERIA notification claiming (3.5)     — independent
S9 two-client e2e feature specs on BackendManager ← S5, S6
S10 device acceptance recipe (ready-for-session) ← all
```

## Out of scope (YAGNI)

- Per-device AIDs, delegation, or device revocation.
- Merging two already-distinct identities into one member.
- Transferring local-only state (drafts, read markers, notification prefs).
- Web (browser) builds as either side.
- Using the mailbox for anything but pairing.
