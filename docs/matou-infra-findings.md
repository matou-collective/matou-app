# Matou Infrastructure — Findings Summary

This document summarises the results of local failure testing across the KERI and AnySync stacks. It is intended for developers working on the Matou app and infrastructure. Full experiment-by-experiment detail is in `matou-infra-experiment-results.md`.

Testing was done locally using Docker Compose test environments. Cloud/mesh testing is pending.

---

## The two stacks and what they do

**KERI / KERIA** handles identity — login, key creation, credentials, member registration. The app talks directly to the KERIA agent on every page load.

**AnySync** handles document and content sync — messages, channels, files, spaces. It runs independently of KERI once a session is established.

These two stacks fail in very different ways.

---

## How each stack behaves under failure

### AnySync — resilient for existing users, fragile for new ones

AnySync is surprisingly robust for existing members. Losing one, two, or even all three sync nodes leaves users completely unaffected — the app works in offline mode, content is preserved locally, and everything catches up automatically when nodes come back. Users never see an error.

The fragile point is **new member onboarding**, specifically the space invite step at the very end of the join flow. This step depends on the coordinator, the consensus node, and MongoDB — and any one of them being down silently blocks it. The member gets stuck on "receiving space invite" with no error shown and no way to proceed. When the failed component comes back up, the stuck state does not auto-recover — the member remains frozen indefinitely.

The file node and MinIO (object storage) affect file attachments only. Text content is always unaffected.

Redis failure is the mildest of all — it blocks the final join step but recovers with a simple page reload.

### KERI / KERIA — hard lockout for everyone

KERIA failure is immediate and total. If the KERIA agent goes down, existing members cannot load the app at all — they get a connection error on page load. There is no offline fallback. AnySync continuing to run makes no difference.

Witnesses being down is milder — existing members are completely unaffected and can keep using the app normally. Only new identity operations (joining, key rotation, org creation) are blocked. When a new user tries to join with witnesses down, KERIA tries each witness in turn before giving up — but there is no UI feedback during this process, so the user just sees a loading spinner until it silently fails.

---

## Issues to fix in the Matou app

These are ordered roughly by severity.

### Critical — users are permanently stuck with no recovery path

**Space invite stuck state has no recovery.** When the coordinator, consensus node, or MongoDB is down during a new member join, the member gets frozen on "receiving space invite" after their membership is approved. When infrastructure recovers, nothing unblocks them. They need manual intervention — localStorage clear and mnemonic recovery — which a real user would not know to do. The app should detect this state and offer a retry or a clear message.

**RevokeAccess is not implemented.** `backend/internal/anysync/acl.go:346` is a stub that returns `nil`. Removing a member from the admin UI revokes their KERI credential but does nothing to their AnySync space access. They retain full read and write access to all channels and content indefinitely. This needs to be implemented before Matou is used with real members.

**Admin cannot remove a mid-join broken user.** If a user is stuck in a broken join state, the admin's remove action returns a 500 error. There is no way to clean up stuck registrations from the UI.

**Backend data wipe breaks mnemonic recovery.** If a user's backend data is deleted while their KERIA agent still exists, they cannot recover using their mnemonic — the private space ID derivation produces a different ID each time. Recovery requires a full KERIA infrastructure reset affecting all users.

### High — silent failures with no user feedback

**Nearly every failure mode is invisible to the user.** The app either hangs, shows a blank state, or appears to work while silently failing. Specific examples:

- AnySync fully down: users can post messages and create content, but nothing syncs to other users. Both sides think everything is fine.
- File upload failure: the message delivers but the image is simply absent with no indication it was ever there.
- Space invite failure: the member sees their membership was approved, then the UI freezes with a loading spinner and no error.
- Witnesses down: the new user fills out their profile form with no warning, submits, and the app hangs indefinitely.

The app needs visible error states for infrastructure failures, particularly around the join flow and file operations.

**Profile form accepts input when KERIA is unreachable.** Whether witnesses are down or the full KERI stack is gone, the join landing page and profile form both load and work normally. The user fills everything in and only discovers the failure after submitting. The app should check KERIA connectivity before letting the user start the form.

**`CredentialPolling 404` on mid-flow reload.** When a user reloads the page between admin actions during the join flow, notifications get orphaned and the polling loop errors with a 404. This appears consistently and suggests the credential polling is fragile around timing.

### Medium — app code bugs uncovered by the multisig POC

These were found via the automated 13-phase multisig test and will cause join flows to fail in ways that look like infrastructure problems but are actually app bugs:

- **`createGroupAID`** uses `toad: 0, wits: []` — this blocks adding members to an org later.
- **`addMemberToGroup`** is missing pre-rotation and key-state-sync steps.
- **`joinGroup`** uses the wrong group-level key index for signing.

### Medium — configuration and environment issues

**App uses production KERIA if `VITE_ENV=prod`.** If the `.env` file has `VITE_ENV=prod` with no `VITE_DEV_CONFIG_URL` set, the app sends KERI operations to `awa.matou.nz` instead of localhost. Any org set up in this state has production URLs baked into its config and requires a full reset. The dev environment should default to `VITE_ENV=dev` and validate that `VITE_DEV_CONFIG_URL` is set.

**Kaitiaki `myAid` resolves to org AID instead of personal AID.** The kaitiaki's identity store sets `myAid` to the org AID rather than their personal AID. Credential lookups filter by `myAid.prefix`, so membership credential lookups always return nothing. The kaitiaki cannot endorse applicants or approve registrations. Needs a fix in the `myAid` store logic.

**Claim fails with "network error" even when backend succeeds.** When the backend processes `/api/v1/identity/set`, the SDK restarts and drops the HTTP connection. The frontend receives a network error and shows "claim failed" even though the identity was set. The user tries to retry but the backend is already configured. The app should handle this specific failure gracefully — a reload is the correct response, not a retry.

---

## What held up well

- **AnySync sync resilience** — losing nodes, even all of them, does not break existing users. Auto-recovery is clean and requires no user action.
- **KERIA witness retry** — KERIA cycles through all witnesses before giving up rather than failing on the first one. Useful when only some witnesses are degraded.
- **Redis failure** — the mildest infrastructure failure, recovers with a page reload. No data loss.
- **MinIO for existing files** — a MinIO outage makes already-uploaded files temporarily unavailable but they recover automatically on restart. Only files uploaded during the outage are lost.
- **Most of the registration flow is resilient** — credentials, endorsement, and membership approval all work even with coordinator, consensus node, or MongoDB down. Only the very final space invite step fails.

---

## Priority order for fixes

1. Implement `RevokeAccess` in `backend/internal/anysync/acl.go`
2. Fix the space invite stuck state — detect it, offer retry, and auto-recover when infrastructure comes back
3. Add UI error states for infrastructure failures (join flow, file uploads, sync outage)
4. Guard the profile form — check KERIA connectivity before letting a new user start
5. Fix `myAid` store logic so kaitiaki gets their personal AID, not the org AID
6. Fix `createGroupAID`, `addMemberToGroup`, `joinGroup` bugs found in multisig POC
7. Fix admin remove for mid-join broken users
8. Handle the claim/network-error false failure gracefully

---

## What comes next

All experiments above were run locally. The plan is to repeat the key ones on cloud/mesh infrastructure to capture real-network differences — particularly around latency on recovery, behaviour with multiple geographic nodes, and whether any failure modes are amplified or softened at scale.

The combined failure experiments (both stacks degraded simultaneously) and data persistence experiments were not run in this round and are also deferred to the cloud phase.
