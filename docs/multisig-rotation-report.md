# Multisig Rotation Bug Report

## Status: Blocked — Role upgrade modal disabled pending fix

The "Change Role" button on member profiles is disabled (`DashboardPage.vue:169`). The underlying role update API works, but the KERI multisig rotation that should follow a steward promotion does not complete, preventing the promoted user from gaining approval privileges.

---

## The Feature

When an admin promotes a Member to "Community Steward":

1. **Backend**: `PUT /api/v1/members/:aid/role` updates the CommunityProfile role
2. **Admin's KERI client**: Performs a 2-rotation sequence to add the new steward to the org multisig group AID
3. **Steward's KERI client**: Polls for `/multisig/rot` notifications via `useMultisigJoin`, joins the group
4. **Steward's dashboard**: `useAdminAccess.checkAdminStatus()` detects the steward role (via credential or group membership), shows the Approve button

## The Error

**Test 2 fails at line 912**: `Approve button should become visible after multisig join completes`

The failure chain:

1. Admin performs rotation 1 and rotation 2 — both POST to KERIA successfully, but the operations **never complete** (`done=false` after 30s polling each)
2. Since rotations never finalize on KERIA's side, no `/multisig/rot` notification is delivered to User1
3. User1's `useMultisigJoin` poller never finds a rotation notification — it only sees `/exn/ipex/grant` notifications (already read)
4. User1's `checkAdminStatus()` runs once on dashboard mount, finds 2 credentials (membership + endorsement grant), neither has a "steward" role → returns `false`
5. After role upgrade, `checkAdminStatus()` is never re-triggered because the watch depends on `hasJoinedMultisig`, which never fires
6. The Approve button never appears, test times out after 60s

### Key Diagnostic Output

```
[Admin] Group hab algo: group=true, salty=false, k=["DJNWSVlZ..."], s=3
[Admin] Rotation 1 op: name=group.ENt3sx78..., done=false
[Admin] Rotation 1 poll 1-10: done=false (30s total)
[Admin] Rotation 1 op not done after 30s polling — proceeding anyway
[Admin] Rotation 2: states2 count=2, rstates2 count=2
[Admin] Rotation 2 serder.ked k: ["DJNWSVlZ...","DLfLAZan..."], kt: 1   ← 2 keys! Correct!
[Admin] Rotation 2 op: name=group.EJiByAf9..., done=false
[Admin] Rotation 2 poll 1-10: done=false (30s total)

[User1] [AdminAccess] Checking credentials: 2
[User1] [AdminAccess] User is not an admin
[User1] [MultisigJoin] All notifications: 3  (all /exn/ipex/grant, all read)
  ← No /multisig/rot notification ever arrives
```

---

## What We've Tried

### 1. Fixed: `algo: undefined` → `algo: 'group'` in `createGroupAID()` (ROOT CAUSE)

**File**: `client.ts:766`

`createGroupAID()` was passing `algo: undefined` to `identifiers().create()`, which defaults to `Algos.salty` in signify-ts (`aiding.js:75`). This meant the org AID was created as a single-party "salty" identifier, not a group identifier. During rotation, `SaltyIdentifierManager.rotate()` generates new random keys and ignores the `states` parameter entirely, producing only 1 key instead of 2.

**Fix**: Changed to `algo: 'group' as never`. Confirmed rotation now produces 2 keys in `k` field. The `as never` cast is needed because signify-ts TypeScript types don't expose the `algo` option.

### 2. Fixed: Rotation operations block forever — changed to polling

**File**: `client.ts:870-900, 930-960`

`operations().wait()` blocks indefinitely for group rotation operations. KERIA treats `group.*` operations as multisig coordination events that need all participants to submit signatures. For a single-member group rotating to add a second member, there IS only one signer, but KERIA still holds the operation as pending.

**Fix**: Replaced blocking wait with polling loop (10 polls × 3s = 30s max), then proceed if POST was accepted. This allows the code to continue, but the rotation may not be finalized on KERIA's side.

### 3. Fixed: KERIA session expiration during long operations

**Files**: `client.ts` (new `ensureSession()` method), `useAdminAccess.ts:69`, `useMultisigJoin.ts:31`

Long-running test flows (5+ minutes) cause the KERIA session to expire. `useMultisigJoin` and `useAdminAccess` used `keriClient.getSignifyClient()` directly, bypassing the session management in `ensureConnected()`. Added `ensureSession()` calls before KERIA API calls.

### 4. Not fixed: Rotation operations never complete (`done=false`)

This is the core remaining issue. The rotation events are POSTed to KERIA successfully and the key event log (KEL) looks correct (2 keys, proper threshold), but KERIA never marks the operation as done. This means:
- No `/multisig/rot` notification is sent to the new member
- The new member can never `groups().join()` because there's nothing to join
- Even if we try `groups().join()` preemptively, it returns HTTP 500

---

## Options for Next Steps

### Option A: Fix the KERIA multisig coordination (Hard, Correct)

The rotation operations stay `done=false` because KERIA expects a full multisig coordination protocol, even for a 1→2 member expansion. Investigate:

1. **Does the admin need to also call `groups().join()` on its own rotation?** In standard KERI multisig, ALL members (including the initiator) must submit their signed event via the `/multisig/join` endpoint. The current code only has the admin call `identifiers().rotate()` but never `groups().join()`.

2. **Check KERIA logs** for what it expects after the rotation POST. The operation name `group.ENt3sx78...` suggests KERIA is waiting for coordination messages.

3. **Study keripy/KERIA source** for how `MultisigRotateRequest` is processed and what makes `group.*` operations transition to `done=true`.

4. **Look at signify-ts test suite** (`test/app/aiding.test.ts`) for examples of group rotation that work end-to-end.

**Pros**: Correct KERI protocol behavior, real multisig security
**Cons**: Complex, requires deep KERIA internals knowledge, may need KERIA patches

### Option B: Credential-based admin detection without multisig (Medium, Pragmatic)

Skip the multisig rotation entirely. After the admin upgrades User1's role:

1. Admin issues a new "Community Steward" ACDC credential to User1 (the backend role update already happens)
2. User1's `checkAdminStatus()` detects the steward credential via Method 1 (credential role field check)
3. No need for group AID membership — the credential itself grants approval rights

**Changes needed**:
- `ChangeRoleModal.handleConfirm()`: After role API succeeds, issue a steward credential to the member (similar to how membership credentials are issued during registration approval)
- `DashboardPage.vue`: After role change, re-trigger `checkAdminStatus()` on User1's side (currently only triggered once on mount)
- Remove or make optional the `addStewardToOrgMultisig()` call
- Define a "Community Steward" credential schema (or reuse membership schema with a role field)

**Pros**: Simpler, works within existing credential infrastructure
**Cons**: No actual multisig signing (the org AID remains single-signer), the "group" is cosmetic

### Option C: Backend-only role check (Easy, Least Secure)

Don't rely on KERI for admin detection at all. After role upgrade:

1. Backend already stores the role in CommunityProfile
2. Add an API endpoint `GET /api/v1/members/:aid/role` that returns the member's role
3. `checkAdminStatus()` Method 3: Call this endpoint and check if role includes "steward"
4. The Approve button visibility is based on the backend role, not KERI credentials or group membership

**Changes needed**:
- New backend endpoint (or extend existing member profile endpoint)
- Add Method 3 to `useAdminAccess.checkAdminStatus()`
- Re-trigger admin check after role change

**Pros**: Simple, reliable, no KERI complexity
**Cons**: Centralizes trust in the backend (defeats purpose of KERI), role can be spoofed if backend is compromised

### Option D: Hybrid — Backend role + deferred multisig (Recommended)

Combine Options B and C for immediate functionality with a path to full KERI security:

1. **Immediate**: Use backend role check (Option C) to enable the Approve button right after promotion
2. **Background**: Kick off the multisig rotation as fire-and-forget. When/if it completes, upgrade the admin detection to use group membership
3. **Future**: Once the KERIA coordination issue is resolved (Option A), make multisig the primary check and backend role the fallback

**Changes needed**:
- Add backend role to `checkAdminStatus()` as a new method (fast, reliable)
- Keep the multisig rotation code but don't gate the UI on it
- Re-trigger `checkAdminStatus()` after role change (watch the CommunityProfile role field, not just `hasJoinedMultisig`)

**Pros**: Works now, path to correct behavior, no user-facing regression
**Cons**: Temporary trust in backend role, two code paths to maintain

---

## Files Modified in This Branch

| File | Key Changes |
|------|-------------|
| `frontend/src/lib/keri/client.ts` | `algo: 'group'` fix, rotation polling, `ensureSession()`, `addMemberToGroup()` diagnostics |
| `frontend/src/composables/useAdminAccess.ts` | `ensureSession()` before credential queries, `canManageMembers` computed |
| `frontend/src/composables/useMultisigJoin.ts` | `ensureSession()` before polling |
| `frontend/src/components/dashboard/ChangeRoleModal.vue` | Role change modal with `addStewardToOrgMultisig()` call |
| `frontend/src/pages/DashboardPage.vue` | `canChangeRole` disabled (hardcoded `false`) |
| `frontend/tests/e2e/e2e-registration.spec.ts` | Test 2: role upgrade + multisig join + approval flow |

## Test Results

- **Test 1** (org setup + approve member): **PASSES** (5.3min)
- **Test 2** (role upgrade + steward approval): **FAILS** at Approve button assertion (multisig join never completes)
