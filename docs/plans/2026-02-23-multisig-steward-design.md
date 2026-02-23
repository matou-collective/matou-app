# Add Stewards to Org AID Multisig on Role Change

**Date:** 2026-02-23
**Branch:** upgrade-members

## Problem

When the admin upgrades a member to Community Steward or Founding Member, the steward cannot issue credentials or see registration notifications because:

1. `useAdminAccess` only checks KERIA credentials — after a role update via the PUT endpoint, the KERIA credential still says "Member"
2. `useRegistrationPolling` only receives EXN notifications for the org AID — the steward's KERIA doesn't have the org AID
3. `approveRegistration()` uses the org AID's registry to issue credentials — only the admin's KERIA has the org AID
4. Registration data comes exclusively from KERIA EXN notifications to the org AID

## Solution

Perform a KERI group rotation on the org AID to add the promoted steward's personal AID as a signing participant. The org AID is already a group AID (created via `createGroupAID()` with `isith: '1'`). Adding the steward to the group gives them:

- The org AID in their KERIA identifiers list
- EXN notifications sent to the org AID (registration applications)
- Ability to issue credentials from the org AID using the shared registry
- Detection as a steward/admin via `useAdminAccess`

## Design

### Signing Threshold

Stays at `isith: '1'` — any single steward can sign independently. No multi-party coordination required for credential issuance.

### Two-Rotation Process (KERI Protocol Requirement)

Adding a member to a KERI group AID requires two rotations:

1. **Rotation 1:** Admin adds steward's key state to `rstates` (next rotation keys) but NOT `states`. This puts the steward's next-key digest into the group's `n` array.
2. **Rotation 2:** Admin promotes steward to `states` AND `rstates`. This puts the steward's signing key into the group's `k` array.

After both rotations, the admin sends a `/multisig/rot` EXN message to the steward.

### Steward Join (Async)

The steward's client polls for `/multisig/rot` notifications and calls `groups().join()` to complete the join. This happens in the background — the ChangeRoleModal finishes immediately after the admin completes the rotations.

### Credential Re-Issuance

After the role change, the admin re-issues a membership credential with the new role (e.g., "Community Steward"). This ensures `useAdminAccess` detects the steward via credential role checks.

### Flow

```
Admin: ChangeRoleModal → select "Community Steward" → confirm
  → PUT /api/v1/members/{aid}/role (updates CommunityProfile)
  → Resolve steward's OOBI and query key state
  → Rotation 1: add steward to rstates
  → Rotation 2: promote steward to states
  → Send /multisig/rot EXN to steward
  → Re-issue membership credential with new role
  → Done (modal closes)

Steward (async, background):
  → Poll for /multisig/rot notification
  → Call groups().join() with rotation event
  → Org AID now appears in identifiers().list()
  → Registration EXN notifications start arriving
  → useAdminAccess detects steward status
```

### Components

1. **`client.ts`** — `addMemberToGroup(groupName, memberAidPrefix)`: Two-rotation process + EXN notification
2. **`client.ts`** — `joinGroup(groupName, notification)`: Process `/multisig/rot` notification and join
3. **`useAdminActions.ts`** — `addStewardToOrgMultisig(stewardAid)`: Orchestrates from admin side
4. **`useMultisigJoin.ts`** (new) — Polls for `/multisig/rot` notifications, auto-joins, re-issues credential
5. **`ChangeRoleModal.vue`** — Triggers multisig rotation for steward roles after role update
6. **`useAdminAccess.ts`** — Additional check: is user's AID a member of the org group AID
7. **`useOrgSetup.ts`** — Remove `permissions` and `verificationStatus` from admin credential data (schema v2 cleanup)

### Roles That Trigger Multisig Addition

- Founding Member
- Community Steward

All other role changes only update the CommunityProfile and re-issue the credential (no multisig change).
