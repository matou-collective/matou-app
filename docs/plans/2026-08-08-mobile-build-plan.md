# Mobile build plan

**Date:** 2026-08-08
**Status:** Draft
**Original design session:** 2026-05-19
**Branch:** `mobile-dev`

## Problem

Mātou App runs only on desktop today, as an Electron shell around a bundled Go backend. Community members carry phones, not laptops. Until identity, credentials, and kōrero work on a phone, the protocol reaches only the people who already sit at a desk.

This plan covers shipping Mātou App on Android and iOS. Both are v1 targets.

## Provenance of this document

The design work happened on 2026-05-19 and produced a phased plan with a four-axis audit across the frontend, backend, KERI, and any-sync. That session created the `mobile` branch but committed nothing — the plan survived only as working notes.

This document reconstructs that plan and re-verifies every technical claim against `main` as of 2026-08-08. Where the codebase has moved since May, the drift is recorded in [Corrections since the original plan](#corrections-since-the-original-plan). Treat this file as the plan of record and the `mobile` branch as abandoned.

## Constraints

- Space keys must never leave the device. This is the binding constraint and it rules out the simplest architecture.
- Every Go dependency must compile through gomobile, including the QUIC transport.
- iOS suspends background processes within roughly 30 seconds, which any long-lived sync goroutine must survive.
- The existing layouts are desktop-first and assume a wide viewport.

## Approach

Three decisions carry the design. Each is recorded below with the reasoning, because each has an obvious cheaper alternative that we rejected.

### Any-sync runs on-device

Any-sync must run on the phone, compiled into the app through gomobile. It cannot run as a remote service on the community's behalf.

The reason is key custody. The any-sync `SpaceKeySet` — signing, master, read, and metadata keys — derives from the person's mnemonic. Running sync remotely means shipping those keys to a server, which breaks the custody model the whole protocol rests on. Anytype's own mobile app embeds any-sync the same way, so this is a proven path rather than a novel one.

The split: `backend/internal/keri`, `anystore`, `trust`, and `identity` move on-device, along with a `core/` subset of `anysync/`. Transport and peer management stay on a remote node.

**Alternative considered — thin client with remote sync.** Much faster to build and it was tempting as a route to an internal beta. Rejected outright, including as temporary debt. Once keys reach a server during a beta, they are disclosed, and no later refactor undoes that.

### The whole backend ships, in-process

The Go backend runs in-process on the phone and serves its existing HTTP API on `http://127.0.0.1:8080`, exactly as it does under Electron today. iOS App Transport Security exempts loopback connections, so this needs no entitlement.

The alternative was exposing the API as gomobile-bridged functions. The backend currently registers 68 handlers across `backend/internal/api`, so that path means writing and maintaining 68 hand-written bridge functions on two platforms. Serving loopback HTTP instead means the frontend's entire `src/api` client layer works unchanged.

The gomobile entry point lives in `backend/cmd/mobile/` and stays deliberately small:

```go
func Initialize(dataDir, configJSON string) error  // starts the HTTP server
func Shutdown() error
func Pause() error   // iOS/Android lifecycle
func Resume() error
```

The trade-off is that every dependency in `go.mod` must survive gomobile compilation. When adding Go dependencies from here on, check for cgo and raw syscall use, which are the two things that break the mobile build.

### Device pairing is camera-to-screen

A person creates their identity on one device and pairs it to others by scanning a QR code and confirming a short PIN. Pairing always runs in one direction: the device showing the code is the source, the device scanning it is the receiver.

KERI key material cannot cross a network channel without leaking, so the trust anchor is physical — one screen, one camera, in the same room — with the PIN providing mutual confirmation.

The QR payload carries the mnemonic, AID, and space registry, encrypted under a PIN-derived key using Argon2id and ChaCha20-Poly1305. It is single-use with a 60-second TTL. Two endpoints support it:

| Endpoint | Called by |
|----------|-----------|
| `POST /api/v1/pairing/initiate` | Device displaying the code |
| `POST /api/v1/pairing/redeem` | Device scanning the code |

More state has to change hands than fits in a QR code, so pairing needs a server-mediated channel for the handoff. KERIA infrastructure is the likely host.

**KERI identity model.** Phase 1 uses a shared agent, where every paired device holds the same signing keys. Phase 2 moves to per-device subkeys with KERI rotation and revocation, so a lost phone can be revoked without rotating every device. The Phase 1 compromise must be stated plainly to community members: while it is in place, losing a paired device compromises all of them until a full rotation.

## Current state

Verified against `main` at 2026-08-08.

| Area | State | Implication |
|------|-------|-------------|
| Capacitor target | Stub present at `frontend/quasar.config.ts:102` | Shell scaffolding exists |
| Router mode | `hash`, set at `frontend/quasar.config.ts:40` | Correct for Capacitor, no change needed |
| KERIA | Already runs remotely | No mobile-specific work |
| Backend API | 68 handler registrations | All ship as-is over loopback |
| Platform detection | `isCordova()` checks `window.cordova` | Does not detect Capacitor — see corrections |
| Layouts | `DashboardLayout` sidebar, `ChatLayout` three-pane | Both need a mobile mode |
| Dialogs | 35 hardcoded `min-width` rules of 100px or more | Each needs a responsive override |
| `quic-go` | `v0.59.0`, indirect | Phase 0 spike target |
| `libsodium-wrappers-sumo` | Present transitively via `signify-ts` | Phase 0 spike target |

## Phases

### Phase 0 — Spikes

Four unknowns can each invalidate the architecture. Run them before committing to Phase 1.

1. Compile the full backend through gomobile, including `quic-go v0.59.0` on arm64.
2. Run the in-process HTTP server on iOS and reach it from the webview.
3. Load `libsodium-wrappers-sumo` WASM inside iOS WKWebView.
4. Measure iOS background suspension against a live any-sync connection.

If the first spike fails, the embedded architecture needs rework before any other work starts.

### Phase 1 — Mobile-capable backend, shell, and layout

Three streams run in parallel.

- **Backend:** gomobile entry point in `backend/cmd/mobile/`, lifecycle hooks, and a sync-on-foreground model with APNs wake to work around iOS suspension.
- **Shell:** Capacitor build for both platforms, plus real Capacitor detection in `frontend/src/lib/platform.ts`.
- **Frontend:** layout overhaul for `DashboardLayout`, `ChatLayout`, and the 35 fixed-width dialogs.

### Phase 2 — Rejected

A remote-backend MVP was considered and rejected. See [Any-sync runs on-device](#any-sync-runs-on-device). The phase number is retained so the rejection stays visible rather than looking like an omission.

### Phase 3 — Device pairing

QR pairing, the two pairing endpoints, and the server-mediated handoff channel.

## Timeline

Roughly 2.5 months to internal alpha and 5 to 6 months to public release, measured from the start of Phase 0.

## Corrections since the original plan

Three claims from the May session no longer hold or were wrong at the time. They matter because two of them hide work.

**Capacitor is not detected at all.** The original plan stated that `getBackendUrl()` returns the correct URL on Capacitor with no frontend changes. It does not. `frontend/src/lib/platform.ts:22` defines `isCordova()` as a check for `window.cordova`, and Capacitor does not set that global — it sets `window.Capacitor`. On a Capacitor build the function falls through to the browser branch and returns `VITE_BACKEND_URL` or `http://localhost:8080`. A Capacitor branch has to be added to `platform.ts` before the in-process backend is reachable. The comment on that function already mentions Capacitor, which is likely how the gap went unnoticed.

**The route count was 63, now 68.** Small, but it is the number that justifies serving loopback HTTP rather than bridging each route, so it is worth keeping accurate. The argument only strengthens as the count grows.

**`ChatLayout` is a component, not a layout.** It lives at `frontend/src/components/chat/ChatLayout.vue`. The `frontend/src/layouts/` directory holds only `DashboardLayout.vue` and `OnboardingLayout.vue`. This changes where the responsive work lands, and `OnboardingLayout` was missing from the original audit — welcoming a new member is the first thing that has to work on a phone.

## Open questions

- Which service hosts the pairing handoff channel, and what does it retain?
- Does sync-on-foreground keep spaces fresh enough to feel live, or is APNs wake required for Phase 1 rather than later?
- Does `OnboardingLayout` need a separate mobile design, or does the existing flow adapt?
