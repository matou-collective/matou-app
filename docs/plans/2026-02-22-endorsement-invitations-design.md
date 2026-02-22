# Endorsement Credential Invitations

## Summary

Change the invitation flow to issue an endorsement credential instead of a membership credential. The invitation dialog adds a "reason for endorsement" field. After claiming the invite code and completing mnemonic verification, the invitee merges into the normal registration path (apply EXN + pending approval). The pending approval screen detects the endorsement credential as already completed.

## Context

Currently, invitations create a pre-configured KERIA agent, issue a membership credential, embed space invite keys in the IPEX grant, and generate an invite code. When the invitee claims the code, they auto-admit the credential, join community spaces, create profiles, and land on the dashboard.

The new flow separates endorsement from membership: invitations provide endorsement only, and membership is obtained through the standard registration approval process.

## Design

### 1. InviteMemberModal.vue (admin dialog)

- Title: "Invite Member" (unchanged)
- Subtitle: "Create an invitation code and endorsement"
- Remove: Role selector (Member/Contributor/Steward)
- Add: "Reason for endorsement" textarea (required, maps to `claim` field)
- Button: "Create Invitation" (unchanged)

### 2. usePreCreatedInvite.ts (invite creation)

- Switch schema: `MEMBERSHIP_SCHEMA_SAID` to `ENDORSEMENT_SCHEMA_SAID` (`EIefouRuIuoi9ZtnW3BOCSVeXQSt8k3uJLvmYHfvNPOE`)
- Credential data:
  ```ts
  {
    endorsementType: 'community_endorsement',
    category: 'general',
    claim: config.reason,
    confidence: 'high',
  }
  ```
- Remove: Space invite key generation (step 5b)
- Remove: Member profile initialization (step 6c)
- Remove: Role/permissions logic
- `InviteConfig`: replace `role?: string` with `reason: string`

### 3. useOnboarding.ts (navigation)

- Change invite path: `mnemonic-verification` maps to `pending-approval` (instead of `credential-issuance`)

### 4. MnemonicVerificationScreen.vue

- For the `invite` path, after mnemonic verification, submit registration (apply EXN to admins) the same way the `register` path does.

### 5. useClaimIdentity.ts (claim processing)

- Remove: Space invite extraction from grant message
- Remove: `joinCommunitySpace()` call
- Remove: Profile creation in community space (SharedProfile)
- Keep: IPEX admit (endorsement credential), key rotation, backend identity setup, private profile creation

### 6. PendingApprovalScreen.vue / useCredentialPolling.ts

- On mount, check if an endorsement credential already exists in the KERI wallet
- If found, display the endorsement requirement as completed/checked
- Continue polling for membership credential + space invite as normal

## Files

1. `frontend/src/components/dashboard/InviteMemberModal.vue`
2. `frontend/src/composables/usePreCreatedInvite.ts`
3. `frontend/src/composables/useOnboarding.ts`
4. `frontend/src/components/onboarding/MnemonicVerificationScreen.vue`
5. `frontend/src/composables/useClaimIdentity.ts`
6. `frontend/src/components/onboarding/PendingApprovalScreen.vue`
7. `frontend/src/composables/useCredentialPolling.ts`

## Unchanged

- Registration approval flow (`useAdminActions.ts`) still issues membership credentials
- `CredentialsTab.vue` wallet display already handles endorsement type
- Backend credential APIs unchanged
- Email sending flow unchanged
