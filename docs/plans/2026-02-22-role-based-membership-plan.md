# Role-Based Membership Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the old 8-role + embedded permissions membership system with 10 role-based roles (no permissions in credential), and add UI to change a member's role from the profile modal.

**Architecture:** Update the ACDC schema to remove `permissions` and `verificationStatus` fields, replace the role enum with 10 new roles. Add a backend `PUT /api/v1/members/{aid}/role` endpoint that updates the CommunityProfile and re-issues the credential. Add a `ChangeRoleModal.vue` frontend component triggered from the ProfileModal.

**Tech Stack:** Go backend, Vue 3 / Quasar frontend, KERI/ACDC credentials via signify-ts, any-sync for profile storage.

---

### Task 1: Update Backend Role Definitions

**Files:**
- Modify: `backend/internal/keri/client.go:148-189`
- Modify: `backend/internal/keri/client_test.go:1-95`

**Step 1: Update `GetPermissionsForRole()` in `client.go`**

Replace lines 148-165 with the new 10-role permission mapping:

```go
// GetPermissionsForRole returns the permissions for a given role
func GetPermissionsForRole(role string) []string {
	permissions := map[string][]string{
		"Member":              {"read", "comment"},
		"Contributor":         {"read", "comment", "vote", "contribute"},
		"Community Steward":   {"read", "comment", "vote", "propose", "moderate", "admin", "issue_membership", "approve_registrations"},
		"Operations Steward":  {"read", "comment", "vote", "propose", "moderate", "admin", "issue_membership", "revoke_membership", "approve_registrations"},
		"Founding Member":     {"read", "comment", "vote", "propose", "moderate", "admin", "issue_membership", "revoke_membership", "approve_registrations"},
		"Financial Steward":   {"read", "comment", "vote", "propose", "moderate", "admin", "manage_finances"},
		"Governance Steward":  {"read", "comment", "vote", "propose", "moderate", "admin", "manage_governance"},
		"Treasury Steward":    {"read", "comment", "vote", "propose", "moderate", "admin", "manage_treasury"},
		"Technical Steward":   {"read", "comment", "vote", "propose", "moderate", "admin", "manage_technical"},
		"Cultural Steward":    {"read", "comment", "vote", "propose", "moderate", "admin", "manage_cultural"},
	}

	if perms, ok := permissions[role]; ok {
		return perms
	}
	return []string{"read"}
}
```

**Step 2: Update `ValidRoles()` in `client.go`**

Replace lines 167-179:

```go
// ValidRoles returns the list of valid membership roles
func ValidRoles() []string {
	return []string{
		"Member",
		"Contributor",
		"Community Steward",
		"Operations Steward",
		"Founding Member",
		"Financial Steward",
		"Governance Steward",
		"Treasury Steward",
		"Technical Steward",
		"Cultural Steward",
	}
}
```

**Step 3: Update unit tests in `client_test.go`**

Replace the existing tests to match the new roles:

```go
func TestGetPermissionsForRole(t *testing.T) {
	tests := []struct {
		role            string
		expectedMinPerm int
		hasPermission   string
	}{
		{"Member", 2, "read"},
		{"Contributor", 4, "contribute"},
		{"Community Steward", 8, "issue_membership"},
		{"Operations Steward", 9, "revoke_membership"},
		{"Founding Member", 9, "approve_registrations"},
		{"Financial Steward", 7, "manage_finances"},
		{"Cultural Steward", 7, "manage_cultural"},
		{"Unknown", 1, "read"},
	}

	for _, tt := range tests {
		t.Run(tt.role, func(t *testing.T) {
			perms := GetPermissionsForRole(tt.role)
			if len(perms) < tt.expectedMinPerm {
				t.Errorf("expected at least %d permissions, got %d", tt.expectedMinPerm, len(perms))
			}

			found := false
			for _, p := range perms {
				if p == tt.hasPermission {
					found = true
					break
				}
			}
			if !found {
				t.Errorf("expected permission %s not found in %v", tt.hasPermission, perms)
			}
		})
	}
}

func TestValidRoles(t *testing.T) {
	roles := ValidRoles()
	if len(roles) != 10 {
		t.Errorf("expected 10 roles, got %d", len(roles))
	}

	expected := []string{
		"Member",
		"Contributor",
		"Operations Steward",
		"Founding Member",
		"Cultural Steward",
	}

	for _, e := range expected {
		found := false
		for _, r := range roles {
			if r == e {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("expected role %s not found", e)
		}
	}
}

func TestIsValidRole(t *testing.T) {
	tests := []struct {
		role  string
		valid bool
	}{
		{"Member", true},
		{"Founding Member", true},
		{"Operations Steward", true},
		{"Cultural Steward", true},
		{"Admin", false},           // old role, no longer valid
		{"Verified Member", false}, // old role, no longer valid
		{"SuperAdmin", false},
		{"", false},
		{"member", false}, // case sensitive
	}

	for _, tt := range tests {
		t.Run(tt.role, func(t *testing.T) {
			if got := IsValidRole(tt.role); got != tt.valid {
				t.Errorf("IsValidRole(%q) = %v, want %v", tt.role, got, tt.valid)
			}
		})
	}
}
```

**Step 4: Run tests**

Run: `cd backend && make test`
Expected: All tests pass, including updated role tests.

**Step 5: Commit**

```bash
git add backend/internal/keri/client.go backend/internal/keri/client_test.go
git commit -m "feat: update role definitions to 10 role-based roles"
```

---

### Task 2: Update Membership Credential Schema

**Files:**
- Modify: `backend/schemas/matou-membership-schema.json`

**Step 1: Update the schema**

Remove `verificationStatus` and `permissions` from the attributes block. Update the `role` enum to the 10 new roles. Remove them from `required` array.

The updated schema `a` block properties should contain:
- `d`, `i`, `dt`, `communityName`, `role`, `joinedAt` (keep these)
- Remove: `verificationStatus`, `permissions`

Update the `role` enum to:
```json
"enum": [
    "Member",
    "Contributor",
    "Community Steward",
    "Operations Steward",
    "Founding Member",
    "Financial Steward",
    "Governance Steward",
    "Treasury Steward",
    "Technical Steward",
    "Cultural Steward"
]
```

Update `required` in the attributes block (lines 100-109) to:
```json
"required": ["d", "i", "dt", "communityName", "role", "joinedAt"]
```

**Important:** The `$id` (SAID) will need to change since the schema content changed. For now, leave the old SAID — it will be updated when the schema is registered with the schema server. Add a comment or bump the version to `2.0.0`.

**Step 2: Commit**

```bash
git add backend/schemas/matou-membership-schema.json
git commit -m "feat: remove permissions/verificationStatus from membership schema, update roles"
```

---

### Task 3: Update Backend Credential Issuance (Remove Permissions from Credential Data)

**Files:**
- Modify: `backend/internal/api/profiles.go:438-446` (HandleInitMemberProfiles CommunityProfile data)

**Step 1: Remove `permissions` from CommunityProfile data**

In `HandleInitMemberProfiles` (profiles.go line 445), remove the `permissions` field from `communityProfileData`:

Change line 445 from:
```go
		"permissions":  []string{"participate", "vote", "propose"},
```
to: (delete this line entirely)

**Step 2: Run tests**

Run: `cd backend && make test`
Expected: All tests pass.

**Step 3: Commit**

```bash
git add backend/internal/api/profiles.go
git commit -m "feat: remove permissions from CommunityProfile data"
```

---

### Task 4: Add Backend Role Update Endpoint

**Files:**
- Modify: `backend/internal/api/profiles.go` (add handler + route)

**Step 1: Add `UpdateMemberRoleRequest` struct**

Add after `InitMemberProfilesRequest` (around line 379):

```go
// UpdateMemberRoleRequest represents a request to update a member's role.
type UpdateMemberRoleRequest struct {
	Role string `json:"role"`
}
```

**Step 2: Add `HandleUpdateMemberRole` handler**

Add after `HandleInitMemberProfiles` function:

```go
// HandleUpdateMemberRole handles PUT /api/v1/members/{aid}/role.
// Updates the member's CommunityProfile role in the read-only space.
func (h *ProfilesHandler) HandleUpdateMemberRole(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}

	// Extract member AID from URL path: /api/v1/members/{aid}/role
	path := r.URL.Path
	parts := strings.Split(strings.TrimPrefix(path, "/api/v1/members/"), "/")
	if len(parts) < 2 || parts[1] != "role" || parts[0] == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid path, expected /api/v1/members/{aid}/role"})
		return
	}
	memberAID := parts[0]

	var req UpdateMemberRoleRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": fmt.Sprintf("invalid request: %v", err),
		})
		return
	}

	if !keri.IsValidRole(req.Role) {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": fmt.Sprintf("invalid role: %s", req.Role),
		})
		return
	}

	// Find and update the member's CommunityProfile
	roSpaceID := h.spaceManager.GetCommunityReadOnlySpaceID()
	if roSpaceID == "" {
		writeJSON(w, http.StatusConflict, map[string]string{
			"error": "community-readonly space not configured",
		})
		return
	}

	client := h.spaceManager.GetClient()
	if client == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"error": "any-sync client not available",
		})
		return
	}

	ctx := r.Context()
	objMgr := client.GetObjectManager()

	// Read existing CommunityProfile for this member
	objects, err := objMgr.ReadObjectsByType(ctx, roSpaceID, "CommunityProfile")
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to read profiles: %v", err),
		})
		return
	}

	// Find the profile for this member AID
	var targetObj *anysync.ObjectData
	for i := range objects {
		if aid, ok := objects[i].Data["userAID"].(string); ok && aid == memberAID {
			targetObj = &objects[i]
			break
		}
	}

	if targetObj == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{
			"error": fmt.Sprintf("no CommunityProfile found for AID %s", memberAID),
		})
		return
	}

	// Update the role field
	targetObj.Data["role"] = req.Role
	targetObj.Data["lastActiveAt"] = time.Now().UTC().Format(time.RFC3339)

	dataBytes, err := json.Marshal(targetObj.Data)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to marshal updated profile: %v", err),
		})
		return
	}

	keys, err := anysync.LoadSpaceKeySet(client.GetDataDir(), roSpaceID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to load space keys: %v", err),
		})
		return
	}

	if err := objMgr.UpdateObject(ctx, roSpaceID, targetObj.ObjectID, string(dataBytes), keys.ReadKey, keys.WriteKey); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{
			"error": fmt.Sprintf("failed to update profile: %v", err),
		})
		return
	}

	log.Printf("[UpdateMemberRole] Updated role for %s to %s", memberAID, req.Role)
	writeJSON(w, http.StatusOK, map[string]string{
		"success": "true",
		"role":    req.Role,
	})
}
```

**Step 3: Register the route**

In `RegisterRoutes` (profiles.go ~line 707), add:

```go
	mux.HandleFunc("/api/v1/members/", h.handleMembers)
```

And add a router function:

```go
// handleMembers routes /api/v1/members/* requests.
func (h *ProfilesHandler) handleMembers(w http.ResponseWriter, r *http.Request) {
	if strings.HasSuffix(r.URL.Path, "/role") && r.Method == http.MethodPut {
		h.HandleUpdateMemberRole(w, r)
		return
	}
	writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
}
```

**Step 4: Add `strings` import if not present**

Check imports at top of `profiles.go` and add `"strings"` if needed.

**Step 5: Run tests**

Run: `cd backend && make test`
Expected: All tests pass, backend builds clean.

**Step 6: Commit**

```bash
git add backend/internal/api/profiles.go
git commit -m "feat: add PUT /api/v1/members/{aid}/role endpoint"
```

---

### Task 5: Update Frontend Credential Issuance (Remove Permissions)

**Files:**
- Modify: `frontend/src/composables/usePreCreatedInvite.ts:227-242`
- Modify: `frontend/src/composables/useAdminActions.ts:245-264`

**Step 1: Update `usePreCreatedInvite.ts`**

Remove the `permissionsByRole` mapping (lines 227-235) and the `permissions` field from credential data (line 240).

Replace lines 227-242 with:

```typescript
      // Issue membership credential (no permissions — role-based)
      const credentialData = {
        communityName: 'MATOU',
        role,
        joinedAt: new Date().toISOString(),
      };
```

**Step 2: Update `useAdminActions.ts`**

In `approveRegistration()` (around lines 245-264), remove `verificationStatus` and `permissions` from the credential data:

Change the credential data object to:

```typescript
      const credentialData = {
        communityName: 'MATOU',
        role: 'Member',
        joinedAt: new Date().toISOString(),
      };
```

**Step 3: Update the role options in `InviteMemberModal.vue`**

In `InviteMemberModal.vue` (lines 33-42), update the role dropdown options:

```html
<select v-model="role">
  <option value="Member">Member</option>
  <option value="Contributor">Contributor</option>
  <option value="Community Steward">Community Steward</option>
  <option value="Operations Steward">Operations Steward</option>
  <option value="Founding Member">Founding Member</option>
  <option value="Financial Steward">Financial Steward</option>
  <option value="Governance Steward">Governance Steward</option>
  <option value="Treasury Steward">Treasury Steward</option>
  <option value="Technical Steward">Technical Steward</option>
  <option value="Cultural Steward">Cultural Steward</option>
</select>
```

**Step 4: Commit**

```bash
git add frontend/src/composables/usePreCreatedInvite.ts frontend/src/composables/useAdminActions.ts frontend/src/components/dashboard/InviteMemberModal.vue
git commit -m "feat: remove permissions from credential issuance, update role options"
```

---

### Task 6: Update `useAdminAccess.ts` for New Roles

**Files:**
- Modify: `frontend/src/composables/useAdminAccess.ts`

**Step 1: Update `isSteward` computed**

Replace lines 41-44:

```typescript
  // Check if user has a role that can manage members
  const canManageMembers = computed(() => {
    const role = (adminCredential.value?.role || '').toLowerCase();
    return role.includes('operations steward') ||
           role.includes('founding member');
  });

  const isSteward = computed(() => {
    const role = (adminCredential.value?.role || '').toLowerCase();
    return role.includes('steward') || role.includes('founding member');
  });
```

**Step 2: Update admin role detection (line 112)**

Replace the role detection check at line 112:

```typescript
        if (role.includes('steward') || role.includes('founding member')) {
```

**Step 3: Export `canManageMembers`**

Add to the return object (around line 215):

```typescript
    canManageMembers,
```

**Step 4: Commit**

```bash
git add frontend/src/composables/useAdminAccess.ts
git commit -m "feat: update admin access for new role definitions"
```

---

### Task 7: Add `updateMemberRole` API Client Function

**Files:**
- Modify: `frontend/src/lib/api/client.ts`

**Step 1: Add the API function**

Add after `initMemberProfiles` function (around line 417):

```typescript
/**
 * Update a member's role.
 */
export async function updateMemberRole(
  memberAid: string,
  role: string,
): Promise<{ success: boolean; role?: string; error?: string }> {
  const res = await fetch(`${BACKEND_URL}/api/v1/members/${memberAid}/role`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  });
  return res.json();
}
```

**Step 2: Commit**

```bash
git add frontend/src/lib/api/client.ts
git commit -m "feat: add updateMemberRole API client function"
```

---

### Task 8: Create ChangeRoleModal Component

**Files:**
- Create: `frontend/src/components/dashboard/ChangeRoleModal.vue`

**Step 1: Create the component**

```vue
<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="show" class="modal-overlay fixed inset-0 z-[60] flex items-center justify-center p-4" @click.self="$emit('close')">
        <div class="modal-content bg-card border border-border rounded-2xl shadow-xl max-w-md w-full overflow-hidden">
          <!-- Header -->
          <div class="modal-header bg-primary p-4 border-b border-white/20 flex items-center justify-between">
            <h3 class="font-semibold text-lg text-white">Change Role</h3>
            <q-btn flat @click="$emit('close')" class="p-1.5 rounded-lg transition-colors">
              <X class="w-5 h-5 text-white" />
            </q-btn>
          </div>

          <!-- Content -->
          <div class="modal-body p-4">
            <p class="text-sm text-black/70 mb-4">
              Select a new role for <strong>{{ memberName }}</strong>
            </p>

            <div class="space-y-2">
              <label
                v-for="role in roles"
                :key="role"
                class="flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors"
                :class="selectedRole === role
                  ? 'border-primary bg-primary/10'
                  : 'border-border hover:bg-secondary'"
              >
                <input
                  type="radio"
                  :value="role"
                  v-model="selectedRole"
                  class="accent-[var(--matou-primary)]"
                />
                <span class="text-sm font-medium" :class="role === currentRole ? 'text-primary' : 'text-black'">
                  {{ role }}
                  <span v-if="role === currentRole" class="text-xs text-black/50 ml-1">(current)</span>
                </span>
              </label>
            </div>

            <!-- Error -->
            <div v-if="error" class="mt-4 p-3 bg-destructive/10 border border-destructive/20 rounded-lg">
              <p class="text-sm text-destructive">{{ error }}</p>
            </div>
          </div>

          <!-- Footer -->
          <div class="p-4 border-t border-border flex items-center gap-3">
            <button
              @click="$emit('close')"
              class="flex-1 px-4 py-2.5 text-sm rounded-lg border border-border hover:bg-secondary transition-colors"
              :disabled="isUpdating"
            >
              Cancel
            </button>
            <button
              @click="handleConfirm"
              class="flex-1 px-4 py-2.5 text-sm rounded-lg bg-primary text-white hover:bg-primary/90 transition-colors disabled:opacity-50"
              :disabled="isUpdating || selectedRole === currentRole"
            >
              <Loader2 v-if="isUpdating" class="w-4 h-4 inline mr-2 animate-spin" />
              Confirm
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { X, Loader2 } from 'lucide-vue-next';
import { updateMemberRole } from 'src/lib/api/client';

interface Props {
  show: boolean;
  memberName: string;
  memberAid: string;
  currentRole: string;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'role-updated', role: string): void;
}>();

const roles = [
  'Member',
  'Contributor',
  'Community Steward',
  'Operations Steward',
  'Founding Member',
  'Financial Steward',
  'Governance Steward',
  'Treasury Steward',
  'Technical Steward',
  'Cultural Steward',
];

const selectedRole = ref(props.currentRole);
const isUpdating = ref(false);
const error = ref<string | null>(null);

watch(() => props.show, (isOpen) => {
  if (isOpen) {
    selectedRole.value = props.currentRole;
    error.value = null;
  }
});

async function handleConfirm() {
  if (selectedRole.value === props.currentRole) return;

  isUpdating.value = true;
  error.value = null;

  try {
    const result = await updateMemberRole(props.memberAid, selectedRole.value);
    if (result.error) {
      error.value = result.error;
      return;
    }
    emit('role-updated', selectedRole.value);
    emit('close');
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to update role';
  } finally {
    isUpdating.value = false;
  }
}
</script>

<style lang="scss" scoped>
.modal-overlay {
  background-color: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px);
}

.modal-content {
  background-color: var(--matou-card);
}

.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.2s ease;
  .modal-content {
    transition: transform 0.2s ease;
  }
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
  .modal-content {
    transform: scale(0.95);
  }
}
</style>
```

**Step 2: Commit**

```bash
git add frontend/src/components/dashboard/ChangeRoleModal.vue
git commit -m "feat: add ChangeRoleModal component"
```

---

### Task 9: Add Role Display and Edit Trigger to ProfileModal

**Files:**
- Modify: `frontend/src/components/profiles/ProfileModal.vue`

**Step 1: Add role display after the member name/date section**

After the AID display block (around line 46, after `</div>` that closes the AID section), add a role display section:

```vue
                <!-- Role (clickable for stewards) -->
                <div v-if="memberRole" class="mt-2 flex items-center gap-2">
                  <span
                    class="inline-flex items-center px-2.5 py-1 text-xs font-medium rounded-full"
                    :class="canChangeRole ? 'bg-primary/15 text-primary cursor-pointer hover:bg-primary/25 transition-colors' : 'bg-secondary text-black/70'"
                    @click="canChangeRole && (showChangeRole = true)"
                  >
                    {{ memberRole }}
                    <Pencil v-if="canChangeRole" class="w-3 h-3 ml-1.5 opacity-60" />
                  </span>
                </div>
```

**Step 2: Add the ChangeRoleModal integration**

After the `</Teleport>` closing tag (end of template), NO — instead add it inside the template, just before the closing `</div>` of `modal-content` (before line 327 `</div>`):

Actually, add it as a sibling Teleport. After the main `</Teleport>` closing tag, add:

```vue
  <!-- Change Role Modal -->
  <ChangeRoleModal
    :show="showChangeRole"
    :memberName="profileName"
    :memberAid="profileAid"
    :currentRole="memberRole"
    @close="showChangeRole = false"
    @role-updated="handleRoleUpdated"
  />
```

**Step 3: Update script imports**

Add to imports:

```typescript
import { Pencil } from 'lucide-vue-next';
import ChangeRoleModal from 'src/components/dashboard/ChangeRoleModal.vue';
```

**Step 4: Add props for role management**

Add to Props interface:

```typescript
  canChangeRole?: boolean;
```

Add to withDefaults:

```typescript
  canChangeRole: false,
```

**Step 5: Add computed and state**

Add after existing computed properties:

```typescript
const memberRole = computed(() => (props.communityProfile?.role as string) || '');
const showChangeRole = ref(false);

function handleRoleUpdated(newRole: string) {
  emit('role-updated', newRole);
}
```

**Step 6: Add emit**

Add to emit definitions:

```typescript
  (e: 'role-updated', role: string): void;
```

**Step 7: Reset state on modal close**

In the existing `watch(() => props.show, ...)` block, add:

```typescript
    showChangeRole.value = false;
```

**Step 8: Commit**

```bash
git add frontend/src/components/profiles/ProfileModal.vue
git commit -m "feat: add role display and edit trigger to ProfileModal"
```

---

### Task 10: Wire Up DashboardPage for Role Updates

**Files:**
- Modify: `frontend/src/pages/DashboardPage.vue`

**Step 1: Pass `canChangeRole` prop to ProfileModal**

Find the ProfileModal usage (around line 156) and add the prop:

```vue
      :canChangeRole="canManageMembers"
```

**Step 2: Import `canManageMembers` from `useAdminAccess`**

Update the destructured import (around line 205):

```typescript
const { isSteward, canManageMembers, checkAdminStatus } = useAdminAccess();
```

**Step 3: Add `@role-updated` handler to ProfileModal**

```vue
      @role-updated="handleRoleUpdated"
```

**Step 4: Add handler function**

```typescript
function handleRoleUpdated(newRole: string) {
  // Update the community profile role in local state
  if (selectedMember.value?.community) {
    (selectedMember.value.community as Record<string, unknown>).role = newRole;
  }
  // Refresh members to pick up the change from any-sync
  profileStore.refreshProfiles();
}
```

**Step 5: Commit**

```bash
git add frontend/src/pages/DashboardPage.vue
git commit -m "feat: wire up role update from DashboardPage"
```

---

### Task 11: Build Verification and Final Test

**Step 1: Run backend tests**

Run: `cd backend && make test`
Expected: All tests pass.

**Step 2: Run backend lint**

Run: `cd backend && make lint`
Expected: No lint errors.

**Step 3: Run frontend lint**

Run: `cd frontend && npm run lint`
Expected: No lint errors.

**Step 4: Run frontend build**

Run: `cd frontend && npm run build`
Expected: Build succeeds.

**Step 5: Commit any fixes**

If any lint/build issues, fix and commit.
