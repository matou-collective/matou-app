# Event Attendance Credential Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow admin/steward hosts to issue event attendance credentials to pending applicants, fulfilling the 4th membership requirement (Whakawhanaungatanga session attendance).

**Architecture:** New KERI credential schema + issuance composable (mirrors endorsement pattern) + credential polling detection + ProfileModal UI button. The host issues the credential from their personal registry with an edge to their membership credential.

**Tech Stack:** KERI/KERIA (signify-ts), Vue 3 composables, Pinia stores, JSON Schema (SAID-based)

---

### Task 1: Create the Event Attendance Schema

**Files:**
- Create: `backend/schemas/matou-event-attendance-schema.json`

**Step 1: Write the schema JSON**

Create `backend/schemas/matou-event-attendance-schema.json` with a placeholder `$id` (will be SAIDified):

```json
{
    "$id": "",
    "$schema": "http://json-schema.org/draft-07/schema#",
    "title": "MATOU Event Attendance Credential",
    "description": "A credential proving attendance at a community event such as a Whakawhanaungatanga session",
    "type": "object",
    "credentialType": "MatouEventAttendanceCredential",
    "version": "1.0.0",
    "properties": {
        "v": { "description": "Version string", "type": "string" },
        "d": { "description": "Credential SAID", "type": "string" },
        "u": { "description": "One time use nonce", "type": "string" },
        "i": { "description": "Host AID (issuer)", "type": "string" },
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
                        "i": { "description": "Attendee AID (credential recipient)", "type": "string" },
                        "dt": { "description": "Issuance date-time", "type": "string", "format": "date-time" },
                        "eventType": {
                            "description": "Type of event attended",
                            "type": "string",
                            "enum": ["community_onboarding", "project_onboarding"]
                        },
                        "eventName": {
                            "description": "Name of the event",
                            "type": "string"
                        },
                        "sessionDate": {
                            "description": "Actual date/time of the session attended",
                            "type": "string",
                            "format": "date-time"
                        }
                    },
                    "additionalProperties": false,
                    "required": ["d", "i", "dt", "eventType", "eventName", "sessionDate"]
                }
            ]
        },
        "e": {
            "description": "Edge section linking to the host's membership credential, proving their authority as a verified community member",
            "oneOf": [
                { "description": "Edge block SAID", "type": "string" },
                {
                    "description": "Edge block",
                    "type": "object",
                    "properties": {
                        "d": { "description": "Edge block SAID", "type": "string" },
                        "hostMembership": {
                            "description": "Reference to the host's own membership credential",
                            "type": "object",
                            "properties": {
                                "n": { "description": "SAID of the host's membership credential", "type": "string" },
                                "s": { "description": "Schema SAID of the membership credential", "type": "string" }
                            },
                            "required": ["n", "s"]
                        }
                    },
                    "additionalProperties": false,
                    "required": ["d", "hostMembership"]
                }
            ]
        }
    },
    "additionalProperties": false,
    "required": ["v", "d", "i", "ri", "s", "a"]
}
```

**Step 2: SAIDify the schema**

Requires KERI infrastructure running (`cd ../matou-infrastructure/keri && make up`).

```bash
cat backend/schemas/matou-event-attendance-schema.json | \
  docker exec -i matou-keri-keria-1 tee /tmp/schema.json > /dev/null && \
  docker exec matou-keri-keria-1 kli saidify --file /tmp/schema.json --label '$id' && \
  docker exec matou-keri-keria-1 cat /tmp/schema.json | python3 -m json.tool > backend/schemas/matou-event-attendance-schema.json
```

Expected: The `$id` field is populated with a SAID starting with `E`.

**Step 3: Restart schema server to load new schema**

```bash
cd ../matou-infrastructure/keri && make restart
```

**Step 4: Verify schema is served**

```bash
# Get the SAID from the schema file
SAID=$(python3 -c "import json; print(json.load(open('backend/schemas/matou-event-attendance-schema.json'))['\\$id'])")
curl -s http://localhost:7723/oobi/$SAID | python3 -m json.tool
```

Expected: Returns the schema JSON.

**Step 5: Commit**

```bash
git add backend/schemas/matou-event-attendance-schema.json
git commit -m "feat: add event attendance credential schema"
```

---

### Task 2: Export EVENT_ATTENDANCE_SCHEMA_SAID Constant

**Files:**
- Modify: `frontend/src/composables/useAdminActions.ts:14-15`

**Step 1: Add the new constant**

After the existing SAID exports at lines 14-15 of `useAdminActions.ts`, add:

```typescript
export const MEMBERSHIP_SCHEMA_SAID = 'EOVL3N0K_tYc9U-HXg7r2jDPo4Gnq3ebCjDqbJzl6fsT';
export const ENDORSEMENT_SCHEMA_SAID = 'EIefouRuIuoi9ZtnW3BOCSVeXQSt8k3uJLvmYHfvNPOE';
export const EVENT_ATTENDANCE_SCHEMA_SAID = '<SAID from Task 1 step 2>';  // ← add this
```

Replace `<SAID from Task 1 step 2>` with the actual SAID generated during SAIDification.

**Step 2: Commit**

```bash
git add frontend/src/composables/useAdminActions.ts
git commit -m "feat: export EVENT_ATTENDANCE_SCHEMA_SAID constant"
```

---

### Task 3: Create useEventAttendance Composable

**Files:**
- Create: `frontend/src/composables/useEventAttendance.ts`

**Step 1: Write the composable**

Model after `frontend/src/composables/useEndorsements.ts`. Key differences:
- Uses `EVENT_ATTENDANCE_SCHEMA_SAID` instead of `ENDORSEMENT_SCHEMA_SAID`
- Credential data has `eventType`, `eventName`, `sessionDate` (not endorsement fields)
- Edge key is `hostMembership` (not `endorserMembership`)
- SharedProfile update stores an `attendanceRecord` (not endorsements array)

```typescript
/**
 * Composable for issuing event attendance credentials.
 * Admin/steward hosts issue these to applicants who attended a session.
 */
import { ref } from 'vue';
import { useKERIClient } from 'src/lib/keri/client';
import { useIdentityStore } from 'stores/identity';
import { useProfilesStore } from 'stores/profiles';
import { createOrUpdateProfile } from 'src/lib/api/client';
import { EVENT_ATTENDANCE_SCHEMA_SAID, MEMBERSHIP_SCHEMA_SAID } from './useAdminActions';

const SCHEMA_SERVER_URL = 'http://schema-server:7723';
const EVENT_ATTENDANCE_SCHEMA_OOBI = `${SCHEMA_SERVER_URL}/oobi/${EVENT_ATTENDANCE_SCHEMA_SAID}`;

export interface AttendanceRecord {
  hostAid: string;
  hostName: string;
  credentialSaid: string;
  eventType: string;
  eventName: string;
  sessionDate: string;
  issuedAt: string;
}

export function useEventAttendance() {
  const keriClient = useKERIClient();
  const identityStore = useIdentityStore();
  const profilesStore = useProfilesStore();

  const isMarking = ref(false);
  const error = ref<string | null>(null);

  /**
   * Get or create a personal registry for the current member.
   * Reuses the same registry naming pattern as endorsements.
   */
  async function getOrCreatePersonalRegistry(): Promise<string> {
    const client = keriClient.getSignifyClient();
    if (!client) throw new Error('Not connected to KERIA');

    const myAid = identityStore.currentAID;
    if (!myAid) throw new Error('No identity found');

    const registryName = `${myAid.prefix.slice(0, 12)}-endorsements`;

    const registries = await client.registries().list(myAid.prefix);
    const existing = registries.find(
      (r: { name: string }) => r.name === registryName
    );
    if (existing) {
      console.log('[EventAttendance] Found existing registry:', existing.regk);
      return existing.regk;
    }

    console.log('[EventAttendance] Creating personal registry...');
    const registryId = await keriClient.createRegistry(myAid.prefix, registryName);
    console.log('[EventAttendance] Created registry:', registryId);
    return registryId;
  }

  /**
   * Issue an event attendance credential to a pending applicant.
   */
  async function markAttended(
    applicantAid: string,
    applicantOOBI?: string,
    sessionDate?: string,
  ): Promise<boolean> {
    if (isMarking.value) return false;
    isMarking.value = true;
    error.value = null;

    try {
      const myAid = identityStore.currentAID;
      if (!myAid) throw new Error('No identity found');

      // 1. Get or create host's personal registry
      const registryId = await getOrCreatePersonalRegistry();

      // 2. Resolve event attendance schema OOBI
      await keriClient.resolveOOBI(EVENT_ATTENDANCE_SCHEMA_OOBI, EVENT_ATTENDANCE_SCHEMA_SAID, 15000);

      // 3. Resolve applicant OOBI
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
      if (!resolved) throw new Error('Could not resolve applicant identity');

      // 4. Look up host's own membership credential (for the edge)
      const client = keriClient.getSignifyClient();
      if (!client) throw new Error('Not connected to KERIA');
      const allCreds = await client.credentials().list();
      const membershipCred = allCreds.find(
        (c: { sad?: { s?: string } }) => c.sad?.s === MEMBERSHIP_SCHEMA_SAID
      );
      if (!membershipCred?.sad?.d) {
        throw new Error('Could not find your membership credential. You must be an admitted member to mark attendance.');
      }
      console.log('[EventAttendance] Found host membership credential:', membershipCred.sad.d);

      // 5. Issue event attendance credential
      const now = new Date().toISOString();
      const credentialData = {
        dt: now,
        eventType: 'community_onboarding',
        eventName: 'Whakawhanaungatanga Session',
        sessionDate: sessionDate || now,
      };

      const edgeData = {
        d: '', // SAID placeholder — computed by KERIA
        hostMembership: {
          n: membershipCred.sad.d,
          s: MEMBERSHIP_SCHEMA_SAID,
        },
      };

      const credResult = await keriClient.issueCredential(
        myAid.prefix,
        registryId,
        EVENT_ATTENDANCE_SCHEMA_SAID,
        applicantAid,
        credentialData,
        undefined, // grantMessage
        edgeData,
      );

      // 6. Update SharedProfile with attendance record
      const attendance: AttendanceRecord = {
        hostAid: myAid.prefix,
        hostName: myAid.name || 'Unknown',
        credentialSaid: credResult.said,
        eventType: 'community_onboarding',
        eventName: 'Whakawhanaungatanga Session',
        sessionDate: sessionDate || now,
        issuedAt: now,
      };

      const profileId = `SharedProfile-${applicantAid}`;
      const currentProfile = profilesStore.communityProfiles.find(p => {
        const data = (p.data as Record<string, unknown>) || {};
        return data.aid === applicantAid || (p.id as string)?.includes(applicantAid);
      });
      const currentData = (currentProfile?.data as Record<string, unknown>) || {};

      await createOrUpdateProfile(
        'SharedProfile',
        {
          ...currentData,
          attendanceRecord: attendance,
        },
        { id: profileId },
      );

      // 7. Refresh profiles
      await profilesStore.loadCommunityProfiles();

      return true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error('[EventAttendance] Mark attended failed:', err);
      error.value = errorMsg;
      return false;
    } finally {
      isMarking.value = false;
    }
  }

  /**
   * Check if the current user has already marked this applicant as attended.
   */
  function hasMarkedAttended(applicantAid: string): boolean {
    const myAid = identityStore.currentAID?.prefix;
    if (!myAid) return false;
    const profile = profilesStore.communityProfiles.find(p => {
      const data = (p.data as Record<string, unknown>) || {};
      return data.aid === applicantAid || (p.id as string)?.includes(applicantAid);
    });
    if (!profile) return false;
    const data = (profile.data as Record<string, unknown>) || {};
    const record = data.attendanceRecord as AttendanceRecord | undefined;
    return !!record && record.hostAid === myAid;
  }

  function clearError() {
    error.value = null;
  }

  return {
    isMarking,
    error,
    markAttended,
    hasMarkedAttended,
    clearError,
  };
}
```

**Step 2: Verify no TypeScript errors**

```bash
cd frontend && npx tsc --noEmit --pretty 2>&1 | head -30
```

Expected: No errors related to `useEventAttendance.ts`.

**Step 3: Commit**

```bash
git add frontend/src/composables/useEventAttendance.ts
git commit -m "feat: add useEventAttendance composable for session attendance credentials"
```

---

### Task 4: Add Event Attendance Detection to Credential Polling

**Files:**
- Modify: `frontend/src/composables/useCredentialPolling.ts:43-44,80,271-283`

**Step 1: Add the schema SAID constant**

At line 44 of `useCredentialPolling.ts`, after the existing SAID constants, add:

```typescript
  const MEMBERSHIP_SCHEMA_SAID = 'EOVL3N0K_tYc9U-HXg7r2jDPo4Gnq3ebCjDqbJzl6fsT';
  const ENDORSEMENT_SCHEMA_SAID = 'EIefouRuIuoi9ZtnW3BOCSVeXQSt8k3uJLvmYHfvNPOE';
  const EVENT_ATTENDANCE_SCHEMA_SAID = '<SAID from Task 1>';  // ← add this
```

**Step 2: Update the placeholder comment**

Change line 80 from:
```typescript
  const sessionAttendanceVerified = ref(false); // Placeholder — no event attendance schema yet
```
to:
```typescript
  const sessionAttendanceVerified = ref(false);
```

**Step 3: Add event attendance detection in the IPEX grant processing**

Find the section around line 271-283 where endorsement credentials are detected. After that `else if` block, add a new `else if` for event attendance:

```typescript
              } else if (schema === EVENT_ATTENDANCE_SCHEMA_SAID && recipient === myAid) {
                // Event attendance credential issued TO us
                const credSaid = (sad as any).d || '';
                console.log('[CredentialPolling] Event attendance credential found:', credSaid);
                sessionAttendanceVerified.value = true;
              }
```

**Step 4: Verify no TypeScript errors**

```bash
cd frontend && npx tsc --noEmit --pretty 2>&1 | head -30
```

**Step 5: Commit**

```bash
git add frontend/src/composables/useCredentialPolling.ts
git commit -m "feat: detect event attendance credentials in polling"
```

---

### Task 5: Add "Mark Attended" Button to ProfileModal

**Files:**
- Modify: `frontend/src/components/profiles/ProfileModal.vue:226-263,326-363`

**Step 1: Add new props**

In the `Props` interface (line 326), add after `isEndorsing`:

```typescript
  hasMarkedAttended?: boolean;
  isMarkingAttended?: boolean;
```

In the `withDefaults` (line 346), add:

```typescript
  hasMarkedAttended: false,
  isMarkingAttended: false,
```

**Step 2: Add new emit**

In the `defineEmits` (line 359), add:

```typescript
  (e: 'mark-attended'): void;
```

**Step 3: Add the "Mark Attended" button in the action buttons area**

In the main action buttons `div` (line 226), add a "Mark Attended" button **before** the Endorse button. The button should be visible only to stewards and only for pending profiles:

Between line 226 (`<div v-if="!showDeclineReason && !showEndorseMessage" ...>`) and line 227 (the endorse `<button>`), insert:

```html
              <!-- Mark Attended button (steward only) -->
              <button
                v-if="props.isSteward && !props.hasMarkedAttended"
                @click="emit('mark-attended')"
                class="flex-1 px-4 py-2.5 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors"
                :disabled="isProcessing || props.isMarkingAttended"
              >
                <Loader2 v-if="props.isMarkingAttended" class="w-4 h-4 inline mr-2 animate-spin" />
                <CalendarCheck v-else class="w-4 h-4 inline mr-2" />
                Mark Attended
              </button>
              <button
                v-else-if="props.isSteward && props.hasMarkedAttended"
                class="flex-1 px-4 py-2.5 text-sm rounded-lg bg-blue-600/20 text-blue-600 cursor-default"
                disabled
              >
                <CalendarCheck class="w-4 h-4 inline mr-2" />
                Attended
              </button>
```

**Step 4: Add CalendarCheck icon import**

At line 312, add `CalendarCheck` to the lucide-vue-next import:

```typescript
import { X, Check, Copy, Loader2, ThumbsUp, CalendarCheck } from 'lucide-vue-next';
```

**Step 5: Commit**

```bash
git add frontend/src/components/profiles/ProfileModal.vue
git commit -m "feat: add Mark Attended button to ProfileModal"
```

---

### Task 6: Wire Up Event Attendance in DashboardPage

**Files:**
- Modify: `frontend/src/pages/DashboardPage.vue:128-144,163,186-193,371-378`

**Step 1: Import the composable**

At line 163, add:

```typescript
import { useEventAttendance } from 'src/composables/useEventAttendance';
```

**Step 2: Destructure the composable**

After the `useEndorsements()` destructure block (lines 186-193), add:

```typescript
const {
  isMarking: isMarkingAttended,
  error: attendanceError,
  markAttended,
  hasMarkedAttended,
  clearError: clearAttendanceError,
} = useEventAttendance();
```

**Step 3: Add computed for selected member attendance status**

Near the existing `selectedMemberHasEndorsed` computed, add:

```typescript
const selectedMemberHasAttended = computed(() => {
  const aid = selectedMember.value?.shared?.aid as string;
  if (!aid) return false;
  return hasMarkedAttended(aid);
});
```

**Step 4: Add handler function**

After the `handleEndorse` function (lines 371-378), add:

```typescript
async function handleMarkAttended() {
  clearAttendanceError();
  const aid = selectedMember.value?.shared?.aid as string;
  if (!aid) return;
  const registration = selectedMemberRegistration.value;
  const oobi = registration?.applicantOOBI;
  await markAttended(aid, oobi);
}
```

**Step 5: Pass new props and event to ProfileModal**

Update the `<ProfileModal>` template (lines 128-144) to include:

```html
      :hasMarkedAttended="selectedMemberHasAttended"
      :isMarkingAttended="isMarkingAttended"
      @mark-attended="handleMarkAttended"
```

Also update the `:error` prop to include `attendanceError`:

```html
      :error="actionError || endorseError || attendanceError"
```

**Step 6: Verify no TypeScript errors**

```bash
cd frontend && npx tsc --noEmit --pretty 2>&1 | head -30
```

**Step 7: Commit**

```bash
git add frontend/src/pages/DashboardPage.vue
git commit -m "feat: wire up event attendance in DashboardPage"
```

---

### Task 7: Manual Integration Test

**Prerequisites:** KERI infrastructure running, backend in test mode, two user accounts (admin + applicant).

**Step 1: Start test environment**

```bash
cd frontend && npm run health:test
```

**Step 2: Test the flow**

1. Register a new applicant
2. As admin, open the applicant's ProfileModal
3. Verify "Mark Attended" button is visible
4. Click "Mark Attended" — should issue credential and button should change to "Attended" (disabled)
5. On the applicant side, verify the "Whakawhanaunga" requirement card lights up (green)
6. Verify all 4 requirements must be met before "Admit" works

**Step 3: Verify credential in KERIA**

```bash
# Check the credential was created (replace AID)
curl -s http://localhost:4901/credentials | python3 -m json.tool | grep eventType
```

Expected: Shows `"eventType": "community_onboarding"`.
