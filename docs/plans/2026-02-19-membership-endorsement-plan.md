# Membership Endorsement Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow approved members to endorse pending applicants via KERI credentials, with admin still handling final admission.

**Architecture:** Frontend-driven KERI credential issuance. Each member gets a personal registry at admission time. Endorsements are issued as KERI credentials via IPEX grant, recorded in SharedProfile's `endorsements` array, and auto-admitted by the pending applicant's credential poller. Admin sees endorsements and can admit when ready.

**Tech Stack:** Vue 3 / Quasar (frontend), signify-ts (KERI client), Go (backend), any-sync (data sync)

---

### Task 1: Add endorsement schema and backend constants

Add the endorsement JSON schema file and update the Go backend with the endorsement schema SAID constant.

**Files:**
- Create: `backend/schemas/matou-endorsement-schema.json`
- Modify: `backend/internal/keri/client.go:24-42`

**Step 1: Create the endorsement schema file**

Create `backend/schemas/matou-endorsement-schema.json` with the full endorsement schema from the friend's fork. The `$id` is the schema SAID: `ENQU2Ty2QB1rU0DgYblcjKJnQmiF31_eUzBiwRKOi9EI`.

```json
{
    "$id": "ENQU2Ty2QB1rU0DgYblcjKJnQmiF31_eUzBiwRKOi9EI",
    "$schema": "http://json-schema.org/draft-07/schema#",
    "title": "MATOU Endorsement Credential",
    "description": "A credential representing an endorsement of a member's identity, skills, or qualifications",
    "type": "object",
    "credentialType": "MatouEndorsementCredential",
    "version": "1.0.0",
    "properties": {
        "v": { "description": "Version string", "type": "string" },
        "d": { "description": "Credential SAID", "type": "string" },
        "u": { "description": "One time use nonce", "type": "string" },
        "i": { "description": "Endorser AID (issuer)", "type": "string" },
        "ri": { "description": "Credential status registry", "type": "string" },
        "s": { "description": "Schema SAID", "type": "string" },
        "a": {
            "oneOf": [
                { "description": "Attributes block SAID", "type": "string" },
                {
                    "description": "Attributes block",
                    "type": "object",
                    "properties": {
                        "d": { "description": "Attributes block SAID", "type": "string" },
                        "i": { "description": "Endorsee AID (credential recipient)", "type": "string" },
                        "dt": { "description": "Issuance date-time", "type": "string", "format": "date-time" },
                        "endorsementType": {
                            "description": "Type of endorsement",
                            "type": "string",
                            "enum": ["identity_verification", "skill_endorsement", "role_competency", "character_reference", "membership_endorsement"]
                        },
                        "category": { "description": "Specific category", "type": "string" },
                        "claim": { "description": "The specific claim being endorsed", "type": "string" },
                        "evidence": { "description": "Optional evidence or context", "type": "string" },
                        "confidence": {
                            "description": "Confidence level",
                            "type": "string",
                            "enum": ["low", "medium", "high", "very_high"]
                        },
                        "relationship": { "description": "Endorser's relationship to endorsee", "type": "string" }
                    },
                    "additionalProperties": false,
                    "required": ["d", "i", "dt", "endorsementType", "claim", "confidence"]
                }
            ]
        },
        "e": {
            "description": "Edge section linking to the endorsee's membership credential",
            "oneOf": [
                { "description": "Edge block SAID", "type": "string" },
                {
                    "description": "Edge block",
                    "type": "object",
                    "properties": {
                        "d": { "description": "Edge block SAID", "type": "string" },
                        "membership": {
                            "description": "Reference to endorsee's membership credential",
                            "type": "object",
                            "properties": {
                                "n": { "description": "SAID of the membership credential being endorsed", "type": "string" },
                                "s": { "description": "Schema SAID of the membership credential", "type": "string" }
                            },
                            "required": ["n", "s"]
                        }
                    },
                    "additionalProperties": false,
                    "required": ["d", "membership"]
                }
            ]
        }
    },
    "additionalProperties": false,
    "required": ["v", "d", "i", "ri", "s", "a", "e"]
}
```

Note: We added `"membership_endorsement"` to the `endorsementType` enum (the friend's schema didn't have it).

**Step 2: Add endorsement constants to Go backend**

In `backend/internal/keri/client.go`, add endorsement-related constants after the existing `CredentialData` struct (around line 42). Add these constants at the package level:

```go
// Schema SAIDs
const (
	MembershipSchemaSAID  = "EOVL3N0K_tYc9U-HXg7r2jDPo4Gnq3ebCjDqbJzl6fsT"
	EndorsementSchemaSAID = "ENQU2Ty2QB1rU0DgYblcjKJnQmiF31_eUzBiwRKOi9EI"
)

// EndorsementData contains endorsement credential attributes
type EndorsementData struct {
	EndorsementType string `json:"endorsementType"`
	Category        string `json:"category"`
	Claim           string `json:"claim"`
	Confidence      string `json:"confidence"`
	Evidence        string `json:"evidence,omitempty"`
	Relationship    string `json:"relationship,omitempty"`
}
```

**Step 3: Run backend tests**

Run: `cd backend && make test`
Expected: All tests pass (no existing tests for these constants yet)

**Step 4: Commit**

```bash
git add backend/schemas/matou-endorsement-schema.json backend/internal/keri/client.go
git commit -m "feat: add endorsement schema and backend constants"
```

---

### Task 2: Create `useEndorsements` composable

Create the frontend composable that handles endorsement credential issuance. This follows the same pattern as `useAdminActions.approveRegistration()` but is simpler — it only issues the endorsement credential and updates the SharedProfile.

**Files:**
- Create: `frontend/src/composables/useEndorsements.ts`

**Reference files (read these first):**
- `frontend/src/composables/useAdminActions.ts` — pattern to follow for KERI operations
- `frontend/src/lib/keri/client.ts:833-898` — `issueCredential()` function signature
- `frontend/src/lib/keri/client.ts:794-821` — `createRegistry()` function signature
- `frontend/src/lib/api/client.ts:333-365` — `createOrUpdateProfile()` function

**Step 1: Create the composable**

Create `frontend/src/composables/useEndorsements.ts`:

```typescript
/**
 * Composable for endorsing pending member applications.
 * Approved members can issue endorsement credentials to pending applicants.
 */
import { ref } from 'vue';
import { useKERIClient } from 'src/lib/keri/client';
import { useIdentityStore } from 'stores/identity';
import { useProfilesStore } from 'stores/profiles';
import { createOrUpdateProfile } from 'src/lib/api/client';

// Endorsement credential schema SAID (from matou-endorsement-schema.json)
const ENDORSEMENT_SCHEMA_SAID = 'ENQU2Ty2QB1rU0DgYblcjKJnQmiF31_eUzBiwRKOi9EI';

export interface EndorsementRecord {
  endorserAid: string;
  endorserName: string;
  credentialSaid: string;
  endorsedAt: string;
  message?: string;
}

export function useEndorsements() {
  const keriClient = useKERIClient();
  const identityStore = useIdentityStore();
  const profilesStore = useProfilesStore();

  const isEndorsing = ref(false);
  const error = ref<string | null>(null);

  /**
   * Get the current member's personal registry ID from their CommunityProfile.
   * Returns null if not found (member may not have a registry yet).
   */
  function getPersonalRegistryId(): string | null {
    const myAid = identityStore.currentAID?.prefix;
    if (!myAid) return null;

    const myProfile = profilesStore.communityReadOnlyProfiles.find(p => {
      const data = (p.data as Record<string, unknown>) || {};
      return data.userAID === myAid || (p.id as string)?.includes(myAid);
    });

    if (!myProfile) return null;
    const data = (myProfile.data as Record<string, unknown>) || {};
    return (data.personalRegistryId as string) || null;
  }

  /**
   * Endorse a pending applicant by issuing an endorsement credential.
   *
   * @param applicantAid - AID of the pending applicant
   * @param applicantOOBI - OOBI URL for the applicant (optional, will construct fallback)
   * @param message - Optional endorsement message
   * @returns true on success, false on failure
   */
  async function endorseApplicant(
    applicantAid: string,
    applicantOOBI?: string,
    message?: string,
  ): Promise<boolean> {
    if (isEndorsing.value) {
      console.warn('[Endorsements] Already processing an endorsement');
      return false;
    }

    isEndorsing.value = true;
    error.value = null;

    try {
      const client = keriClient.getSignifyClient();
      if (!client) throw new Error('Not connected to KERIA');

      const myAid = identityStore.currentAID;
      if (!myAid) throw new Error('No identity found');

      // 1. Get endorser's personal registry
      const registryId = getPersonalRegistryId();
      if (!registryId) {
        throw new Error('No personal registry found. You may need to be re-admitted to get a registry.');
      }

      // 2. Resolve applicant OOBI
      let oobi = applicantOOBI;
      if (!oobi) {
        const cesrUrl = keriClient.getCesrUrl();
        if (cesrUrl) {
          oobi = `${cesrUrl}/oobi/${applicantAid}`;
        } else {
          throw new Error('Cannot resolve applicant identity: no OOBI available');
        }
      }

      const resolved = await keriClient.resolveOOBI(oobi, undefined, 30000);
      if (!resolved) {
        throw new Error('Could not resolve applicant identity');
      }
      console.log('[Endorsements] Resolved applicant OOBI');

      // 3. Issue endorsement credential
      const credentialData = {
        dt: new Date().toISOString(),
        endorsementType: 'membership_endorsement',
        category: 'membership',
        claim: message || 'I endorse this person\'s membership application',
        confidence: 'high',
      };

      console.log('[Endorsements] Issuing endorsement credential to:', applicantAid);
      const credResult = await keriClient.issueCredential(
        myAid.prefix,
        registryId,
        ENDORSEMENT_SCHEMA_SAID,
        applicantAid,
        credentialData,
      );
      console.log('[Endorsements] Endorsement credential issued:', credResult.said);

      // 4. Update SharedProfile with endorsement record
      const endorsement: EndorsementRecord = {
        endorserAid: myAid.prefix,
        endorserName: myAid.name || 'Unknown',
        credentialSaid: credResult.said,
        endorsedAt: new Date().toISOString(),
        message: message || undefined,
      };

      const profileId = `SharedProfile-${applicantAid}`;
      // Read current endorsements from the profile
      const currentProfile = profilesStore.communityProfiles.find(p => {
        const data = (p.data as Record<string, unknown>) || {};
        return data.aid === applicantAid || (p.id as string)?.includes(applicantAid);
      });
      const currentData = (currentProfile?.data as Record<string, unknown>) || {};
      const existingEndorsements = (currentData.endorsements as EndorsementRecord[]) || [];

      await createOrUpdateProfile('SharedProfile', {
        endorsements: [...existingEndorsements, endorsement],
      }, { id: profileId });

      console.log('[Endorsements] SharedProfile updated with endorsement');

      // 5. Refresh profiles store so UI updates
      await profilesStore.refreshProfiles();

      return true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error('[Endorsements] Endorsement failed:', err);
      error.value = errorMsg;
      return false;
    } finally {
      isEndorsing.value = false;
    }
  }

  /**
   * Check if the current user has already endorsed a given applicant.
   */
  function hasEndorsed(applicantAid: string): boolean {
    const myAid = identityStore.currentAID?.prefix;
    if (!myAid) return false;

    const profile = profilesStore.communityProfiles.find(p => {
      const data = (p.data as Record<string, unknown>) || {};
      return data.aid === applicantAid || (p.id as string)?.includes(applicantAid);
    });
    if (!profile) return false;

    const data = (profile.data as Record<string, unknown>) || {};
    const endorsements = (data.endorsements as EndorsementRecord[]) || [];
    return endorsements.some(e => e.endorserAid === myAid);
  }

  /**
   * Get endorsements for a given applicant from their SharedProfile.
   */
  function getEndorsements(applicantAid: string): EndorsementRecord[] {
    const profile = profilesStore.communityProfiles.find(p => {
      const data = (p.data as Record<string, unknown>) || {};
      return data.aid === applicantAid || (p.id as string)?.includes(applicantAid);
    });
    if (!profile) return [];

    const data = (profile.data as Record<string, unknown>) || {};
    return (data.endorsements as EndorsementRecord[]) || [];
  }

  function clearError() {
    error.value = null;
  }

  return {
    isEndorsing,
    error,
    endorseApplicant,
    hasEndorsed,
    getEndorsements,
    clearError,
  };
}
```

**Step 2: Verify it compiles**

Run: `cd frontend && npx vue-tsc --noEmit --skipLibCheck 2>&1 | head -30`
Expected: No errors related to `useEndorsements.ts`

**Step 3: Commit**

```bash
git add frontend/src/composables/useEndorsements.ts
git commit -m "feat: add useEndorsements composable for credential issuance"
```

---

### Task 3: Add personal registry creation to admission flow

When the admin admits a member, create a personal credential registry for them and store the registry ID in their CommunityProfile. This enables the new member to later issue endorsement credentials.

**Files:**
- Modify: `frontend/src/composables/useAdminActions.ts:265-279`

**Step 1: Add registry creation after credential issuance**

In `useAdminActions.ts`, after the credential is issued (line 265: `credentialSaid = credResult.said;`), and before the CommunityProfile update (line 269), add registry creation:

Find this block (around lines 264-279):
```typescript
      console.log('[AdminActions] Credential issued:', credResult.said);
      credentialSaid = credResult.said;

      // 6b. Update CommunityProfile with real credential SAID
```

Replace with:
```typescript
      console.log('[AdminActions] Credential issued:', credResult.said);
      credentialSaid = credResult.said;

      // 6b. Create personal registry for the new member
      //     This enables them to issue endorsement credentials to future applicants.
      //     We create it using the admin's KERIA agent since the member hasn't joined yet.
      //     The registry is anchored to the member's AID prefix.
      let personalRegistryId = '';
      try {
        const registryName = `${registration.applicantAid.slice(0, 12)}-endorsements`;
        personalRegistryId = await keriClient.createRegistry(
          registration.applicantAid,
          registryName
        );
        console.log('[AdminActions] Created personal registry for member:', personalRegistryId);
      } catch (regErr) {
        // Non-fatal: member can function without a registry, just can't endorse
        console.warn('[AdminActions] Could not create personal registry:', regErr);
      }

      // 6c. Update CommunityProfile with real credential SAID and registry ID
```

And update the CommunityProfile update call (was step 6b, now 6c) to include the registry ID:
```typescript
      // 6c. Update CommunityProfile with real credential SAID and registry ID
      try {
        const profileId = `CommunityProfile-${registration.applicantAid}`;
        await createOrUpdateProfile('CommunityProfile', {
          credential: credentialSaid,
          role: 'Member',
          credentials: [credentialSaid],
          ...(personalRegistryId && { personalRegistryId }),
        }, { id: profileId });
        console.log('[AdminActions] Updated CommunityProfile with credential SAID:', credentialSaid);
      } catch (updateErr) {
        console.warn('[AdminActions] Failed to update CommunityProfile with credential SAID:', updateErr);
      }
```

**Important note for implementer:** The registry creation uses `registration.applicantAid` as the AID name. However, the admin's KERIA agent may not have the applicant's AID identifier — the registry must be created by the member's own KERIA agent after they receive their credential and join. This means we may need to defer registry creation to the member's onboarding flow instead. **Check if `keriClient.createRegistry()` works with a remote AID prefix — if not, skip this step and create the registry during the member's first login after admission.**

If registry creation fails (which is expected if the admin can't create registries for other AIDs), that's fine — the `personalRegistryId` will be empty and the member will need to create their own registry when they first try to endorse.

**Step 2: Verify it compiles**

Run: `cd frontend && npx vue-tsc --noEmit --skipLibCheck 2>&1 | head -30`
Expected: No errors

**Step 3: Commit**

```bash
git add frontend/src/composables/useAdminActions.ts
git commit -m "feat: create personal registry during member admission"
```

---

### Task 4: Update ProfileModal with endorsement list and buttons

Replace the "Approve" button with "Endorse" for regular members and add endorsement list display. Stewards see both "Endorse" and "Admit" buttons.

**Files:**
- Modify: `frontend/src/components/profiles/ProfileModal.vue`

**Step 1: Add new props and imports**

In `ProfileModal.vue`, update the Props interface and emits to support endorsements:

Add to imports (after existing imports around line 212):
```typescript
import { ThumbsUp } from 'lucide-vue-next';
```

Update the Props interface to add:
```typescript
interface Props {
  show: boolean;
  registration?: PendingRegistration | null;
  sharedProfile?: Record<string, unknown> | null;
  communityProfile?: Record<string, unknown> | null;
  isProcessing?: boolean;
  error?: string | null;
  // New endorsement props
  isSteward?: boolean;
  currentUserAid?: string;
  endorsements?: Array<{
    endorserAid: string;
    endorserName: string;
    credentialSaid: string;
    endorsedAt: string;
    message?: string;
  }>;
  hasEndorsed?: boolean;
  isEndorsing?: boolean;
}
```

Update emits to add endorse:
```typescript
const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'approve', registration: PendingRegistration): void;
  (e: 'decline', registration: PendingRegistration, reason?: string): void;
  (e: 'endorse'): void;
}>();
```

Add default values:
```typescript
const props = withDefaults(defineProps<Props>(), {
  registration: null,
  sharedProfile: null,
  communityProfile: null,
  isProcessing: false,
  error: null,
  isSteward: false,
  currentUserAid: '',
  endorsements: () => [],
  hasEndorsed: false,
  isEndorsing: false,
});
```

**Step 2: Add endorsement list section to template**

In the template, add an endorsement section just before the `<!-- Decline Reason -->` div (around line 147). Insert between the closing `</div>` of profile fields (line 145) and the decline reason:

```html
            <!-- Endorsements Section -->
            <div v-if="props.endorsements.length > 0 || profileStatus === 'pending'" class="endorsements-section mb-6">
              <h5 class="field-label mb-3">
                Community Endorsements
                <span v-if="props.endorsements.length > 0" class="endorsement-count">
                  ({{ props.endorsements.length }})
                </span>
              </h5>
              <div v-if="props.endorsements.length > 0" class="endorsement-list space-y-2">
                <div
                  v-for="endorsement in props.endorsements"
                  :key="endorsement.credentialSaid"
                  class="endorsement-item"
                >
                  <div class="flex items-center gap-2">
                    <ThumbsUp class="w-3.5 h-3.5 text-accent shrink-0" />
                    <span class="text-sm font-medium text-black">{{ endorsement.endorserName }}</span>
                    <span class="text-xs text-black/50">{{ formatEndorsementDate(endorsement.endorsedAt) }}</span>
                  </div>
                  <p v-if="endorsement.message" class="text-xs text-black/70 mt-1 ml-5.5">
                    "{{ endorsement.message }}"
                  </p>
                </div>
              </div>
              <p v-else-if="profileStatus === 'pending'" class="text-sm text-black/50">
                No endorsements yet
              </p>
            </div>
```

**Step 3: Replace footer buttons**

Replace the entire `<!-- Footer Actions -->` section (lines 165-203) with:

```html
          <!-- Footer Actions -->
          <div v-if="profileStatus === 'pending'" class="modal-footer p-4 border-t border-border">
            <!-- Endorse confirmation (textarea for optional message) -->
            <div v-if="showEndorseMessage" class="mb-4">
              <h5 class="text-sm font-medium text-black/70 mb-2">Endorsement message (optional)</h5>
              <textarea
                v-model="endorseMessage"
                class="w-full p-3 border border-border rounded-lg bg-background text-black resize-none focus:outline-none focus:ring-2 focus:ring-accent/50"
                rows="2"
                placeholder="Why do you endorse this person?"
              />
            </div>

            <!-- Decline reason textarea (steward only) -->
            <div v-if="showDeclineReason" class="mb-4">
              <h5 class="text-sm font-medium text-black/70 mb-2">Reason for Decline (optional)</h5>
              <textarea
                v-model="declineReason"
                class="w-full p-3 border border-border rounded-lg bg-background text-black resize-none focus:outline-none focus:ring-2 focus:ring-primary/50"
                rows="2"
                placeholder="Provide a reason for declining..."
              />
            </div>

            <!-- Main action buttons -->
            <div v-if="!showDeclineReason && !showEndorseMessage" class="flex items-center gap-3">
              <!-- Endorse button (all approved members) -->
              <button
                v-if="!props.hasEndorsed"
                @click="showEndorseMessage = true"
                class="flex-1 px-4 py-2.5 text-sm rounded-lg bg-accent text-white hover:bg-accent/90 transition-colors"
                :disabled="isProcessing || isEndorsing"
              >
                <ThumbsUp class="w-4 h-4 inline mr-2" />
                Endorse
              </button>
              <button
                v-else
                class="flex-1 px-4 py-2.5 text-sm rounded-lg bg-accent/20 text-accent cursor-default"
                disabled
              >
                <ThumbsUp class="w-4 h-4 inline mr-2" />
                Endorsed
              </button>

              <!-- Admit button (steward only) -->
              <button
                v-if="props.isSteward && registration"
                @click="handleApprove"
                class="flex-1 px-4 py-2.5 text-sm rounded-lg bg-primary text-white hover:bg-primary/90 transition-colors"
                :disabled="isProcessing"
              >
                <Loader2 v-if="isProcessing && action === 'approve'" class="w-4 h-4 inline mr-2 animate-spin" />
                Admit
              </button>

              <!-- Decline button (steward only) -->
              <button
                v-if="props.isSteward && registration"
                @click="showDeclineReason = true"
                class="px-4 py-2.5 text-sm rounded-lg bg-orange-500 text-white hover:bg-orange-600 transition-colors"
                :disabled="isProcessing"
              >
                Decline
              </button>
            </div>

            <!-- Endorse confirmation buttons -->
            <div v-if="showEndorseMessage" class="flex items-center gap-3">
              <button
                @click="showEndorseMessage = false; endorseMessage = ''"
                class="flex-1 px-4 py-2.5 text-sm rounded-lg border border-border hover:bg-secondary transition-colors"
                :disabled="props.isEndorsing"
              >
                Cancel
              </button>
              <button
                @click="handleEndorse"
                class="flex-1 px-4 py-2.5 text-sm rounded-lg bg-accent text-white hover:bg-accent/90 transition-colors"
                :disabled="props.isEndorsing"
              >
                <Loader2 v-if="props.isEndorsing" class="w-4 h-4 inline mr-2 animate-spin" />
                <ThumbsUp v-else class="w-4 h-4 inline mr-2" />
                Confirm Endorsement
              </button>
            </div>

            <!-- Decline confirmation buttons (steward only) -->
            <div v-if="showDeclineReason" class="flex items-center gap-3">
              <button
                @click="showDeclineReason = false; declineReason = ''"
                class="flex-1 px-4 py-2.5 text-sm rounded-lg border border-border hover:bg-secondary transition-colors"
                :disabled="isProcessing"
              >
                Cancel
              </button>
              <button
                @click="handleDecline"
                class="flex-1 px-4 py-2.5 text-sm rounded-lg bg-destructive text-white hover:bg-destructive/90 transition-colors"
                :disabled="isProcessing"
              >
                <Loader2 v-if="isProcessing && action === 'decline'" class="w-4 h-4 inline mr-2 animate-spin" />
                Confirm Decline
              </button>
            </div>
          </div>
```

**Step 4: Add endorsement-related script logic**

Add local state and handlers in the `<script setup>`:

```typescript
// Endorsement state
const showEndorseMessage = ref(false);
const endorseMessage = ref('');

// Reset endorsement state when modal closes
watch(() => props.show, (isOpen) => {
  if (!isOpen) {
    showDeclineReason.value = false;
    declineReason.value = '';
    showEndorseMessage.value = false;
    endorseMessage.value = '';
    action.value = null;
  }
});

// Endorsement date formatter
function formatEndorsementDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function handleEndorse() {
  emit('endorse');
  // Don't close the endorse message yet — let DashboardPage handle success
}
```

Note: remove the old `watch` for `props.show` and consolidate into one that resets all state.

**Step 5: Add endorsement CSS**

Add to the `<style>` section:

```scss
.endorsements-section {
  padding-top: 0.75rem;
  border-top: 1px solid var(--matou-border);
}

.endorsement-count {
  font-weight: 400;
  color: rgba(0, 0, 0, 0.5);
}

.endorsement-item {
  padding: 0.5rem;
  border-radius: 0.5rem;
  background-color: rgba(74, 157, 156, 0.05);
}
```

**Step 6: Verify it compiles**

Run: `cd frontend && npx vue-tsc --noEmit --skipLibCheck 2>&1 | head -30`
Expected: No errors

**Step 7: Commit**

```bash
git add frontend/src/components/profiles/ProfileModal.vue
git commit -m "feat: add endorsement list and endorse/admit buttons to ProfileModal"
```

---

### Task 5: Update ProfileCard with endorsement count badge

Show the number of endorsements on each member card in the list.

**Files:**
- Modify: `frontend/src/components/profiles/ProfileCard.vue`

**Step 1: Add endorsement count display**

In `ProfileCard.vue`, add an endorsement count line after the date label (line 17). The endorsements data comes from the profile's `endorsements` field.

Add computed:
```typescript
const endorsements = computed(() => {
  return (props.profile?.endorsements as Array<unknown>) || [];
});
```

Add to template, after the `card-date` span (line 17) and before the closing `</div>` of `card-info`:
```html
      <span v-if="endorsements.length > 0" class="card-endorsements">
        <q-icon name="thumb_up" size="0.7rem" /> {{ endorsements.length }} {{ endorsements.length === 1 ? 'endorsement' : 'endorsements' }}
      </span>
```

Add CSS:
```css
.card-endorsements {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.7rem;
  color: var(--matou-accent, #4a9d9c);
  font-weight: 500;
}
```

**Step 2: Verify it compiles**

Run: `cd frontend && npx vue-tsc --noEmit --skipLibCheck 2>&1 | head -30`
Expected: No errors

**Step 3: Commit**

```bash
git add frontend/src/components/profiles/ProfileCard.vue
git commit -m "feat: show endorsement count badge on ProfileCard"
```

---

### Task 6: Wire up DashboardPage to pass endorsement data

Connect the endorsement composable and pass endorsement-related props to ProfileModal.

**Files:**
- Modify: `frontend/src/pages/DashboardPage.vue`

**Step 1: Import and use the endorsements composable**

Add import:
```typescript
import { useEndorsements } from 'src/composables/useEndorsements';
```

Add after existing composable usage (around line 176):
```typescript
const {
  isEndorsing,
  error: endorseError,
  endorseApplicant,
  hasEndorsed,
  getEndorsements,
  clearError: clearEndorseError,
} = useEndorsements();
```

Add the current user's AID:
```typescript
const identityStore = useIdentityStore();
```
(Import `useIdentityStore` from `stores/identity` if not already imported)

**Step 2: Add endorsement-related computed properties**

```typescript
// Endorsements for the selected member
const selectedMemberEndorsements = computed(() => {
  const aid = selectedMember.value?.shared?.aid as string;
  if (!aid) return [];
  return getEndorsements(aid);
});

// Whether current user has endorsed the selected member
const selectedMemberHasEndorsed = computed(() => {
  const aid = selectedMember.value?.shared?.aid as string;
  if (!aid) return false;
  return hasEndorsed(aid);
});
```

**Step 3: Update ProfileModal usage in template**

Replace the existing `<ProfileModal>` (around lines 128-138) with:

```html
    <ProfileModal
      :show="!!selectedMember"
      :sharedProfile="selectedMember?.shared"
      :communityProfile="selectedMember?.community"
      :registration="selectedMemberRegistration"
      :isProcessing="isProcessing"
      :error="actionError || endorseError"
      :isSteward="isSteward"
      :currentUserAid="identityStore.currentAID?.prefix || ''"
      :endorsements="selectedMemberEndorsements"
      :hasEndorsed="selectedMemberHasEndorsed"
      :isEndorsing="isEndorsing"
      @close="selectedMember = null"
      @approve="handleApprove"
      @decline="handleDecline"
      @endorse="handleEndorse"
    />
```

**Step 4: Add endorse handler**

Add the handler function:

```typescript
async function handleEndorse() {
  clearEndorseError();
  const aid = selectedMember.value?.shared?.aid as string;
  if (!aid) return;

  // Get OOBI from the registration if available
  const registration = selectedMemberRegistration.value;
  const oobi = registration?.applicantOOBI;

  const success = await endorseApplicant(aid, oobi);
  if (success) {
    // Profile store refreshes automatically via useEndorsements
    // Keep modal open so user can see the endorsement appear
  }
}
```

**Step 5: Update registration polling to start for all approved members**

Currently, registration polling only starts for stewards (line 238-241). All approved members need to see pending registrations to endorse them. Change:

```typescript
onMounted(async () => {
  isDark.value = document.documentElement.classList.contains('dark');
  await fetchMoonPhase();
  await checkAdminStatus();
  // Start polling for all users — approved members can endorse
  startPolling();
});
```

**Step 6: Verify it compiles**

Run: `cd frontend && npx vue-tsc --noEmit --skipLibCheck 2>&1 | head -30`
Expected: No errors

**Step 7: Commit**

```bash
git add frontend/src/pages/DashboardPage.vue
git commit -m "feat: wire up endorsement flow in DashboardPage"
```

---

### Task 7: Update credential polling to handle endorsement grants (endorsee side)

On the pending applicant's side, the credential poller needs to distinguish endorsement grants from membership grants and auto-admit endorsements without triggering the full admission flow.

**Files:**
- Modify: `frontend/src/composables/useCredentialPolling.ts`

**Step 1: Add endorsement tracking state**

Add after the existing state refs (around line 63):

```typescript
// Endorsement state
const endorsementsReceived = ref<Array<{
  endorserAid: string;
  credentialSaid: string;
  endorsedAt: string;
}>>([]);
```

Add schema SAIDs at the top of the function:
```typescript
const MEMBERSHIP_SCHEMA_SAID = 'EOVL3N0K_tYc9U-HXg7r2jDPo4Gnq3ebCjDqbJzl6fsT';
const ENDORSEMENT_SCHEMA_SAID = 'ENQU2Ty2QB1rU0DgYblcjKJnQmiF31_eUzBiwRKOi9EI';
```

**Step 2: Update grant processing to distinguish credential types**

In the `pollForGrants()` function, in the existing credentials check block (around lines 226-241), update the credential check to distinguish endorsement credentials:

Replace the credential wallet check:
```typescript
      // First, check if credentials are already in the wallet
      if (!credentialReceived.value) {
        try {
          const credentials = await client.credentials().list();
          console.log('[CredentialPolling] Existing credentials check:', credentials.length);
          if (credentials.length > 0) {
            // Check each credential's schema to categorize
            for (const cred of credentials) {
              const sad = cred.sad || cred;
              const schema = sad.s || '';
              if (schema === ENDORSEMENT_SCHEMA_SAID) {
                // Endorsement credential — track it
                const existing = endorsementsReceived.value.find(e => e.credentialSaid === sad.d);
                if (!existing) {
                  endorsementsReceived.value.push({
                    endorserAid: sad.i || '',
                    credentialSaid: sad.d || '',
                    endorsedAt: sad.a?.dt || new Date().toISOString(),
                  });
                  console.log('[CredentialPolling] Endorsement credential found in wallet:', sad.d);
                }
              } else {
                // Membership credential — existing flow
                console.log('[CredentialPolling] Membership credential in wallet:', cred);
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

**Step 3: Update the grant notification processing**

In the grant notification processing block (around lines 248-285), after admitting the grant, check the credential type before setting `credentialReceived`:

The existing `pollForCredential()` function needs updating. After admitting a grant, the credential will appear in the wallet. The wallet check (updated above) will categorize it correctly. No changes needed to `admitGrant()` itself — it admits any grant regardless of type.

**Step 4: Return endorsements in the composable**

Add `endorsementsReceived` to the return statement:

```typescript
  return {
    // State
    isPolling,
    error,
    grantReceived,
    credentialReceived,
    credential,
    spaceInviteReceived,
    spaceInviteKey,
    spaceId,
    readOnlyInviteKey,
    readOnlySpaceId,
    rejectionReceived,
    rejectionInfo,
    adminMessages,
    endorsementsReceived,  // NEW

    // Actions
    startPolling,
    stopPolling,
    retry,
    clearRejectionState,
  };
```

**Step 5: Verify it compiles**

Run: `cd frontend && npx vue-tsc --noEmit --skipLibCheck 2>&1 | head -30`
Expected: No errors

**Step 6: Commit**

```bash
git add frontend/src/composables/useCredentialPolling.ts
git commit -m "feat: distinguish endorsement vs membership grants in credential polling"
```

---

### Task 8: Update PendingApprovalScreen to show endorsements

Show received endorsements to the pending applicant and update the "What happens next?" steps.

**Files:**
- Modify: `frontend/src/components/onboarding/PendingApprovalScreen.vue`

**Step 1: Destructure endorsementsReceived from useCredentialPolling**

Update the destructuring (around line 391-406) to include `endorsementsReceived`:

```typescript
const {
  isPolling,
  error: pollingError,
  grantReceived,
  credentialReceived,
  credential,
  spaceInviteReceived,
  spaceInviteKey,
  spaceId,
  readOnlyInviteKey,
  readOnlySpaceId,
  rejectionReceived,
  rejectionInfo,
  endorsementsReceived,  // NEW
  startPolling,
  retry,
} = useCredentialPolling({ pollingInterval: 5000 });
```

**Step 2: Add endorsements section to template**

Add between the AID card (line 115) and the "What happens next?" section (line 118). Insert after `</div>` of `aid-card`:

```html
        <!-- Community Endorsements -->
        <div
          v-if="endorsementsReceived.length > 0 && currentStatus !== 'rejected'"
          class="endorsements-card bg-card border border-accent/30 rounded-2xl p-5 shadow-sm"
        >
          <div class="flex items-center gap-2 mb-3">
            <CheckCircle2 class="w-5 h-5 text-accent" />
            <h3 class="font-medium text-foreground">
              {{ endorsementsReceived.length }} Community {{ endorsementsReceived.length === 1 ? 'Endorsement' : 'Endorsements' }}
            </h3>
          </div>
          <div class="space-y-2">
            <div
              v-for="endorsement in endorsementsReceived"
              :key="endorsement.credentialSaid"
              class="flex items-center gap-2 p-2 rounded-lg bg-accent/5"
            >
              <CheckCircle2 class="w-4 h-4 text-accent shrink-0" />
              <span class="text-sm text-foreground">
                A community member endorsed your application
              </span>
              <span class="text-xs text-muted-foreground ml-auto">
                {{ formatEndorsementTime(endorsement.endorsedAt) }}
              </span>
            </div>
          </div>
        </div>
```

**Step 3: Add endorsement date formatter**

Add in the `<script setup>`:

```typescript
function formatEndorsementTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
```

**Step 4: Update "What happens next?" steps**

Replace step 2 (Admin Review, around line 223-235) with:

```html
            <!-- Step 2: Community Endorsements -->
            <div
              v-motion="slideInLeft(400)"
              class="step-card flex items-start gap-4 bg-card border border-border rounded-xl p-4"
            >
              <div class="step-number bg-primary/10 w-8 h-8 rounded-full flex items-center justify-center shrink-0">
                <span class="text-sm font-semibold text-primary">2</span>
              </div>
              <div>
                <h4 class="mb-1">Community Endorsements</h4>
                <p class="text-sm text-muted-foreground">Community members will review and endorse your application</p>
              </div>
            </div>
```

Replace step 3 (Approval Decision, around line 237-249) with:

```html
            <!-- Step 3: Admin Admission -->
            <div
              v-motion="slideInLeft(500)"
              class="step-card flex items-start gap-4 bg-card border border-border rounded-xl p-4"
            >
              <div class="step-number bg-primary/10 w-8 h-8 rounded-full flex items-center justify-center shrink-0">
                <span class="text-sm font-semibold text-primary">3</span>
              </div>
              <div>
                <h4 class="mb-1">Admin Admission</h4>
                <p class="text-sm text-muted-foreground">Once endorsed, an admin will admit you to the community</p>
              </div>
            </div>
```

**Step 5: Add CSS for endorsements card**

```scss
.endorsements-card {
  background-color: var(--matou-card);
}
```

**Step 6: Verify it compiles**

Run: `cd frontend && npx vue-tsc --noEmit --skipLibCheck 2>&1 | head -30`
Expected: No errors

**Step 7: Commit**

```bash
git add frontend/src/components/onboarding/PendingApprovalScreen.vue
git commit -m "feat: show endorsements on PendingApprovalScreen and update steps"
```

---

### Task 9: Add endorsement schema SAID constant to frontend

Add the endorsement schema SAID as a constant alongside the existing membership schema SAID in the useAdminActions composable, and export it for reuse.

**Files:**
- Modify: `frontend/src/composables/useAdminActions.ts:14`

**Step 1: Add the constant**

After the existing `MEMBERSHIP_SCHEMA_SAID` (line 14), add:

```typescript
// Endorsement credential schema
export const ENDORSEMENT_SCHEMA_SAID = 'ENQU2Ty2QB1rU0DgYblcjKJnQmiF31_eUzBiwRKOi9EI';
```

Also export the membership one:
```typescript
export const MEMBERSHIP_SCHEMA_SAID = 'EOVL3N0K_tYc9U-HXg7r2jDPo4Gnq3ebCjDqbJzl6fsT';
```

Then update `useEndorsements.ts` and `useCredentialPolling.ts` to import from `useAdminActions` instead of defining their own copy:

In `useEndorsements.ts`, replace the local constant:
```typescript
import { ENDORSEMENT_SCHEMA_SAID } from './useAdminActions';
```

In `useCredentialPolling.ts`, import:
```typescript
// Import at top — these come from useAdminActions but we only need the constants, not the composable
const MEMBERSHIP_SCHEMA_SAID = 'EOVL3N0K_tYc9U-HXg7r2jDPo4Gnq3ebCjDqbJzl6fsT';
const ENDORSEMENT_SCHEMA_SAID = 'ENQU2Ty2QB1rU0DgYblcjKJnQmiF31_eUzBiwRKOi9EI';
```

(Keep local constants in useCredentialPolling since it can't import from a composable at module level — composables use Vue's composition API)

**Step 2: Verify it compiles**

Run: `cd frontend && npx vue-tsc --noEmit --skipLibCheck 2>&1 | head -30`
Expected: No errors

**Step 3: Commit**

```bash
git add frontend/src/composables/useAdminActions.ts frontend/src/composables/useEndorsements.ts
git commit -m "refactor: export schema SAID constants from useAdminActions"
```

---

### Task 10: Manual testing and verification

Test the full endorsement flow using dev sessions.

**Prerequisites:**
- 2 dev sessions running (`npm run dev:sessions:2`)
- Clean infrastructure

**Test Plan:**

1. **Session 1 (Admin):** Set up org, register as admin
2. **Session 2 (Member A):** Register as a member, get approved by admin
3. **Session 2 (Member A):** Navigate to dashboard, find a pending member, click "Endorse"
4. **Session 1 (Admin):** View the pending member, see endorsement count, click "Admit"

**Verification checklist:**
- [ ] Endorsed member appears with endorsement badge in member list
- [ ] ProfileModal shows endorsement list with endorser name and date
- [ ] "Endorse" button disabled after endorsing ("Endorsed")
- [ ] Steward sees both "Endorse" and "Admit" buttons
- [ ] Non-steward sees only "Endorse" button
- [ ] Endorsement credential appears in applicant's PendingApprovalScreen
- [ ] Full admission flow still works after endorsements

**Step 1: Start dev environment**

Run: `cd frontend && npm run dev:sessions:2`
Open: `http://localhost:5100` (session 1) and `http://localhost:5101` (session 2)

**Step 2: Test and verify**

Follow the test plan above, verifying each checklist item.

**Step 3: Commit any fixes**

If any fixes were needed during testing, commit them separately.
