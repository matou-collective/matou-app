# 08 — Push notifications for chat (Android / FCM, content-free)

**Status:** design — decisions below are proposals for review. They are a
two-way door: nothing here provisions infrastructure, distributes a secret, or
ships client code. Implementation lands in follow-up slices that each cite a
section of this document. (Issue #177, task 1.)

**What it answers:** how a chat message reaches an Android device that is
backgrounded, dozed, or fully killed — a state the current transport cannot
reach — without ever putting message plaintext through Google's Firebase Cloud
Messaging (FCM), and without standing up a central user database.

---

## 1. The gap today

Message delivery is any-sync P2P plus a local Server-Sent-Events fan-out:
`ChatHandler.HandleSendMessage` writes the message to the community space and
then calls `h.eventBroker.Broadcast(SSEEvent{Type: "chat:message:new", …})`
(`backend/internal/api/chat.go`). The SSE stream is served by the *embedded*
backend process running inside the app. `notifications.Service` fans the same
events to in-app toasts and email via its `Broadcaster` / `EmailSender`
adapters (`backend/internal/notifications/`).

Every one of those paths requires the embedded backend to be **alive and
connected**. When Android kills the process or Doze suspends its network, the
device is off the P2P mesh and the SSE socket is dead. Nothing wakes it until
the user reopens the app. FCM is the only channel Android will deliver to a
suspended app, so it is the wake signal we are missing — not a replacement for
P2P sync, just the doorbell that tells a sleeping app to reconnect and pull.

---

## 2. Hard constraints (from the issue, restated as invariants)

1. **Content-free payloads.** No message body, subject, sender display name, or
   channel name that could leak content or the social graph may travel through
   FCM. Google (and anyone who compromises the FCM project) sees only opaque
   wake signals. The human-readable notification text is composed **on the
   device** after it syncs the channel and decrypts locally.
2. **No central user directory.** We already avoid a server-side roster of who
   is who; the push design must not smuggle one in. The only new server-side
   state permitted is an `AID → device-token` map, which is push plumbing, not
   an identity registry.
3. **Doze-survivable.** Direct messages use **high-priority** FCM data messages
   (Android grants a brief network+wake window even in Doze). Channel traffic
   uses **normal** priority (batched, Doze-deferred) to stay within FCM quotas
   and avoid draining batteries on busy channels.

---

## 3. Decision 1 — who holds the FCM credential, and who sends the push

Three candidate topologies were on the table (issue body). The deciding factor
is **where the FCM server credential can safely live**.

| Option | FCM server key lives on… | Verdict |
| --- | --- | --- |
| A. Sender's device sends the FCM push directly | every member's device | **Rejected.** A shared FCM server credential on every phone is a catastrophic secret-distribution problem: one rooted/decompiled device can spam every member or forge wake signals. Violates §07 secrets doctrine (a secret is exposed the moment it lands where many parties can read it). |
| B. Token published into a profile object, device-to-device | n/a (no server), but token is community-readable | **Rejected for discovery.** Writing the token into `SharedProfile` (community-space, all-members-read — see `backend/internal/types/profiles.go`) hands every member every other member's live device token: a presence-tracking and push-spam surface. `PrivateProfile` is owner-only, so a *sender* cannot read it — it fails the "discoverable to senders" requirement outright. |
| **C. A tiny push-relay service holds the key; sender's backend calls it** | one hardened relay service | **Chosen.** The FCM server credential exists in exactly one place. The relay never sees plaintext (content-free payloads). It stores only the `AID → token` map. |

### Chosen topology (C), end to end

```
recipient app ──register(token, signed)──▶ embedded backend ──▶ push-relay ──▶ [AID→token map]
                                                                       │
sender app ── writes chat msg ─▶ embedded backend                     │
                    │  (already broadcasts SSE today)                  │
                    ├─ computes recipient AIDs from the space ACL      │
                    └─ POST /notify {aids:[…], channelId, kind} ──────▶ push-relay
                                                                       │  content-free
                                                                       ▼
                                                              FCM ─▶ recipient device
                                                                       │
                                                              wake embedded backend,
                                                              sync channel tree, decrypt,
                                                              post LOCAL notification
```

Why the **sender's** backend is the trigger, not the relay: only the sender's
node knows a write happened and can read the channel's membership from the
any-sync ACL to compute recipient AIDs. The relay stays dumb — it maps AIDs to
tokens and dispatches an opaque payload. It learns *that* someone in a channel
got a message, never *what*. To blunt even that metadata, `kind` is coarse
(`dm` | `channel`) and carries no channel name — only an opaque `channelId`
the recipient already knows how to resolve.

### The relay is new infrastructure with a new secret

The relay holds the FCM server credential and the `AID → token` map. That makes
it a secrets-bearing, internet-reachable service — it must be enrolled in the
secrets inventory (`docs/architecture/07-secrets-architecture.md`,
`docs/SECRETS_CHECKLIST.md`) and deployed alongside the KERI/any-sync infra,
**not** embedded in the app. Registration and `notify` calls to it are
authenticated with **KERI-signed requests** (the app already supports signed
auth — `MATOU_REQUIRE_SIGNED_AUTH`, `docs/signed-auth.md`) so the relay can
verify that a caller controls the AID it claims and reject forged wake-spam.

> **Open question for review (§9):** whether the relay is a standalone service
> or a capability folded into an existing infra node. Either is a two-way door;
> the interface below does not change.

---

## 4. Decision 2 — payload shape

FCM payloads are **data-only** (no `notification` block — a `notification`
block would let Android render body text FCM should never carry, and would
bypass our app-side handler while the app is backgrounded).

```jsonc
// DM — high priority so Doze grants a wake window
{ "priority": "high",
  "data": { "t": "m", "c": "<opaque-channelId>", "k": "dm", "v": "1" } }

// Channel message — normal priority, Doze-deferrable, quota-friendly
{ "priority": "normal",
  "data": { "t": "m", "c": "<opaque-channelId>", "k": "ch", "v": "1" } }
```

Field budget is deliberately tiny: `t` = payload type (`m` = new message), `c`
= opaque channel id the recipient already possesses, `k` = coarse kind, `v` =
schema version for forward-compat. **No** `title`, `body`, sender, count, or
channel name. On receipt the app:

1. Wakes the embedded backend just long enough to sync that one channel tree
   (§5).
2. Decrypts locally, composes the visible notification
   (`"New message in {channelName}"`, or a preview if the user opted in to
   previews) using the **notification channel + icon** registered in the
   Capacitor shell.
3. Recomputes and sets the **launcher unread badge** from local state.

If sync fails (offline, revoked access), the app falls back to a generic
content-free local notification (`"New messages"`) so the doorbell still rings.

---

## 5. Decision 3 — waking the embedded backend on receipt

A high-priority data message hands control to the app's background message
handler (`@capacitor/push-notifications` + a small Android
`FirebaseMessagingService`). The handler must:

- Start the embedded backend (`MatouBackend` Capacitor plugin — see
  `frontend/src-capacitor`, `docs/mobile/ANDROID.md`) if it is not running,
  with a **sync-only, time-boxed** lifecycle: connect, `SyncTree` the one
  channel named by `c`, emit the local notification, then release wake locks.
  It must not spin up the full UI stack or hold the CPU past the Doze window.
- Coalesce bursts: N messages in a channel within a short window produce one
  wake + one updated notification, not N wakes.

This is the piece most coupled to #168 (composer/nav) — only insofar as a
notification **tap** must deep-link correctly (§6).

---

## 6. Decision 4 — deep-link on tap

The issue assumes a `/chat/{channelId}` route. Today the router exposes a
single `{ path: 'chat', name: 'chat' }` page (`frontend/src/router/routes.ts`)
with no channel parameter. Two options, both two-way doors:

- **Now:** tap routes to `name: 'chat'` and passes the channel id via query
  (`/chat?c=<id>`); `ChatPage` selects that channel on mount. No router change.
- **Later (with #168):** promote to a real `chat/:channelId` param when the
  composer/nav rework lands.

The design targets the query-param form so #177 does not block on #168. Taps
that arrive before sync completes land on the channel and show the synced
message as it arrives over the same local pipeline used in the foreground.

---

## 7. Decision 5 — opt-out, permission timing, lifecycle

- **Permission is requested *after* onboarding completes**, never during
  (`frontend/src/composables/useOnboarding.ts` signals completion). A killed
  permission prompt mid-onboarding is a known drop-off; the doorbell is
  useless until there is an identity to receive for anyway.
- **Preferences live in the notifications store**
  (`frontend/src/stores/notifications.ts`, extended with a `push` preference
  block): a global push toggle, and per-channel mute. The sender's backend
  honours mutes it can see; the relay also drops pushes for AIDs flagged
  opted-out, so opt-out holds even for senders unaware of the preference.
- **Token lifecycle:**
  - register on permission grant and on every FCM token rotation;
  - **deregister on logout / identity switch** (a stale token would leak
    wakes to a device that no longer holds the AID);
  - relay prunes tokens that FCM reports as `NotRegistered`/`Unregistered`;
  - tokens carry a last-seen timestamp; the relay expires ones untouched past
    a TTL to bound the map.

---

## 8. Backend & frontend surface (implementation contract)

### Backend (`backend/`)

- **`POST /api/v1/push/register`** on the embedded backend (loopback-only under
  `LocalhostGuard`, `TokenGuard` on mutation as with every write). Body:
  `{ "token": "<fcm>", "platform": "android" }`. The AID comes from the
  authenticated session, not the body. The handler forwards the registration to
  the relay over a **KERI-signed** request; the frontend only ever talks to
  localhost. A matching **`POST /api/v1/push/deregister`** for logout.
- **`PushSender`** — a new adapter in `backend/internal/notifications/`
  mirroring `SSEBrokerAdapter`: it satisfies a `Broadcaster`-style interface so
  that the existing chat write-path fan-out (`ChatHandler` →
  `eventBroker.Broadcast` → `notifications.Service`) gains a third sink beside
  SSE and email. `PushSender.Broadcast` maps a `chat:message:new` event to a
  relay `notify` call: resolve channel members from the ACL → recipient AIDs
  (minus the sender, minus opted-out) → `POST /notify`. Non-chat notification
  types are ignored by this sink. Like the other adapters, a nil/unconfigured
  relay makes it a no-op so dev/test and the Electron build are unaffected.
- Wiring point: `backend/internal/app/app.go` (~L442, where
  `NewSSEBrokerAdapter` / `NewService` are constructed today) gains the push
  adapter when a relay URL is configured (new `MATOU_PUSH_RELAY_URL`, off by
  default → feature dark until provisioned).

### Frontend (`frontend/`)

- Add `@capacitor/push-notifications` to `frontend/src-capacitor`; Firebase
  project + `google-services.json` injected by CI as a secret (never
  committed — same doctrine as §07); notification channel + monochrome status
  icon in the Android shell.
- After onboarding: request permission → obtain token → `POST
  /api/v1/push/register`. On rotation, re-register. On logout, deregister.
- Background/quit message handler: wake backend, sync channel, local
  notification, badge (§5); tap → deep link (§6).
- All gated by the notifications-store `push` preferences (§7).

---

## 9. Testing & verification

Automatable in CI / sandbox:

- Go unit tests for `PushSender` (event → relay call mapping, sender excluded,
  opted-out excluded, nil-relay no-op) and the `/push/register` handler
  (auth/guard behaviour, forward payload).
- Frontend unit tests for the register/rotate/deregister lifecycle and the
  preference gating, with the Capacitor plugin mocked.

Requires a real device + provisioned Firebase (acceptance, added to
`docs/mobile/ANDROID.md`):

- App fully closed on a physical device; a DM from another member produces a
  notification within ~10 s; tapping opens the conversation with the message
  already synced.
- `adb logcat` / Firebase console inspection confirms **no message content** in
  any FCM payload.

---

## 10. Open questions for the reviewer

1. **Relay hosting** — standalone service vs. capability on an existing infra
   node (§3). Interface is identical either way.
2. **Preview opt-in** — default to content-free `"New message in {channel}"`,
   or offer an explicit opt-in to on-device decrypted previews (still never
   through FCM)? Recommend content-free default, preview opt-in.
3. **Channel-message priority under load** — normal priority may delay busy
   channels by minutes under Doze. Acceptable for channels (the issue asks for
   it); confirm product agrees DMs are the only "instant" tier.
4. **iOS** — out of scope for #177 (Android/FCM only), but topology C and the
   `PushSender` interface are transport-agnostic; an APNs sink slots into the
   same relay later.

---

## 11. Implementation slices (suggested follow-up issues)

1. Backend: `/push/register` + `/push/deregister` handlers, `PushSender`
   adapter, relay client, `app.go` wiring (dark behind `MATOU_PUSH_RELAY_URL`).
   Fully unit-testable — no device needed.
2. Relay service: `register` / `notify`, `AID → token` store, signed-auth
   verification, FCM dispatch; secrets-inventory entry.
3. Capacitor/Firebase: plugin, `google-services.json` CI secret, notification
   channel + icon.
4. Frontend: permission-after-onboarding, register/rotate/deregister,
   background handler + wake-to-sync, deep-link, badge, preference gating.
5. Docs + device acceptance recipe in `docs/mobile/ANDROID.md`.

Each slice is independently revertible and testable — this document is the
shared contract they build against.
