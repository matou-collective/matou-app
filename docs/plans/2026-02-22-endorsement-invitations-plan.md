# Endorsement Credential Invitations — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Change invitations to issue endorsement credentials instead of membership credentials, and merge the invite claim flow into the registration approval path.

**Architecture:** The admin invitation dialog issues an endorsement credential (not membership). After the invitee claims their code and verifies their mnemonic, they submit a registration application (apply EXN) like a normal registrant, then land on the pending approval screen. The pending approval screen detects the endorsement credential already in the wallet and marks that requirement as completed.

**Tech Stack:** Vue 3, Pinia, signify-ts (KERI), IPEX credential exchange

---

### Task 1: Update InviteMemberModal — replace role selector with reason textarea

**Files:**
- Modify: `frontend/src/components/dashboard/InviteMemberModal.vue`

**Step 1: Update the template**

Replace the subtitle, remove the role selector, and add a reason textarea. In the template:

```vue
<!-- Change subtitle (line 11) -->
<p class="text-sm text-muted-foreground">Create an invitation code and endorsement</p>

<!-- Replace the role <div> (lines 32-43) with: -->
<div>
  <label class="block text-sm font-medium mb-1.5">Reason for Endorsement</label>
  <textarea
    v-model="endorsementReason"
    class="w-full px-3 py-2.5 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none"
    placeholder="e.g. Active community contributor and governance participant"
    rows="3"
    :disabled="isSubmitting"
  />
</div>
```

**Step 2: Update the script**

Replace `role` ref with `endorsementReason` ref. Change `handleCreate` to pass `reason`. Update `handleCreateAnother` to reset `endorsementReason`. Update the disabled check on the create button to require both `inviteeName` and `endorsementReason`.

```ts
// Replace: const role = ref('Member');
const endorsementReason = ref('');

// In handleCreate():
async function handleCreate() {
  if (!inviteeName.value.trim() || !endorsementReason.value.trim()) return;
  await createInvite({
    inviteeName: inviteeName.value.trim(),
    reason: endorsementReason.value.trim(),
  });
}

// In handleCreateAnother():
// Replace: role.value = 'Member';
endorsementReason.value = '';

// Update create button :disabled
:disabled="!inviteeName.trim() || !endorsementReason.trim() || isSubmitting"
```

**Step 3: Verify the template compiles**

Run: `cd frontend && npx vue-tsc --noEmit --pretty 2>&1 | head -30`
Expected: No errors in InviteMemberModal.vue (usePreCreatedInvite type errors expected until Task 2)

**Step 4: Commit**

```bash
git add frontend/src/components/dashboard/InviteMemberModal.vue
git commit -m "feat(invite): replace role selector with endorsement reason textarea"
```

---

### Task 2: Update usePreCreatedInvite — issue endorsement credential

**Files:**
- Modify: `frontend/src/composables/usePreCreatedInvite.ts`

**Step 1: Update InviteConfig and schema constants**

```ts
// Replace InviteConfig (lines 13-16):
export interface InviteConfig {
  inviteeName: string;
  reason: string;
}

// Replace schema constants (lines 23-27):
const ENDORSEMENT_SCHEMA_SAID = 'EIefouRuIuoi9ZtnW3BOCSVeXQSt8k3uJLvmYHfvNPOE';
const SCHEMA_SERVER_URL = 'http://schema-server:7723';
const SCHEMA_OOBI_URL = `${SCHEMA_SERVER_URL}/oobi/${ENDORSEMENT_SCHEMA_SAID}`;
```

**Step 2: Update schema OOBI resolution (step 5)**

Replace `MEMBERSHIP_SCHEMA_SAID` with `ENDORSEMENT_SCHEMA_SAID` in the two `resolveOOBI` calls at lines 154 and 157-158.

**Step 3: Remove space invite key generation (step 5b)**

Delete lines 161-198 (the entire `// Step 5b: Generate space invite keys` block). Set `grantMessage` to empty string directly:

```ts
const grantMessage = '';
```

**Step 4: Replace credential data and issuance (step 6)**

Replace lines 226-251 (role/permissions logic + credentialData + issueCredential call):

```ts
      const credentialData = {
        endorsementType: 'community_endorsement',
        category: 'general',
        claim: config.reason,
        confidence: 'high',
      };

      const credResult = await adminClient.issueCredential(
        orgAidId,
        registryId,
        ENDORSEMENT_SCHEMA_SAID,
        inviteeAid.prefix,
        credentialData,
        grantMessage
      );
      console.log('[PreCreatedInvite] Endorsement credential issued and IPEX grant sent');
```

**Step 5: Remove member profile initialization (step 6c)**

Delete lines 276-286 (the `initMemberProfiles` call and surrounding try/catch).

**Step 6: Remove the `initMemberProfiles` import**

In line 11, remove `initMemberProfiles` from the import:

```ts
import { BACKEND_URL } from 'src/lib/api/client';
```

**Step 7: Verify compilation**

Run: `cd frontend && npx vue-tsc --noEmit --pretty 2>&1 | head -30`
Expected: Clean (InviteMemberModal now matches the new InviteConfig)

**Step 8: Commit**

```bash
git add frontend/src/composables/usePreCreatedInvite.ts
git commit -m "feat(invite): issue endorsement credential instead of membership"
```

---

### Task 3: Update useClaimIdentity — remove space join and community profile

**Files:**
- Modify: `frontend/src/composables/useClaimIdentity.ts`

**Step 1: Remove space invite extraction from grant processing**

Delete lines 148-154 (the `spaceInvite` variable declaration) and lines 196-205 (the space invite extraction block inside the grant loop). The grant admit loop should just admit grants without parsing messages.

**Step 2: Remove joinCommunitySpace call and error check**

Delete lines 293-307 (the `progress.value = 'Joining community space...'` block through `console.log('[ClaimIdentity] Joined community space')`).

**Step 3: Remove avatar upload after space join**

Delete lines 309-332 (the avatar upload block that depends on community space).

**Step 4: Remove SharedProfile creation**

Delete lines 360-389 (the `existingSharedId` and `sharedResult` block). Keep the PrivateProfile creation.

**Step 5: Update PrivateProfile credential SAID to be endorsement-aware**

The PrivateProfile stores `membershipCredentialSAID`. Since this is now an endorsement credential, rename the field or keep it generic. Keep the field name as-is (it will be overwritten when membership is later granted). Change the comment:

```ts
      // PrivateProfile in personal space
      // Note: credSAID here is the endorsement credential from invite;
      // it will be updated with the membership credential after registration approval.
      const privateResult = await retryProfile(() =>
        createOrUpdateProfile('PrivateProfile', {
          membershipCredentialSAID: credSAID,
          privacySettings: { allowEndorsements: true, allowDirectMessages: true },
          appPreferences: { mode: 'light', language: 'es' },
        }),
      );
```

**Step 6: Remove the `spaceInvite` error that throws when missing**

The old code at line 295-297 throws `'No community space invite found in credential grant'`. This is no longer relevant since endorsement grants don't contain space invites. This was already removed in step 2.

**Step 7: Verify compilation**

Run: `cd frontend && npx vue-tsc --noEmit --pretty 2>&1 | head -30`
Expected: Clean

**Step 8: Commit**

```bash
git add frontend/src/composables/useClaimIdentity.ts
git commit -m "feat(claim): remove space join and community profile from claim flow"
```

---

### Task 4: Update useOnboarding — route invite path to pending-approval

**Files:**
- Modify: `frontend/src/composables/useOnboarding.ts`

**Step 1: Change invite path forward map**

In `continueFlow()` (line 88-96), change the invite path mapping:

```ts
    if (path === 'invite') {
      const forwardMap: Partial<Record<OnboardingScreen, OnboardingScreen>> = {
        'invite-code': 'invitation-welcome',
        'invitation-welcome': 'profile-form',
        'profile-form': 'profile-confirmation',
        'profile-confirmation': 'mnemonic-verification',
        'mnemonic-verification': 'pending-approval',  // was: 'credential-issuance'
      };
```

**Step 2: Verify compilation**

Run: `cd frontend && npx vue-tsc --noEmit --pretty 2>&1 | head -30`
Expected: Clean

**Step 3: Commit**

```bash
git add frontend/src/composables/useOnboarding.ts
git commit -m "feat(onboarding): route invite path to pending-approval after mnemonic"
```

---

### Task 5: Update MnemonicVerificationScreen — submit registration for invite path

**Files:**
- Modify: `frontend/src/components/onboarding/MnemonicVerificationScreen.vue`

**Step 1: Expand the registration submission condition**

In `handleVerify()` (line 222), change the condition to also submit for the `invite` path:

```ts
    // Send registration for both 'register' and 'invite' paths
    // Invite path: invitee already has endorsement credential, now registers for membership
    if (store.onboardingPath === 'register' || store.onboardingPath === 'invite') {
```

The rest of the `submitRegistration()` call and error handling stays exactly the same.

**Step 2: Verify compilation**

Run: `cd frontend && npx vue-tsc --noEmit --pretty 2>&1 | head -30`
Expected: Clean

**Step 3: Commit**

```bash
git add frontend/src/components/onboarding/MnemonicVerificationScreen.vue
git commit -m "feat(onboarding): submit registration for invite path after mnemonic verification"
```

---

### Task 6: Update useCredentialPolling — expose endorsement detection

**Files:**
- Modify: `frontend/src/composables/useCredentialPolling.ts`

**Step 1: Add endorsement schema constant and state**

After line 10 (imports), add:

```ts
const ENDORSEMENT_SCHEMA_SAID = 'EIefouRuIuoi9ZtnW3BOCSVeXQSt8k3uJLvmYHfvNPOE';
```

Inside the composable function, after the `adminMessages` ref (line 63), add:

```ts
  // Endorsement credential state (pre-existing from invite claim)
  const endorsementReceived = ref(false);
```

**Step 2: Check for endorsement credential during polling**

In `pollForGrants()`, in the existing credentials check block (lines 226-241), after the membership credential detection, add endorsement detection:

```ts
      if (!credentialReceived.value) {
        try {
          const credentials = await client.credentials().list();
          console.log('[CredentialPolling] Existing credentials check:', credentials.length);
          if (credentials.length > 0) {
            // Check each credential's schema to categorize
            for (const cred of credentials) {
              const schema = cred.sad?.s || '';
              if (schema === ENDORSEMENT_SCHEMA_SAID && !endorsementReceived.value) {
                endorsementReceived.value = true;
                console.log('[CredentialPolling] Endorsement credential found in wallet:', cred.sad?.d);
              }
              // Membership credential detection (non-endorsement = membership for now)
              if (schema !== ENDORSEMENT_SCHEMA_SAID) {
                console.log('[CredentialPolling] Credential already in wallet:', cred);
                credential.value = cred;
                credentialReceived.value = true;
                grantReceived.value = true;
                syncCredentialToBackend();
              }
            }
          }
        } catch (credErr) {
          console.log('[CredentialPolling] Could not check credentials:', credErr);
        }
      }
```

Also add an endorsement-only check that runs even when `credentialReceived` is already true (to detect endorsements on subsequent polls):

```ts
      // Check for endorsement credential even if membership already received
      if (!endorsementReceived.value) {
        try {
          const credentials = await client.credentials().list();
          for (const cred of credentials) {
            const schema = cred.sad?.s || '';
            if (schema === ENDORSEMENT_SCHEMA_SAID) {
              endorsementReceived.value = true;
              console.log('[CredentialPolling] Endorsement credential detected:', cred.sad?.d);
              break;
            }
          }
        } catch { /* ignore */ }
      }
```

**Step 3: Expose endorsementReceived in return**

Add `endorsementReceived` to the return object (line 625-646):

```ts
  return {
    // State
    isPolling,
    error,
    grantReceived,
    credentialReceived,
    credential,
    endorsementReceived,  // <-- add this
    spaceInviteReceived,
    // ... rest unchanged
  };
```

**Step 4: Verify compilation**

Run: `cd frontend && npx vue-tsc --noEmit --pretty 2>&1 | head -30`
Expected: Clean

**Step 5: Commit**

```bash
git add frontend/src/composables/useCredentialPolling.ts
git commit -m "feat(polling): detect endorsement credential in wallet during polling"
```

---

### Task 7: Update PendingApprovalScreen — show endorsement as completed

**Files:**
- Modify: `frontend/src/components/onboarding/PendingApprovalScreen.vue`

**Step 1: Destructure endorsementReceived from polling composable**

In the composable destructuring (lines 391-406), add `endorsementReceived`:

```ts
const {
  isPolling,
  error: pollingError,
  grantReceived,
  credentialReceived,
  credential,
  endorsementReceived,  // <-- add this
  spaceInviteReceived,
  // ... rest unchanged
} = useCredentialPolling({ pollingInterval: 5000 });
```

**Step 2: Add endorsement status to the "What happens next?" section**

Before the step 1 card (line 121-133), add an endorsement status card that appears when endorsement is detected:

```vue
        <!-- Endorsement Status (shown when endorsement credential exists) -->
        <div
          v-if="endorsementReceived"
          v-motion="fadeSlideUp(250)"
          class="endorsement-card bg-accent/10 border border-accent/20 rounded-2xl p-5 mb-4"
        >
          <div class="flex items-start gap-3">
            <CheckCircle2 class="w-5 h-5 text-accent shrink-0 mt-0.5" />
            <div>
              <h4 class="font-medium text-foreground">Community Endorsement</h4>
              <p class="text-sm text-muted-foreground">
                You have a community endorsement credential in your wallet
              </p>
            </div>
          </div>
        </div>
```

**Step 3: Add CSS for the endorsement card**

In the `<style>` section, add:

```scss
.endorsement-card {
  background-color: rgba(74, 157, 156, 0.1);
  border-color: rgba(74, 157, 156, 0.2);
}
```

**Step 4: Verify compilation**

Run: `cd frontend && npx vue-tsc --noEmit --pretty 2>&1 | head -30`
Expected: Clean

**Step 5: Commit**

```bash
git add frontend/src/components/onboarding/PendingApprovalScreen.vue
git commit -m "feat(onboarding): show endorsement credential status on pending approval screen"
```

---

### Task 8: Verify full build and lint

**Step 1: Run type check**

Run: `cd frontend && npx vue-tsc --noEmit --pretty`
Expected: Clean (no errors)

**Step 2: Run lint**

Run: `cd frontend && npm run lint`
Expected: Clean or only pre-existing warnings

**Step 3: Run unit tests**

Run: `cd frontend && npm run test:script`
Expected: All pass

**Step 4: Final commit if any lint fixes needed**

```bash
git add -A
git commit -m "chore: lint fixes for endorsement invitation changes"
```
