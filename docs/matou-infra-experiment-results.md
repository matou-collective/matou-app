# Matou Infrastructure — Experiment Results

Findings from structured failure testing across the KERI and AnySync stacks. Each experiment records what was tested, what happened, and what it means for members.

Results are captured for both local (Docker) and cloud/mesh environments. Run local first; repeat on cloud to capture real-network differences.


---

## How to read the status column

| Symbol | Meaning |
|--------|---------|
| ✅ | Works normally |
| ⚠️ | Degraded / partial |
| ❌ | Broken / unavailable |
| ❓ | Not yet tested |

---

## Baseline health (fill in before breaking anything)

| Metric | Local | Cloud |
|--------|-------|-------|
| Cold startup time (make up → all green) | ~2 min | |
| Multisig POC result (x/13 phases) | 13/13 ✅ | |
| AnySync health check result | Coordinator reachable ✅ | |
| App loads without errors | ✅ | |
| Document edit syncs without delay | ✅ (chat messages sync instantly) | |

---

## Phase 1 — AnySync in isolation

### Exp A1: One sync node down (`any-sync-node-2`)

**Hypothesis:** 2 of 3 nodes remain. Replication continues. App unaffected.

**Stop:** `docker compose -p matou-anysync stop any-sync-node-2`
**Restore:** `docker compose -p matou-anysync start any-sync-node-2`

| Observation | Local | Cloud |
|-------------|-------|-------|
| Health check flags missing node | ⚠️ Only coordinator shown in output | |
| Document editing works | ✅ | |
| Document sync between 2 users works | ✅ Chat messages visible to all users | |
| App shows any error to user | ❌ No errors shown | |
| Node catches up automatically after restart | ✅ | |
| Time for node to rejoin and catch up | < 1 min | |

**User experience during failure:**
> Local: Completely transparent — no errors, no degradation noticed by users.
> Cloud: ___

**Notes:**
> Health check output only shows coordinator reachable, not individual nodes — unclear whether this is expected output format or nodes are not being checked individually.

---

### Exp A2: Two sync nodes down (`any-sync-node-2` + `any-sync-node-3`)

**Hypothesis:** One node remains with a full copy. App should still sync but with reduced redundancy.

**Stop:** `docker compose -p matou-anysync stop any-sync-node-2 any-sync-node-3`
**Restore:** `docker compose -p matou-anysync start any-sync-node-2 any-sync-node-3`

| Observation | Local | Cloud |
|-------------|-------|-------|
| Health check output | ⚠️ Only coordinator shown | |
| Document editing works | ✅ | |
| Document sync between 2 users works | ✅ | |
| App shows any error to user | ❌ No errors shown | |
| Both nodes catch up after restart | ✅ | |
| Time for full recovery | < 1 min | |

**User experience during failure:**
> Local: Completely transparent — no errors, no degradation. Users unaware anything is wrong.
> Cloud: ___

**Notes:**
>

---

### Exp A3: All sync nodes down

**Hypothesis:** No remote sync possible. App works offline (local copy). Sync resumes automatically on restart.

**Stop:** `docker compose -p matou-anysync stop any-sync-node-1 any-sync-node-2 any-sync-node-3`
**Restore:** `docker compose -p matou-anysync start any-sync-node-1 any-sync-node-2 any-sync-node-3`

| Observation | Local | Cloud |
|-------------|-------|-------|
| App continues to work offline | ✅ Kaitiaki can still send messages | |
| User sees error or silent degradation | ❌ No errors shown to either user | |
| Edits made offline are preserved | ✅ Messages saved locally | |
| Sync resumes automatically after nodes restart | ✅ | |
| Offline edits sync correctly after recovery | ✅ Testuser saw all missed messages | |
| Time to full sync recovery | Immediate on node restart | |

**User experience during failure:**
> Local: Kaitiaki's messages appear to send normally. Testuser simply doesn't receive new messages — no error, no indication anything is wrong. On node recovery, testuser's view auto-updates with no action needed.
> Cloud: ___

**Notes:**
> From a user perspective this is the worst failure mode for discoverability — both users think everything is fine, but they are not seeing each other's updates.

---

### Exp A4: Coordinator down

**Hypothesis:** Existing sync continues unaffected. New spaces, new registrations, and ACL/membership changes are blocked.

**Stop:** `docker compose -p matou-anysync stop any-sync-coordinator`
**Restore:** `docker compose -p matou-anysync start any-sync-coordinator`

| Observation | Local | Cloud |
|-------------|-------|-------|
| Existing document editing works | ✅ | |
| Sync between already-connected users works | ✅ | |
| Creating a new space fails | ❌ — but new channels within existing space work ✅ | |
| New member registration — credential steps complete | ✅ Endorsement, attendance, membership all issued | |
| New member registration — space invite step | ❌ Hard 500 error, invite not created | |
| App surfaces a clear error for blocked actions | ❌ No UI error shown to user; console only | |
| Coordinator rejoins cleanly after restart | ✅ | |
| Stuck member auto-recovers after coordinator restart | ❌ Still stuck after reload | |
| Time until new-space creation works again | Immediate on restart | |

**User experience during failure:**

> **Existing users:** Messaging and channel creation within existing spaces completely unaffected. Invite generation, redemption, profile creation, identity creation, and registration approval all work.

> **New member registration flow (retested with fresh user):** Coordinator was turned off before the user started the join process. Admin received the registration, endorsed it, and marked onboarding attendance — all succeeded. Before admin approved, user2 was reloaded and showed two errors and a warning in the console:
> - `CredentialPolling: Failed to admin grant: Error: http put /notifications/... - 404 Not Found {msg: no notification to mark as read}`
>
> Admin then clicked approve. This triggered:
> - `POST http://localhost:4000/api/v1/spaces/community/invite 500 (Internal Server Error)`
> - Console warning: `[AdminActions] Space invitation failed: {"success": false, "error": "failed to create invite: adding invite record: unable to connect"}`
>
> Despite the invite failure, the membership credential was still issued.
>
> On user2's side, their console then showed:
> - `[CredentialPolling] Backend sync deferred: TimeoutError: signal timed out`
>
> After turning the coordinator back on and reloading both tabs: nothing changed. Admin side shows user2 as a member. User2 is still stuck on the "membership approved / receiving space invite" screen with no error shown and no way to proceed.

> Cloud: ___

**Notes:**
> **Key finding:** The coordinator is only required for the very final step of a new member join — routing them into the community space. Everything else in the join flow (credentials, endorsement, membership approval) works without it.
>
> **Hard failure vs. deferred:** The coordinator gives a hard 500 "unable to connect" at invite creation time (`failed to create invite: adding invite record: unable to connect`). This is different from the consensus node failure which produces a timeout/deferred. Both result in the same stuck state for the member — but the failure mode is distinct.
>
> **The `CredentialPolling 404` on user2 reload** is worth noting: the notification that the admin grant triggered couldn't be found when user2 reloaded mid-flow. This suggests the credential polling is fragile around timing — if the user reloads between admin actions, notifications get orphaned.
>
> **Critical UX bug:** When stuck on "receiving space invite", the app shows no error and no retry button. The user is permanently frozen. After coordinator restart, the screen does not auto-recover even after a full page reload — requires manual localStorage clear + mnemonic recovery, which a real user would not know to do.
>
> **Channels vs spaces:** A chat channel sits within an existing community space and does not require the coordinator. Only creation of a brand new top-level space is blocked.

---

### Exp A5: Consensus node down

**Hypothesis:** ACL changes (space permission changes, member removal) are blocked. Read and write of existing content may still work.

**Stop:** `docker compose -p matou-anysync stop any-sync-consensusnode`
**Restore:** `docker compose -p matou-anysync start any-sync-consensusnode`

| Observation | Local | Cloud |
|-------------|-------|-------|
| Document reading works | ✅ | |
| Document writing/editing works | ✅ | |
| ACL changes (e.g. remove member) fail | ⚠️ UI shows success but access not revoked | |
| New member registration — credential steps complete | ✅ Attendance, endorsement, membership all issued | |
| New member registration — space invite step | ❌ Times out, deferred, member stuck | |
| App surfaces a clear error | ❌ Silent failure (warning only in admin console) | |
| Recovery is automatic after node restart | ❌ Stuck member does not auto-recover | |

**User experience during failure:**

> **Existing users:** Messaging and all content features work normally. When kaitiaki removes a member, the UI shows success and the member disappears from the member list. However the removed user retains full read/write access — they can still see and post in all channels. Neither user sees any error.

> **New member registration flow:** The flow proceeds further than expected. Admin can receive the registration, record attendance (issues attendance credential), endorse (issues endorsement credential), and approve (issues membership credential) — all successfully. The failure only hits at the very last step: generating the community space invite. Admin console shows: `[AdminActions] Space Invitation deferred: TimeoutError: signal timed out`. The membership credential is still issued despite the timeout.
>
> On the new member's side: they see confirmation from admin ✅, attendance registered ✅, membership approved ✅ — but endorsement is not visible ❌, and they get permanently stuck on "receiving space invite" ❌. After the consensus node was turned back on, the stuck step did not auto-recover. The member remained stuck indefinitely.

> Cloud: ___

**Notes:**
> **Critical finding — RevokeAccess is not implemented.** The `RevokeAccess` function in `backend/internal/anysync/acl.go:346` is a stub that returns `nil` without doing anything. Member removal only revokes the KERI credential, not the AnySync space access. A removed member retains full access indefinitely regardless of infrastructure state.
>
> **Silent partial failure in registration:** Most of the registration flow completes even without the consensus node — credentials are issued, membership is approved. The failure is silent and late: only the space invite step fails, and neither admin nor member sees a clear error. The admin gets a console warning; the member gets a frozen UI with no explanation and no retry option.
>
> **Deferred space invite does not retry.** When the consensus node came back up, the stuck member was not unblocked. The "deferred" operation appears to be dropped rather than queued for retry. Open question: is the deferred invite stored somewhere that could be manually re-triggered, or is it lost?
>
> **Endorsement not visible on member side.** The endorsement credential was issued on the admin side but did not appear for the member during the outage. Unclear whether this is a sync delay or a permanent loss — needs further investigation after full recovery.
>
> **After consensus node restart:** Even with everything running, removed members retain access (RevokeAccess stub). The stuck registration member also does not auto-recover. Both are app code issues, not infrastructure issues.
>
> **AnySync design note:** Even if RevokeAccess were implemented, AnySync's design means a client with a local copy of a space retains access until their client reconnects and re-checks the ACL. Immediate eviction is not guaranteed by the protocol.

---

### Exp A6: File node down

**Hypothesis:** Text content unaffected. File uploads and downloads fail.

**Stop:** `docker compose -p matou-anysync stop any-sync-filenode`
**Restore:** `docker compose -p matou-anysync start any-sync-filenode`

| Observation | Local | Cloud |
|-------------|-------|-------|
| Text messages sent and received normally | ✅ | |
| File upload fails | ✅ ❌ (silently) | |
| Message delivered without the image | ✅ Text arrives, image missing | |
| App surfaces a clear error for file operations | ❌ Silent — console only | |
| Image recoverable after file node restarts | ❌ Never loads — file was never stored | |

**User experience during failure:**
> Local: Sending a message with an image attached produces no UI error. The message is delivered to the other user normally, but the image is simply absent — not broken, just missing. The sender has no indication anything went wrong. After the file node was turned back on, the image never appeared — it was never uploaded and does not exist anywhere.
> Cloud: ___

**Notes:**
> **Exact console errors on failed upload:**
> - `POST http://localhost:4000/api/v1/files/upload 500 (Internal Server Error)`
> - `[Attachment] failed to upload file: adding file to DAG: getting file peer: unable to connect`
>
> **File is permanently lost.** Unlike a message that gets queued and delivered later, a file that fails to upload is silently dropped. There is no retry — once the upload fails, the attachment is gone. The recipient sees the message without any indication an image was supposed to be there.
>
> **Stop command note:** Container may be named `any-sync-filenode-1` not `any-sync-filenode` — use `docker compose -p matou-anysync stop any-sync-filenode-1` if the former doesn't work.

---

### Exp A7: MongoDB down (coordinator loses its database)

**Hypothesis:** Coordinator stops functioning entirely. Sync nodes continue replicating between themselves. New spaces and memberships completely blocked.

**Stop:** `docker compose -p matou-anysync stop mongo-1`
**Restore:** `docker compose -p matou-anysync start mongo-1`

| Observation | Local | Cloud |
|-------------|-------|-------|
| Sync nodes continue replicating | ✅ | |
| Document editing works | ✅ | |
| New member registration — credential steps complete | ✅ Endorsement, attendance, membership all issued | |
| New member registration — space invite step | ❌ Deferred, TimeoutError | |
| App surfaces a clear error | ❌ Console warning only | |
| User stuck on "receiving space invite" | ✅ ❌ | |
| Errors shown on user page reload | ❌ None visible | |
| Auto-recovers after Mongo restart | ❌ Still stuck | |

**User experience during failure:**
> Local: On the user side, after admin endorsed and completed onboarding, the console showed `CredentialPolling: Failed to admin grant: 404` (notification not found). After admin clicked approve, the admin console showed `[AdminActions] Space invitation deferred: TimeoutError: signal timed out` — and the membership credential was issued anyway. The user sees their membership was approved but gets stuck on "receiving space invite" with no error shown in the UI. On a full page reload, no errors appear — just the stuck screen. Console shows `[CredentialPolling] Backend sync deferred: TimeoutError: signal timed out`. After turning Mongo back on and reloading both tabs, nothing resolved — user remains stuck.
> Cloud: ___

**Notes:**
> **Same end state as coordinator and consensus node failures.** All three produce the same stuck pattern: credentials issue, space invite fails silently, member frozen on the final step, no auto-recovery when the node comes back up. The failure signature differs slightly — MongoDB loss produces a timeout/deferred (like the consensus node) rather than the hard 500 the coordinator gives — but the member experience is identical.
>
> **The `CredentialPolling 404` appears consistently** across coordinator, consensus node, and MongoDB experiments whenever the user reloads mid-flow between admin actions. This is becoming a reliable indicator that a notification was orphaned.
>
> **MongoDB failure effectively equals coordinator failure** from the app's perspective, since the coordinator depends entirely on Mongo. The sync nodes appear to continue operating independently for existing content.

---

### Exp A8: Redis down (cache lost)

**Hypothesis:** Coordinator and file node lose their cache. Possible performance degradation or hard failures depending on how heavily Redis is relied upon.

**Stop:** `docker compose -p matou-anysync stop redis`
**Restore:** `docker compose -p matou-anysync start redis`

| Observation | Local | Cloud |
|-------------|-------|-------|
| Admin registration flow (endorse, onboard, approve) | ✅ No errors | |
| New member — space invite step | ✅ Passed (unlike coordinator/consensus/mongo failures) | |
| New member — community space join step | ❌ 500 error, stuck | |
| Recovery from stuck state | ✅ Page reload resolves it | |
| Member successfully in app after reload | ✅ | |
| App usable while stuck (before reload) | ❌ Dashboard loads but no data — no channels, no members, empty UI | |
| Refreshing fixes the empty dashboard | ❌ Does not resolve | |
| Any impact after turning Redis back on | ❌ Nothing noticeable | |

**User experience during failure:**
> Local: Admin side was completely unaffected — no errors during endorse, onboard, or approve. The new user got further than in previous experiments: they passed the space invite step and only got stuck at the final "community space" step. Console errors on the user side:
> - `POST http://localhost:4002/api/v1/spaces/community/join 500 (Internal Server Error)`
> - `[CredentialPolling] Backend sync deferred: TimeoutError: signal timed out`
>
> While stuck, the user could navigate to the app dashboard — but it was an empty shell. No channels, no members, no community data loaded. The UI appeared functional but had nothing in it. Refreshing does not resolve the empty state. A full page reload of the initial stuck screen resolved it — the user was fully joined with all data visible. Turning Redis back on produced no visible change.
> Cloud: ___

**Notes:**
> **This is the mildest failure so far.** Unlike coordinator, consensus node, and MongoDB failures which all permanently stuck the member on "receiving space invite" with no recovery path, Redis failure gets stuck one step later ("community space") and **recovers with a simple page reload**. No localStorage clear, no mnemonic recovery needed.
>
> **The failure point is different.** Space invite succeeded (the coordinator and consensus node handled it fine without Redis). Only the final `/spaces/community/join` call failed with a 500. Redis appears to be used as a cache for that specific join operation, and without it the call fails — but the underlying membership state was already established, so a reload picks up the real state correctly.
>
> **`GET /api/v1/org/config 404`** appears for non-admin users but is likely unrelated to Redis — observed consistently for non-admins regardless of infrastructure state.
>
> **Turning Redis back on had no visible effect** on the running session, which suggests the join call result wasn't cached anywhere waiting to be replayed — the state just needed a fresh load from the source.

---

### Exp A9: MinIO (object storage) down

**Hypothesis:** File uploads and downloads fail. Text sync unaffected.

**Stop:** `docker compose -p matou-anysync stop minio`
**Restore:** `docker compose -p matou-anysync start minio`

| Observation | Local | Cloud |
|-------------|-------|-------|
| Text document editing works | ✅ | |
| File upload while MinIO offline fails | ❌ silently dropped | |
| File uploaded while online — viewable while MinIO offline | ❌ temporarily unavailable | |
| File uploaded while online — viewable after MinIO restarts | ✅ recovers automatically | |
| Upload attempted while offline — viewable after MinIO restarts | ❌ never recovers, file is lost | |
| App surfaces a clear error | ❌ Console only | |

**User experience during failure:**
> Local: Text messaging works normally. Sending a message with an image while MinIO is down fails silently — no UI error, image is dropped. Console errors:
> - `POST http://localhost:4000/api/v1/files/upload 500 (Internal Server Error)`
> - `[Attachment] failed to upload file: adding file to DAG: pushing block ... RequestError: send request failed caused by: Put "http://minio:9000/matou-bucket/..." dial tcp: lookup minio on 127.0.0.11:53: no such host`
>
> Extra test: a user sent a message with an image while MinIO was online. A second user tried to view it while MinIO was offline — the image was unavailable. After MinIO was restored, the image appeared correctly for both users.
> Cloud: ___

**Notes:**
> **Two distinct failure modes depending on when MinIO goes down:**
> 1. **Upload while offline** → file silently dropped at the point of upload, permanently lost. No retry after MinIO comes back. Same end result as file node failure.
> 2. **View while offline** → file temporarily unavailable (it exists in MinIO, just unreachable). Recovers automatically when MinIO restarts — no user action needed.
>
> **Different error signature from file node failure.** File node failure reports `getting file peer: unable to connect` (can't find the AnySync peer). MinIO failure reports `pushing block... dial tcp: lookup minio: no such host` (DNS failure reaching the S3 bucket directly). Useful for diagnosing which component is down from logs alone.
>
> **The recoverable case is reassuring.** A MinIO outage on a running system doesn't permanently damage anything — it just makes files temporarily unviewable. Only files that people try to upload during the outage are lost.

---

### Exp A10: Full AnySync stack down and recovery

**Hypothesis:** App works offline. All data persists. Auto-recovers on restart with no user action needed.

**Stop:** `make anysync-down` from `matou-infrastructure/`
**Restore:** `make anysync-up`

| Observation | Local | Cloud |
|-------------|-------|-------|
| App works offline during outage | ✅ Users can use the app and create content | |
| Changes sync between users during outage | ❌ No cross-user sync while down | |
| Sync resumes automatically after restart | ✅ Users can see each other's changes | |
| User needs to take any action to recover | ❌ Auto-recovers | |

**User experience during failure:**
> Local: App remains usable throughout the outage — users can create content and navigate normally. There is no indication to the user that anything is wrong. They can post messages, create content, and everything appears to work. They simply won't see other users' updates, and other users won't see theirs — but neither side knows this. File uploads silently fail (same as the file node failure). After bringing the stack back up, everything syncs automatically with no user action needed.
> Cloud: ___

**Notes:**
> **No indication to users that anything is wrong.** This is the most dangerous aspect of a full AnySync outage — it's completely invisible. Users post into a void thinking they've been heard. The only hint something is off is that they stop seeing other people's activity, which they might attribute to the community being quiet rather than infrastructure being down.
>
> **Cleanest recovery of all experiments.** Once the stack is restored, sync catches up automatically. No stuck states, no lost data, no user action required. The outage window is the only damage.
>
> **Consistent with the individual node tests (A1–A3)** which showed the same pattern at smaller scale.

---

## Phase 2 — KERI in isolation

### Exp K1: Witnesses down, KERIA up

**Hypothesis:** Existing members retain access. New member joins, key rotations, and org creation fail because these require witness receipts.

**Stop:** `docker compose -p matou-keri stop witness-demo`
**Restore:** `docker compose -p matou-keri start witness-demo`

**Reference:** Run `make test-multisig-test` from `matou-infrastructure/keri/` to see exactly which of the 13 phases fail.

| Observation | Local | Cloud |
|-------------|-------|-------|
| Multisig POC phases that fail (list them) | | |
| Existing members can log in | | |
| Existing members can edit documents | | |
| New member registration fails | | |
| Key rotation fails | | |
| New org creation fails | | |
| App surfaces a clear error for blocked actions | | |
| All 13 POC phases pass after witnesses recover | | |

**User experience during failure:**
> Local: ___
> Cloud: ___

**Notes:**
>

---

### Exp K2: KERIA down, witnesses up

**Hypothesis:** Identity operations fail entirely. Document sync (AnySync) may still work for already-logged-in users.

**Stop:** `docker compose -p matou-keri stop keria`
**Restore:** `docker compose -p matou-keri start keria`

| Observation | Local | Cloud |
|-------------|-------|-------|
| Already-logged-in users can edit documents | | |
| Login fails for new sessions | | |
| Profile and identity views fail | | |
| Credential-related features fail | | |
| App surfaces a clear error vs. silent failure | | |
| Session auto-recovers after KERIA restarts | | |
| POC result after recovery (x/13) | | |

**User experience during failure:**
> Local: ___
> Cloud: ___

**Notes:**
>

---

### Exp K3: Full KERI stack down (KERIA + witnesses)

**Hypothesis:** All identity operations completely blocked. AnySync may still serve documents for established sessions.

**Stop:** `make keri-down` from `matou-infrastructure/`
**Restore:** `make keri-up`

| Observation | Local | Cloud |
|-------------|-------|-------|
| Existing sessions can still use documents | | |
| Login completely blocked | | |
| App error messaging | | |
| Full recovery without user action after restart | | |
| POC result after recovery (x/13) | | |

**User experience during failure:**
> Local: ___
> Cloud: ___

**Notes:**
>

---

## Phase 3 — Combined failures

### Exp C1: KERIA down + AnySync healthy

**Hypothesis:** Documents work, identity broken. Tests the independence of the two systems from a user's perspective.

| Observation | Local | Cloud |
|-------------|-------|-------|
| Document editing works | | |
| Document sync between users works | | |
| Login fails | | |
| Identity/profile features fail | | |
| App clearly distinguishes what works vs. what doesn't | | |

**User experience:**
> Local: ___
> Cloud: ___

**Notes:**
>

---

### Exp C2: AnySync down + KERI healthy

**Hypothesis:** Identity works, documents broken. Inverse of C1.

| Observation | Local | Cloud |
|-------------|-------|-------|
| Login works | | |
| Identity operations work | | |
| Document editing blocked | | |
| App works offline (local copy) | | |
| App clearly distinguishes what works vs. what doesn't | | |

**User experience:**
> Local: ___
> Cloud: ___

**Notes:**
>

---

### Exp C3: Coordinator down + witnesses down

**Hypothesis:** New members cannot join (neither new KERI identity nor new AnySync space). Existing members with established sessions unaffected.

| Observation | Local | Cloud |
|-------------|-------|-------|
| Existing members can edit and sync documents | | |
| New member registration completely blocked | | |
| New space creation blocked | | |
| App clearly communicates what's blocked | | |
| Full recovery after both restart | | |

**User experience:**
> Local: ___
> Cloud: ___

**Notes:**
>

---

### Exp C4: Partial AnySync (one node) + witnesses down

**Hypothesis:** Existing sync continues on remaining nodes; no new key events possible. Tests realistic degraded-but-running state.

| Observation | Local | Cloud |
|-------------|-------|-------|
| Document sync continues on remaining nodes | | |
| New member joins blocked | | |
| Key rotations blocked | | |
| Overall app usability for existing members | | |

**User experience:**
> Local: ___
> Cloud: ___

**Notes:**
>

---

### Exp C5: Full catastrophic failure — everything down, then staged recovery

**Goal:** Simulate a complete outage and observe whether staged restart order matters.

**Stop:** `make down` from `matou-infrastructure/`

**Staged recovery order to test:**
1. AnySync first, then KERI
2. KERI first, then AnySync
3. `make up` (unified command — should handle order automatically)

| Observation | AnySync-first | KERI-first | Unified `make up` |
|-------------|---------------|------------|-------------------|
| Any services fail on first start | | | |
| Services need manual retry | | | |
| Time to all-green health check | | | |
| POC result (x/13) | | | |
| App fully functional after recovery | | | |
| Any data lost | | | |

**Notes:**
>

---

## Phase 4 — Data persistence

### Exp D1: Data survives full stop/start (no wipe)

**Goal:** Confirm all member data persists across a clean restart. Most important check for production confidence.

**Steps:** Create test content → `make down` → `make up` → verify content intact

| Data type | Survived? (Local) | Survived? (Cloud) |
|-----------|-------------------|-------------------|
| Document content | | |
| Document edits | | |
| Member KERIA session (no re-login needed) | | |
| KERIA AIDs and credentials | | |
| AnySync spaces | | |
| File attachments | | |
| Org config | | |

**Notes:**
>

---

### Exp D2: Startup order correctness

**Goal:** Confirm `make up` handles dependency ordering correctly every time.

| Observation | Local | Cloud |
|-------------|-------|-------|
| Any services fail on first start | | |
| Services that need a retry | | |
| Time to all-green from cold | | |
| POC result (x/13) | | |
| Preferred manual startup order (if `make up` ever fails) | | |

**Notes:**
>

---

## Summary matrix

Fill in after all experiments are complete. Use ✅ ⚠️ ❌.

### AnySync failure impact on Matou user

| Component down | Doc editing | Doc sync | File upload | New space | New member |
|----------------|-------------|----------|-------------|-----------|------------|
| 1 sync node | | | | | |
| 2 sync nodes | | | | | |
| All sync nodes | | | | | |
| Coordinator | ✅ | ✅ | ✅ | ❌ blocked | ❌ space invite 500, member stuck, no auto-recovery |
| Consensus node | ✅ | ✅ | ✅ | ⚠️ blocked | ❌ stuck on space invite, no auto-recovery |
| File node | ✅ | ✅ | ❌ silently dropped, unrecoverable | ✅ | ✅ |
| MongoDB | ✅ | ✅ | ✅ | ❌ blocked | ❌ space invite deferred, member stuck, no auto-recovery |
| Redis | ✅ | ✅ | ✅ | ✅ | ⚠️ stuck on final join step, recovers with page reload |
| MinIO | ✅ | ✅ | ❌ if uploaded during outage (lost); ✅ if uploaded before (recovers) | ✅ | ✅ |
| Full AnySync | ✅ offline mode | ✅ auto-recovers | ❌ during outage only | ✅ | ✅ |

### KERI failure impact on Matou user

| Component down | Login | Doc editing | New member join | Key rotation | Credential ops |
|----------------|-------|-------------|-----------------|--------------|----------------|
| Witnesses | | | | | |
| KERIA | | | | | |
| Full KERI | | | | | |

### Combined failure impact

| Scenario | Doc editing | Login | New member | Recovery complexity |
|----------|-------------|-------|------------|---------------------|
| KERIA down, AnySync healthy | | | | |
| AnySync down, KERI healthy | | | | |
| Coordinator + witnesses down | | | | |
| Full catastrophic failure | | | | |

---

## Observations to carry forward to cloud phase

**Surprises from local experiments:**
>

**Things that worked better than expected:**
>

**Things that need fixing before cloud phase:**
>

**Differences observed between local and cloud behaviour:**
>

---

## Additional findings from session setup

These issues emerged during experiment setup rather than a specific experiment, but are worth recording.

| Finding | Severity | Details |
|---------|----------|---------|
| Claim fails with "network error" but backend succeeds | ⚠️ Medium | When the backend processes `/api/v1/identity/set`, the SDK restarts and drops the HTTP connection. The frontend gets a network error and shows "claim failed" even though the identity was set successfully. The user gets stuck retrying. Workaround: refresh after "claim failed" without clearing localStorage — the backend is already configured. |
| User with wiped backend data cannot recover | ❌ High | If a user's backend data directory is deleted while their KERIA agent still exists, they cannot recover via mnemonic. The private space ID derivation produces a different ID each time, causing a mismatch. The app loops on "claim failed" permanently. Recovery requires full KERIA infrastructure reset (wiping all users). |
| Admin cannot remove a mid-join broken user | ❌ High | If a user is stuck in a broken join state, the admin's "remove member" action returns a 500 Internal Server Error (`GET /credentials/pending` fails). The user cannot be removed from the UI. |
| App uses production KERIA if VITE_ENV=prod | ⚠️ Medium | The `.env` file had `VITE_ENV=prod` with no `VITE_DEV_CONFIG_URL` set. The app was resolving OOBIs and sending KERI operations to `awa.matou.nz` instead of localhost. Fixed by setting `VITE_ENV=dev` and adding `VITE_DEV_CONFIG_URL=http://localhost:3904`. Any org set up while pointing at production will have production KERIA URLs baked into the org config — requiring a full reset to fix. |
| SMTP notification 500 is non-critical | ℹ️ Low | Registration sends a notification via `/api/v1/notifications/registration-submitted`. This returns 500 when the SMTP server isn't running, but registration still succeeds — KERI credential application is sent independently. The 500 is noise. |
| Kaitiaki `myAid` resolves to org AID instead of personal AID | ❌ High | The kaitiaki's identity store sets `myAid` to the org AID (`EHR5P...`) instead of their personal AID (`EBOLx...`). Credential lookups filter by `sad.a.i === myAid.prefix` — since the membership credential was issued to the personal AID, the lookup always returns nothing. The kaitiaki cannot endorse applicants, approve registrations, or perform any action that requires their membership credential. Needs fix in the `myAid` store logic. |

---

## Known app code issues (not infrastructure)

These were uncovered by the multisig POC and may cause experiment failures that look like infrastructure problems but are actually app bugs:

| Flow | Issue | Impact on experiments |
|------|-------|-----------------------|
| New org creation (`createGroupAID`) | Uses `toad: 0, wits: []` — blocks adding members later | Exp K1, K3, C3 may surface this |
| Adding a member (`addMemberToGroup`) | Missing pre-rotation and key-state-sync steps | Exp K1, C3 new-member flows |
| Member joining org (`joinGroup`) | Wrong group-level key index for signing | Exp K1, C3 member join flows |

If these flows fail during experiments, check whether it's infrastructure or one of the above before concluding the infrastructure is broken.
