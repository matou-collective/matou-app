# Admin Member Removal Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow admins to remove members by revoking their credential and soft-deleting their profiles.

**Architecture:** Frontend adds a "Remove Member" button to ProfileModal that calls a new `removeMember` action in `useAdminActions`. The action revokes the credential via KERI, then soft-deletes both profiles (CommunityProfile and SharedProfile) by setting `status: 'removed'`. The DashboardPage filters out removed members.

**Tech Stack:** Vue 3 (composables, components), Go (HTTP handler), KERI (signify-ts credential revocation), any-sync (profile objects)

---

### Task 1: Add backend DELETE /api/v1/members/{aid} endpoint

**Files:**
- Modify: `backend/internal/api/profiles.go`

**Step 1: Add the RemoveMemberRequest struct and handler**

After `HandleUpdateMemberRole` (line 765), add:

```go
// RemoveMemberRequest represents a request to remove a member.
type RemoveMemberRequest struct {
	Reason string `json:"reason,omitempty"`
}

// HandleRemoveMember handles DELETE /api/v1/members/{aid}.
// Soft-deletes the member's CommunityProfile and SharedProfile by setting status to 'removed'.
func (h *ProfilesHandler) HandleRemoveMember(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	// Extract member AID from URL path: /api/v1/members/{aid}
	memberAID := strings.TrimPrefix(r.URL.Path, "/api/v1/members/")
	if memberAID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "member AID is required"})
		return
	}

	var req RemoveMemberRequest
	if r.Body != nil {
		json.NewDecoder(r.Body).Decode(&req) // optional body
	}

	adminAID := ""
	if h.userIdentity != nil {
		adminAID = h.userIdentity.GetAID()
	}

	ctx := r.Context()
	objMgr := h.spaceManager.ObjectTreeManager()
	client := h.spaceManager.GetClient()
	if client == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "any-sync client not available"})
		return
	}

	nowStr := time.Now().UTC().Format(time.RFC3339)

	// 1. Update CommunityProfile in read-only space
	roSpaceID := h.spaceManager.GetCommunityReadOnlySpaceID()
	if roSpaceID != "" {
		keys, err := anysync.LoadSpaceKeySet(client.GetDataDir(), roSpaceID)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": fmt.Sprintf("failed to load RO space keys: %v", err)})
			return
		}

		objectID := fmt.Sprintf("CommunityProfile-%s", memberAID)
		statusBytes, _ := json.Marshal("removed")
		removedAtBytes, _ := json.Marshal(nowStr)
		removedByBytes, _ := json.Marshal(adminAID)

		fields := map[string]json.RawMessage{
			"status":    statusBytes,
			"removedAt": removedAtBytes,
			"removedBy": removedByBytes,
		}
		if req.Reason != "" {
			reasonBytes, _ := json.Marshal(req.Reason)
			fields["removalReason"] = reasonBytes
		}

		if _, err := objMgr.UpdateObject(ctx, roSpaceID, objectID, fields, keys.SigningKey); err != nil {
			log.Printf("[RemoveMember] Warning: failed to update CommunityProfile for %s: %v", memberAID, err)
		} else {
			log.Printf("[RemoveMember] CommunityProfile marked as removed for %s", memberAID)
		}
	}

	// 2. Update SharedProfile in community space
	communitySpaceID := h.spaceManager.GetCommunitySpaceID()
	if communitySpaceID != "" {
		keys, err := anysync.LoadSpaceKeySet(client.GetDataDir(), communitySpaceID)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": fmt.Sprintf("failed to load community space keys: %v", err)})
			return
		}

		objectID := fmt.Sprintf("SharedProfile-%s", memberAID)
		statusBytes, _ := json.Marshal("removed")
		removedAtBytes, _ := json.Marshal(nowStr)

		fields := map[string]json.RawMessage{
			"status":    statusBytes,
			"removedAt": removedAtBytes,
		}

		if _, err := objMgr.UpdateObject(ctx, communitySpaceID, objectID, fields, keys.SigningKey); err != nil {
			log.Printf("[RemoveMember] Warning: failed to update SharedProfile for %s: %v", memberAID, err)
		} else {
			log.Printf("[RemoveMember] SharedProfile marked as removed for %s", memberAID)
		}
	}

	// Broadcast event
	if h.eventBroker != nil {
		h.eventBroker.Broadcast(SSEEvent{
			Type: "member:removed",
			Data: map[string]interface{}{
				"memberAid": memberAID,
				"removedBy": adminAID,
			},
		})
	}

	writeJSON(w, http.StatusOK, map[string]string{
		"success":   "true",
		"memberAid": memberAID,
		"status":    "removed",
	})
}
```

**Step 2: Wire up the DELETE route in `handleMembers`**

Replace the `handleMembers` method (line 837-843) with:

```go
// handleMembers routes /api/v1/members/* requests.
func (h *ProfilesHandler) handleMembers(w http.ResponseWriter, r *http.Request) {
	if strings.HasSuffix(r.URL.Path, "/role") && r.Method == http.MethodPut {
		h.HandleUpdateMemberRole(w, r)
		return
	}
	if r.Method == http.MethodDelete {
		h.HandleRemoveMember(w, r)
		return
	}
	writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
}
```

**Step 3: Verify it compiles**

Run: `cd /home/benz/Documents/1.projects/matou-app/backend && make build`

**Step 4: Commit**

```bash
git add backend/internal/api/profiles.go
git commit -m "feat: add DELETE /api/v1/members/{aid} endpoint for member removal"
```

---

### Task 2: Add `removeMember` to useAdminActions composable

**Files:**
- Modify: `frontend/src/composables/useAdminActions.ts`
- Modify: `frontend/src/lib/api/client.ts`

**Step 1: Add `removeMember` API helper to client.ts**

After the existing `createOrUpdateProfile` function in `frontend/src/lib/api/client.ts`, add:

```typescript
export async function removeMember(
  memberAid: string,
  reason?: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/v1/members/${encodeURIComponent(memberAid)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    });
    if (!response.ok) {
      const data = await response.json();
      return { success: false, error: data.error || 'Failed to remove member' };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
```

**Step 2: Add `removeMember` action in useAdminActions.ts**

Add this function inside `useAdminActions()`, before the `clearError` function (line 629). Also add `removeMember` to the import from `src/lib/api/client` on line 10, and add `MEMBERSHIP_SCHEMA_SAID` usage is already imported.

```typescript
  /**
   * Remove a member: revoke credential + soft-delete profiles.
   * Reports progress via onStep callback.
   */
  async function removeMember(
    memberAid: string,
    credentialSaid: string,
    reason?: string,
    onStep?: (step: string) => void,
  ): Promise<boolean> {
    if (isProcessing.value) {
      console.warn('[AdminActions] Already processing an action');
      return false;
    }

    isProcessing.value = true;
    error.value = null;

    try {
      const client = keriClient.getSignifyClient();
      if (!client) throw new Error('Not connected to KERIA');

      // Step 1: Revoke membership credential
      onStep?.('Revoking membership credential...');
      const orgAidPrefix = await getOrgAidName();

      if (credentialSaid) {
        await keriClient.revokeCredential(orgAidPrefix, credentialSaid);
        console.log('[AdminActions] Credential revoked:', credentialSaid);
      } else {
        // Fallback: find credential by AID
        const creds = await client.credentials().list();
        const memberCred = creds.find(
          (c: { sad: { s: string; a?: { i?: string } } }) =>
            c.sad.s === MEMBERSHIP_SCHEMA_SAID && c.sad.a?.i === memberAid
        );
        if (memberCred) {
          await keriClient.revokeCredential(orgAidPrefix, memberCred.sad.d);
          console.log('[AdminActions] Credential revoked (found by AID):', memberCred.sad.d);
        } else {
          console.warn('[AdminActions] No membership credential found to revoke for:', memberAid);
        }
      }

      // Step 2: Soft-delete profiles via backend
      onStep?.('Removing member profiles...');
      const result = await removeMemberAPI(memberAid, reason);
      if (!result.success) {
        throw new Error(result.error || 'Failed to remove member profiles');
      }

      onStep?.('Complete');
      console.log('[AdminActions] Member removed:', memberAid);

      lastAction.value = {
        type: 'remove',
        success: true,
        registrationId: memberAid,
      };

      return true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error('[AdminActions] Remove member failed:', err);
      error.value = errorMsg;

      lastAction.value = {
        type: 'remove',
        success: false,
        registrationId: memberAid,
      };

      return false;
    } finally {
      isProcessing.value = false;
    }
  }
```

Note: import `removeMember` from the API client with an alias to avoid name collision:

```typescript
import { BACKEND_URL, createOrUpdateProfile, initMemberProfiles, sendRegistrationApprovedNotification, removeMember as removeMemberAPI } from 'src/lib/api/client';
```

And add `removeMember` to the return object:

```typescript
  return {
    // State
    isProcessing,
    processingRegistrationId,
    error,
    lastAction,

    // Actions
    approveRegistration,
    addStewardToOrgMultisig,
    upgradeMemberToSteward,
    declineRegistration,
    sendMessageToApplicant,
    removeMember,
    clearError,
  };
```

**Step 3: Commit**

```bash
git add frontend/src/composables/useAdminActions.ts frontend/src/lib/api/client.ts
git commit -m "feat: add removeMember action with credential revocation"
```

---

### Task 3: Add "Remove Member" UI to ProfileModal

**Files:**
- Modify: `frontend/src/components/profiles/ProfileModal.vue`

**Step 1: Add the remove member emit and props**

In the `Props` interface, add:

```typescript
  canRemoveMember?: boolean;
  isRemoving?: boolean;
```

In `withDefaults`, add:

```typescript
  canRemoveMember: false,
  isRemoving: false,
```

In `defineEmits`, add:

```typescript
  (e: 'remove', aid: string, reason?: string): void;
```

**Step 2: Add local state for the remove confirmation**

After `const endorseMessage = ref('');` (line 500), add:

```typescript
// Remove member state
const showRemoveConfirm = ref(false);
const removeReason = ref('');
```

In the `watch(() => props.show, ...)` reset block (line 529-538), add resets:

```typescript
    showRemoveConfirm.value = false;
    removeReason.value = '';
```

Add handler function after `handleDecline()`:

```typescript
function handleRemove() {
  const aid = profileAid.value;
  if (aid) {
    emit('remove', aid, removeReason.value || undefined);
  }
}
```

**Step 3: Add the remove button and confirmation UI to the template**

After the closing `</div>` of the footer for pending status (line 337), add a new footer section for approved members:

```html
          <!-- Footer: Approved member actions (remove) -->
          <div v-if="profileStatus === 'approved' && props.canRemoveMember" class="modal-footer p-4 border-t border-border">
            <!-- Remove reason textarea -->
            <div v-if="showRemoveConfirm" class="mb-4">
              <h5 class="field-label">Reason for removal (optional)</h5>
              <textarea
                v-model="removeReason"
                class="field-input"
                rows="2"
                placeholder="Provide a reason for removing this member..."
              />
            </div>

            <!-- Remove confirmation buttons -->
            <div v-if="showRemoveConfirm" class="flex items-center gap-3">
              <button
                @click="showRemoveConfirm = false; removeReason = ''"
                class="flex-1 px-4 py-2.5 text-sm rounded-lg border border-border hover:bg-secondary transition-colors"
                :disabled="props.isRemoving"
              >
                Cancel
              </button>
              <button
                @click="handleRemove"
                class="flex-1 px-4 py-2.5 text-sm rounded-lg bg-destructive text-white hover:bg-destructive/90 transition-colors"
                :disabled="props.isRemoving"
              >
                <Loader2 v-if="props.isRemoving" class="w-4 h-4 inline mr-2 animate-spin" />
                Confirm Removal
              </button>
            </div>

            <!-- Initial remove button -->
            <div v-else>
              <button
                @click="showRemoveConfirm = true"
                class="w-full px-4 py-2.5 text-sm rounded-lg bg-destructive/10 text-destructive hover:bg-destructive/20 transition-colors"
              >
                Remove Member
              </button>
            </div>
          </div>
```

**Step 4: Add `UserMinus` to lucide imports**

Update the import line (line 356):

```typescript
import { X, Check, Copy, Loader2, ThumbsUp, CalendarCheck, Pencil } from 'lucide-vue-next';
```

(No new icon needed — we're using text-only buttons.)

**Step 5: Commit**

```bash
git add frontend/src/components/profiles/ProfileModal.vue
git commit -m "feat: add Remove Member button and confirmation UI to ProfileModal"
```

---

### Task 4: Wire up removal in DashboardPage

**Files:**
- Modify: `frontend/src/pages/DashboardPage.vue`

**Step 1: Read the file to find exact insertion points**

Read `frontend/src/pages/DashboardPage.vue` to find:
- The `useAdminActions()` destructure
- The ProfileModal component usage
- The handler functions section

**Step 2: Add `removeMember` to the useAdminActions destructure**

Find the line that destructures `useAdminActions()` and add `removeMember` to it.

**Step 3: Add removal state and handler**

Add a `isRemoving` ref and a handler function:

```typescript
const isRemoving = ref(false);

async function handleRemoveMember(aid: string, reason?: string) {
  const community = selectedMemberCommunityProfile.value;
  const credentialSaid = (community?.credential as string) || '';

  isRemoving.value = true;
  const success = await removeMember(aid, credentialSaid, reason);
  isRemoving.value = false;

  if (success) {
    selectedMember.value = null;
    // Refresh member list
    await loadMembers();
  }
}
```

Note: `loadMembers` should be whatever function refreshes the member list. Read the file to find the right function name.

**Step 4: Add props and event to ProfileModal in template**

Add to the `<ProfileModal>` component:

```html
    :canRemoveMember="isSteward && profileStatus !== 'pending' && selectedMemberSharedProfile?.aid !== identityStore.currentAID?.prefix"
    :isRemoving="isRemoving"
    @remove="handleRemoveMember"
```

The `canRemoveMember` condition ensures: admin only, not for pending registrations, and not for self.

**Step 5: Commit**

```bash
git add frontend/src/pages/DashboardPage.vue
git commit -m "feat: wire member removal into DashboardPage"
```

---

### Task 5: Filter removed members from member list

**Files:**
- Modify: `frontend/src/pages/DashboardPage.vue`

**Step 1: Find the member list computed property**

Read the DashboardPage to find where `liveMembers` (or equivalent) is computed and filter out members with `status === 'removed'`.

**Step 2: Add filter**

In the computed that returns the member list, add a filter:

```typescript
.filter(m => (m.profile?.status as string) !== 'removed')
```

This ensures removed members don't appear in the member grid.

**Step 3: Also filter in the backend community members endpoint (optional)**

In `backend/internal/api/sync.go`, the `HandleGetCommunityMembers` handler reads from the space and builds member objects. Consider filtering out members whose CommunityProfile has `status: 'removed'`. However since the frontend already filters, this is optional.

**Step 4: Commit**

```bash
git add frontend/src/pages/DashboardPage.vue
git commit -m "feat: filter removed members from dashboard member list"
```

---

### Task 6: Verification

**Step 1: Build backend**

Run: `cd /home/benz/Documents/1.projects/matou-app/backend && make build`

**Step 2: Run frontend dev server**

Run: `cd /home/benz/Documents/1.projects/matou-app/frontend && npx quasar dev -m electron`

**Step 3: Verify**

- Open the app, navigate to dashboard
- Click on an approved member — verify "Remove Member" button appears at the bottom of the modal (only for stewards)
- Click "Remove Member" — verify confirmation UI with optional reason textarea appears
- Click "Cancel" — verify it goes back to the button
- Verify the button does NOT appear for your own profile
- Verify the button does NOT appear for pending registrations

**Step 4: Final commit if cleanup needed**

```bash
git add -A && git commit -m "chore: finalize member removal feature"
```
