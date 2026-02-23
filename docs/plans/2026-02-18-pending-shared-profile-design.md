# Pending SharedProfile on Registration — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Auto-create a SharedProfile with status `"pending"` when an admin receives a registration application, then update status to `"approved"` or `"declined"` on admin action.

**Architecture:** Add a `status` field to SharedProfile type definition. The admin's frontend creates the pending profile via the existing `POST /api/v1/profiles` endpoint during registration polling. The existing `init-member` backend handler and the `declineRegistration` frontend action update the status on approval/decline.

**Tech Stack:** Go (backend type definition + handler), TypeScript/Vue (frontend composables + store)

---

### Task 1: Add `status` field to SharedProfile type definition

**Files:**
- Modify: `backend/internal/types/profiles.go:42-126` (SharedProfileType function)

**Step 1: Add the status field**

In `SharedProfileType()`, add a new field after `aid` and before `publicPeerSignkey`:

```go
{Name: "status", Type: "string", Required: true,
    Validation: &Validation{Enum: []string{"pending", "approved", "declined"}},
    UIHints:    &UIHints{DisplayFormat: "badge", Label: "Status", Section: "membership"}},
```

**Step 2: Add `status` to layouts**

Update the `card` layout to include `status`:
```go
"card":   {Fields: []string{"avatar", "displayName", "status"}},
```

Update the `detail` layout to include `status` (after `displayName`):
```go
"detail": {Fields: []string{"avatar", "displayName", "status", "bio", "location", ...}},
```

**Step 3: Verify backend builds**

Run: `cd /home/benz/Documents/1.projects/matou-app/backend && make build`
Expected: Build succeeds with no errors.

**Step 4: Commit**

```bash
git add backend/internal/types/profiles.go
git commit -m "feat: add status field to SharedProfile type definition"
```

---

### Task 2: Set `status: "approved"` in `HandleInitMemberProfiles`

**Files:**
- Modify: `backend/internal/api/profiles.go:560-583` (sharedProfileData map in HandleInitMemberProfiles)

**Step 1: Add status to sharedProfileData**

In `HandleInitMemberProfiles()`, find the `sharedProfileData` map (around line 562) and add `"status": "approved"`:

```go
sharedProfileData := map[string]interface{}{
    "aid":                    req.MemberAID,
    "status":                 "approved",
    "displayName":            req.DisplayName,
    // ... rest unchanged
}
```

**Step 2: Verify backend builds**

Run: `cd /home/benz/Documents/1.projects/matou-app/backend && make build`
Expected: Build succeeds.

**Step 3: Commit**

```bash
git add backend/internal/api/profiles.go
git commit -m "feat: set status approved in init-member SharedProfile creation"
```

---

### Task 3: Create pending SharedProfile during registration polling

**Files:**
- Modify: `frontend/src/composables/useRegistrationPolling.ts`

**Step 1: Add import for `createOrUpdateProfile` and `getProfiles`**

At the top of the file, add:

```typescript
import { createOrUpdateProfile, getProfiles } from 'src/lib/api/client';
```

**Step 2: Add a Set to track created pending profiles**

Inside `useRegistrationPolling()`, next to the existing `processedApplicantAids` Set (line 91), add:

```typescript
// Track applicants for whom we've already created a pending SharedProfile
const createdPendingProfiles = new Set<string>();
```

**Step 3: Add function to create pending SharedProfiles**

After the `removeRegistration` function (around line 490), add:

```typescript
/**
 * Create pending SharedProfiles for new registrations.
 * Called after polling detects new registrations.
 * Idempotent: checks existing profiles and local tracking set.
 */
async function createPendingProfiles(registrations: PendingRegistration[]): Promise<void> {
  if (registrations.length === 0) return;

  // Load existing SharedProfiles to check which applicants already have one
  let existingAids: Set<string>;
  try {
    const existing = await getProfiles('SharedProfile');
    existingAids = new Set(
      existing
        .map(p => p.data.aid as string)
        .filter(Boolean)
    );
  } catch {
    console.warn('[RegistrationPolling] Failed to load existing SharedProfiles, skipping pending profile creation');
    return;
  }

  for (const reg of registrations) {
    if (!reg.applicantAid) continue;
    if (existingAids.has(reg.applicantAid)) continue;
    if (createdPendingProfiles.has(reg.applicantAid)) continue;

    const profileId = `SharedProfile-${reg.applicantAid}`;
    const now = new Date().toISOString();
    const profileData: Record<string, unknown> = {
      aid: reg.applicantAid,
      status: 'pending',
      displayName: reg.profile.name || 'Unknown',
      bio: reg.profile.bio || '',
      avatar: reg.profile.avatarFileRef || '',
      location: reg.profile.location || '',
      joinReason: reg.profile.joinReason || '',
      indigenousCommunity: reg.profile.indigenousCommunity || '',
      participationInterests: reg.profile.interests || [],
      customInterests: reg.profile.customInterests || '',
      facebookUrl: reg.profile.facebookUrl || '',
      linkedinUrl: reg.profile.linkedinUrl || '',
      twitterUrl: reg.profile.twitterUrl || '',
      instagramUrl: reg.profile.instagramUrl || '',
      githubUrl: reg.profile.githubUrl || '',
      gitlabUrl: reg.profile.gitlabUrl || '',
      publicEmail: reg.profile.email || '',
      createdAt: now,
      updatedAt: now,
      typeVersion: 1,
    };

    try {
      const result = await createOrUpdateProfile('SharedProfile', profileData, { id: profileId });
      if (result.success) {
        createdPendingProfiles.add(reg.applicantAid);
        console.log(`[RegistrationPolling] Created pending SharedProfile for ${reg.applicantAid.slice(0, 12)}...`);
      } else {
        console.warn(`[RegistrationPolling] Failed to create pending SharedProfile: ${result.error}`);
      }
    } catch (err) {
      console.warn(`[RegistrationPolling] Error creating pending SharedProfile:`, err);
    }
  }
}
```

**Step 4: Call `createPendingProfiles` at end of `pollForRegistrations`**

In `pollForRegistrations()`, just before `lastPollTime.value = new Date();` (around line 417), add:

```typescript
// Create pending SharedProfiles for new registrations
await createPendingProfiles(filtered);
```

**Step 5: Verify frontend builds**

Run: `cd /home/benz/Documents/1.projects/matou-app/frontend && npm run lint`
Expected: No errors.

**Step 6: Commit**

```bash
git add frontend/src/composables/useRegistrationPolling.ts
git commit -m "feat: auto-create pending SharedProfile when registration detected"
```

---

### Task 4: Update SharedProfile status on decline

**Files:**
- Modify: `frontend/src/composables/useAdminActions.ts`

**Step 1: Add `createOrUpdateProfile` to imports**

The import from `src/lib/api/client` already exists (line 10). Add `createOrUpdateProfile` if not already there:

```typescript
import { BACKEND_URL, createOrUpdateProfile, initMemberProfiles, sendRegistrationApprovedNotification } from 'src/lib/api/client';
```

**Step 2: Update SharedProfile status to "declined" after sending decline EXN**

In `declineRegistration()`, after `markAllApplicantNotificationsRead` (around line 380) and before setting `lastAction`, add:

```typescript
// Update SharedProfile status to declined
const profileId = `SharedProfile-${registration.applicantAid}`;
try {
  await createOrUpdateProfile('SharedProfile', { status: 'declined' }, { id: profileId });
  console.log('[AdminActions] Updated SharedProfile status to declined for:', registration.applicantAid);
} catch (profileErr) {
  console.warn('[AdminActions] Failed to update SharedProfile status to declined:', profileErr);
}
```

**Step 3: Verify frontend builds**

Run: `cd /home/benz/Documents/1.projects/matou-app/frontend && npm run lint`
Expected: No errors.

**Step 4: Commit**

```bash
git add frontend/src/composables/useAdminActions.ts
git commit -m "feat: update SharedProfile status to declined on registration decline"
```

---

### Task 5: Verify approve flow sets status correctly

**Files:**
- Review only: `frontend/src/composables/useAdminActions.ts` and `backend/internal/api/profiles.go`

The approve flow already works correctly:

1. `approveRegistration()` calls `initMemberProfiles()`
2. `HandleInitMemberProfiles` builds `sharedProfileData` with `"status": "approved"` (added in Task 2)
3. It calls `objMgr.AddObject()` with object ID `SharedProfile-{memberAid}`
4. Since the pending profile already exists with that ID, `AddObject` performs an incremental update (diff), updating the status from `"pending"` to `"approved"` along with any other fields

**Step 1: Verify the full flow manually**

No code changes needed. This task is a verification checkpoint:
- Start dev backend: `cd backend && make run`
- Confirm the approve path writes `status: "approved"` by checking backend logs for the SharedProfile creation/update

**Step 2: Commit (no changes, just a checkpoint)**

No commit needed for this task.

---

### Task 6: Run backend tests

**Step 1: Run unit tests**

Run: `cd /home/benz/Documents/1.projects/matou-app/backend && make test`
Expected: All tests pass. The `status` field addition is backward-compatible (existing profiles without `status` will simply not have the field).

**Step 2: Run lint**

Run: `cd /home/benz/Documents/1.projects/matou-app/backend && make lint`
Expected: No lint errors.

---

### Task 7: Run frontend lint

**Step 1: Run ESLint**

Run: `cd /home/benz/Documents/1.projects/matou-app/frontend && npm run lint`
Expected: No errors.

**Step 2: Run unit tests**

Run: `cd /home/benz/Documents/1.projects/matou-app/frontend && npm run test:script`
Expected: All tests pass.
