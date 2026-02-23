# Multisig Steward Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When admin upgrades a member to Founding Member or Community Steward, add their AID to the org group AID via KERI multisig rotation so they can issue credentials and see registration notifications.

**Architecture:** The org AID is already a group AID with threshold 1. We add a `addMemberToGroup()` method to KERIClient that performs the two-rotation KERI protocol. On the steward's side, a new `useMultisigJoin` composable polls for `/multisig/rot` notifications and auto-joins. ChangeRoleModal triggers the rotation after the role API call. useAdminAccess gains an org-membership check.

**Tech Stack:** signify-ts (identifiers().rotate, groups().join, exchanges(), keyStates()), Vue 3 composables, KERI/KERIA

---

### Task 1: Add `addMemberToGroup()` to KERIClient

**Files:**
- Modify: `frontend/src/lib/keri/client.ts` (after `createGroupAID` at line ~807)

**Step 1: Add the method after `createGroupAID()`**

Add this method to the KERIClient class. It performs the two-rotation KERI protocol to add a new member's AID to an existing group AID:

```typescript
/**
 * Add a member's AID to an existing group AID via two-rotation protocol.
 * Rotation 1: adds member to rstates (next keys)
 * Rotation 2: promotes member to states (signing keys)
 * Then sends /multisig/rot EXN notification to the new member.
 *
 * @param groupName - Name of the group AID (e.g., "matou-dao")
 * @param newMemberAidPrefix - AID prefix of the member to add
 * @param masterAidName - Name of the admin's personal AID (master controller)
 */
async addMemberToGroup(
  groupName: string,
  newMemberAidPrefix: string,
  masterAidName: string,
): Promise<void> {
  if (!this.client) throw new Error('Not initialized');

  console.log(`[KERIClient] Adding ${newMemberAidPrefix.slice(0, 12)}... to group "${groupName}"`);

  // 1. Get current group AID state
  const groupAid = await this.client.identifiers().get(groupName);
  console.log(`[KERIClient] Group AID: ${groupAid.prefix}, seq: ${groupAid.state?.s}`);

  // 2. Get master AID (admin's personal AID)
  const masterAid = await this.client.identifiers().get(masterAidName);

  // 3. Query the new member's key state (must have resolved their OOBI first)
  console.log(`[KERIClient] Querying key state for ${newMemberAidPrefix.slice(0, 12)}...`);
  const queryOp = await this.client.keyStates().query(newMemberAidPrefix, undefined, undefined);
  const ksResult = await this.client.operations().wait(queryOp, { signal: AbortSignal.timeout(30000) });
  const newMemberState = ksResult.response;
  console.log(`[KERIClient] Got key state for new member, seq: ${newMemberState?.s}`);

  // 4. Also refresh master's key state
  const masterQueryOp = await this.client.keyStates().query(masterAid.prefix, undefined, undefined);
  const masterKsResult = await this.client.operations().wait(masterQueryOp, { signal: AbortSignal.timeout(30000) });
  const masterState = masterKsResult.response;

  // 5. Rotation 1: Add new member to rstates only (next keys)
  console.log('[KERIClient] Rotation 1: adding member to next rotation keys...');
  const states1 = [masterState];
  const rstates1 = [masterState, newMemberState];

  const rot1Result = await this.client.identifiers().rotate(groupName, {
    states: states1,
    rstates: rstates1,
  });
  const rot1Op = await rot1Result.op();
  await this.client.operations().wait(rot1Op, { signal: AbortSignal.timeout(60000) });
  console.log('[KERIClient] Rotation 1 complete');

  // 6. Rotation 2: Promote new member to signing keys
  console.log('[KERIClient] Rotation 2: promoting member to signing keys...');
  const states2 = [masterState, newMemberState];
  const rstates2 = [masterState, newMemberState];

  const rot2Result = await this.client.identifiers().rotate(groupName, {
    states: states2,
    rstates: rstates2,
  });
  const rot2Serder = rot2Result.serder;
  const rot2Sigs = rot2Result.sigs;
  const rot2Op = await rot2Result.op();
  await this.client.operations().wait(rot2Op, { signal: AbortSignal.timeout(60000) });
  console.log('[KERIClient] Rotation 2 complete');

  // 7. Send /multisig/rot EXN to new member so they can join
  console.log('[KERIClient] Sending /multisig/rot notification to new member...');
  const smids = states2.map((s: { i: string }) => s.i);
  const rmids = rstates2.map((s: { i: string }) => s.i);

  try {
    await this.client.exchanges().send(
      masterAidName,
      groupName,
      masterAid,
      '/multisig/rot',
      { gid: groupAid.prefix, smids, rmids },
      { rot: [rot2Serder.sad, rot2Sigs] },
      [newMemberAidPrefix],
    );
    console.log('[KERIClient] /multisig/rot EXN sent to new member');
  } catch (exnErr) {
    console.warn('[KERIClient] Failed to send /multisig/rot EXN:', exnErr);
    // Non-fatal: the steward can still join if they detect the group rotation
    // through other means (e.g., OOBI re-resolution)
  }

  // 8. Add agent end role for updated group AID
  const agentId = this.client.agent?.pre;
  if (agentId) {
    try {
      const endRoleResult = await this.client.identifiers().addEndRole(groupAid.prefix, 'agent', agentId);
      const endRoleOp = await endRoleResult.op();
      await this.client.operations().wait(endRoleOp, { signal: AbortSignal.timeout(30000) });
      console.log('[KERIClient] Agent end role refreshed for group AID');
    } catch (err) {
      console.warn('[KERIClient] Failed to refresh agent end role:', err);
    }
  }

  console.log(`[KERIClient] Member ${newMemberAidPrefix.slice(0, 12)}... added to group "${groupName}"`);
}
```

**Step 2: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit --skipLibCheck 2>&1 | head -20`
Expected: No new errors from client.ts

**Step 3: Commit**

```bash
git add frontend/src/lib/keri/client.ts
git commit -m "feat: add addMemberToGroup() for KERI multisig rotation"
```

---

### Task 2: Add `joinGroup()` to KERIClient

**Files:**
- Modify: `frontend/src/lib/keri/client.ts` (after `addMemberToGroup`)

**Step 1: Add the joinGroup method**

This method processes a `/multisig/rot` notification and calls `groups().join()`:

```typescript
/**
 * Join an existing group AID after receiving a /multisig/rot notification.
 * Called by a new member being added to the group.
 *
 * @param groupName - Local alias for the group AID
 * @param notificationSaid - SAID from the /multisig/rot notification
 * @returns The group AID prefix
 */
async joinGroup(groupName: string, notificationSaid: string): Promise<string> {
  if (!this.client) throw new Error('Not initialized');

  console.log(`[KERIClient] Joining group via notification ${notificationSaid.slice(0, 12)}...`);

  // 1. Get the rotation event from the notification
  const response = await this.client.groups().getRequest(notificationSaid);
  if (!response || response.length === 0) {
    throw new Error('No rotation request found for notification');
  }

  const exn = response[0].exn;
  const rotEvent = exn.e?.rot;
  const gid = exn.a?.gid as string;
  const smids = exn.a?.smids as string[];
  const rmids = exn.a?.rmids as string[];

  if (!rotEvent || !gid) {
    throw new Error('Invalid /multisig/rot notification: missing rotation event or group ID');
  }

  console.log(`[KERIClient] Group ID: ${gid.slice(0, 12)}..., smids: ${smids?.length}, rmids: ${rmids?.length}`);

  // 2. Get our personal AID to sign the rotation
  const aids = await this.client.identifiers().list();
  if (!aids?.aids?.length) {
    throw new Error('No AIDs found to sign rotation');
  }

  // Use first AID (personal AID)
  const personalAid = aids.aids[0];
  const keeper = await this.client.manager!.get(personalAid);

  // 3. Sign the rotation event
  // rotEvent may be a Serder or a plain object — construct Serder if needed
  const signify = await import('signify-ts');
  const serder = rotEvent instanceof signify.Serder
    ? rotEvent
    : new signify.Serder(rotEvent);

  const sigs = keeper.sign(signify.b(serder.raw));

  // 4. Join the group
  console.log('[KERIClient] Calling groups().join()...');
  const joinOp = await this.client.groups().join(
    groupName,
    serder,
    sigs,
    gid,
    smids,
    rmids,
  );

  await this.client.operations().wait(joinOp, { signal: AbortSignal.timeout(60000) });
  console.log(`[KERIClient] Joined group "${groupName}" (${gid.slice(0, 12)}...)`);

  // 5. Add agent end role for the joined group AID
  const agentId = this.client.agent?.pre;
  if (agentId) {
    try {
      const endRoleResult = await this.client.identifiers().addEndRole(gid, 'agent', agentId);
      const endRoleOp = await endRoleResult.op();
      await this.client.operations().wait(endRoleOp, { signal: AbortSignal.timeout(30000) });
      console.log(`[KERIClient] Agent end role added for group AID`);
    } catch (err) {
      console.warn('[KERIClient] Failed to add agent end role for group:', err);
    }
  }

  return gid;
}
```

**Step 2: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit --skipLibCheck 2>&1 | head -20`
Expected: No new errors

**Step 3: Commit**

```bash
git add frontend/src/lib/keri/client.ts
git commit -m "feat: add joinGroup() for steward multisig join"
```

---

### Task 3: Create `useMultisigJoin` composable

**Files:**
- Create: `frontend/src/composables/useMultisigJoin.ts`

**Step 1: Create the composable**

This composable polls for `/multisig/rot` notifications and auto-joins the org group. It runs on the steward's side.

```typescript
/**
 * Composable for auto-joining the org multisig group.
 * Polls for /multisig/rot notifications and completes the join.
 * Used by stewards after being promoted to Founding Member or Community Steward.
 */
import { ref, onUnmounted } from 'vue';
import { useKERIClient } from 'src/lib/keri/client';
import { fetchOrgConfig } from 'src/api/config';
import { secureStorage } from 'src/lib/secureStorage';

const MULTISIG_ROT_ROUTE = '/multisig/rot';

export function useMultisigJoin() {
  const keriClient = useKERIClient();

  const isJoining = ref(false);
  const hasJoined = ref(false);
  const error = ref<string | null>(null);

  let pollingTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Check for /multisig/rot notifications and join if found
   */
  async function checkAndJoinMultisig(): Promise<boolean> {
    const client = keriClient.getSignifyClient();
    if (!client) return false;

    try {
      // Check for unread /multisig/rot notifications
      const notifications = await keriClient.listNotifications({
        route: MULTISIG_ROT_ROUTE,
        read: false,
      });

      if (notifications.length === 0) return false;

      console.log(`[MultisigJoin] Found ${notifications.length} /multisig/rot notifications`);

      // Get org config to know the expected group AID
      const configResult = await fetchOrgConfig();
      const config = configResult.status === 'configured'
        ? configResult.config
        : configResult.status === 'server_unreachable'
          ? configResult.cached
          : null;

      if (!config?.organization?.aid) {
        console.warn('[MultisigJoin] No org config available');
        return false;
      }

      const orgAidPrefix = config.organization.aid;
      const orgName = (config.organization.name || 'matou').toLowerCase().replace(/\s+/g, '-');

      // Process the first notification
      const notification = notifications[0];
      isJoining.value = true;
      error.value = null;

      try {
        const gid = await keriClient.joinGroup(orgName, notification.a.d);
        console.log(`[MultisigJoin] Joined group: ${gid}`);

        // Store org AID in secure storage so useAdminAccess and
        // useAdminActions can find it
        await secureStorage.setItem('matou_org_aid', gid);
        keriClient.setOrgAID(gid);

        // Mark notification as read
        await keriClient.markNotificationRead(notification.i);

        hasJoined.value = true;
        return true;
      } catch (joinErr) {
        const msg = joinErr instanceof Error ? joinErr.message : String(joinErr);
        console.error('[MultisigJoin] Join failed:', joinErr);
        error.value = msg;

        // Mark as read even on failure to avoid retry loops
        await keriClient.markNotificationRead(notification.i).catch(() => {});
        return false;
      } finally {
        isJoining.value = false;
      }
    } catch (err) {
      console.warn('[MultisigJoin] Check failed:', err);
      return false;
    }
  }

  /**
   * Start polling for multisig rotation notifications
   * @param interval - Polling interval in ms (default: 5000)
   */
  function startPolling(interval = 5000): void {
    if (pollingTimer) return;

    console.log('[MultisigJoin] Starting poll for /multisig/rot...');

    // Check immediately
    checkAndJoinMultisig().then(joined => {
      if (joined) stopPolling();
    });

    pollingTimer = setInterval(async () => {
      const joined = await checkAndJoinMultisig();
      if (joined) stopPolling();
    }, interval);
  }

  function stopPolling(): void {
    if (pollingTimer) {
      clearInterval(pollingTimer);
      pollingTimer = null;
      console.log('[MultisigJoin] Polling stopped');
    }
  }

  onUnmounted(() => {
    stopPolling();
  });

  return {
    isJoining,
    hasJoined,
    error,
    checkAndJoinMultisig,
    startPolling,
    stopPolling,
  };
}
```

**Step 2: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit --skipLibCheck 2>&1 | head -20`
Expected: No new errors

**Step 3: Commit**

```bash
git add frontend/src/composables/useMultisigJoin.ts
git commit -m "feat: add useMultisigJoin composable for steward auto-join"
```

---

### Task 4: Add `addStewardToOrgMultisig()` to useAdminActions

**Files:**
- Modify: `frontend/src/composables/useAdminActions.ts`

**Step 1: Add the function**

Add a new exported function inside `useAdminActions()` that orchestrates the multisig rotation from the admin's side. Add after the existing `approveRegistration()` function (around line 321).

```typescript
/**
 * Add a steward's AID to the org group AID via multisig rotation.
 * Called after changing a member's role to Founding Member or Community Steward.
 * @param stewardAid - The steward's personal AID prefix
 */
async function addStewardToOrgMultisig(stewardAid: string): Promise<boolean> {
  const client = keriClient.getSignifyClient();
  if (!client) {
    console.error('[AdminActions] No SignifyClient for multisig rotation');
    return false;
  }

  try {
    console.log(`[AdminActions] Adding steward ${stewardAid.slice(0, 12)}... to org multisig`);

    // 1. Get the org AID name
    const orgAidName = await getOrgAidName();

    // Find the org AID by prefix to get its name
    const aids = await client.identifiers().list();
    const orgAid = aids.aids?.find((a: { prefix: string }) => a.prefix === orgAidName);
    const orgName = orgAid?.name;
    if (!orgName) {
      throw new Error('Could not find org AID name');
    }

    // 2. Find admin's personal AID name (the master controller)
    // The admin's personal AID is NOT the org AID
    const personalAid = aids.aids?.find((a: { prefix: string; name: string }) =>
      a.prefix !== orgAidName && !a.name?.includes('org')
    );
    if (!personalAid) {
      throw new Error('Could not find admin personal AID');
    }

    // 3. Resolve steward's OOBI (should already be resolved from earlier interactions)
    const cesrUrl = keriClient.getCesrUrl();
    const stewardOOBI = `${cesrUrl}/oobi/${stewardAid}`;
    console.log(`[AdminActions] Resolving steward OOBI: ${stewardOOBI}`);
    await keriClient.resolveOOBI(stewardOOBI, undefined, 30000);

    // 4. Perform the two-rotation process
    await keriClient.addMemberToGroup(orgName, stewardAid, personalAid.name);

    console.log('[AdminActions] Steward added to org multisig successfully');
    return true;
  } catch (err) {
    console.error('[AdminActions] Failed to add steward to org multisig:', err);
    return false;
  }
}
```

Also add `addStewardToOrgMultisig` to the return object of `useAdminActions()`.

**Step 2: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit --skipLibCheck 2>&1 | head -20`
Expected: No new errors

**Step 3: Commit**

```bash
git add frontend/src/composables/useAdminActions.ts
git commit -m "feat: add addStewardToOrgMultisig() to useAdminActions"
```

---

### Task 5: Update ChangeRoleModal to trigger multisig rotation

**Files:**
- Modify: `frontend/src/components/dashboard/ChangeRoleModal.vue`

**Step 1: Update the modal**

After the role update API call succeeds, if the new role is Founding Member or Community Steward, trigger the multisig rotation. Update the `handleConfirm()` function:

In `<script setup>`, add import for `useAdminActions`:
```typescript
import { useAdminActions } from 'src/composables/useAdminActions';

const { addStewardToOrgMultisig } = useAdminActions();
```

Replace `handleConfirm()` with:
```typescript
const STEWARD_ROLES = ['Founding Member', 'Community Steward'];

async function handleConfirm() {
  if (selectedRole.value === props.currentRole) return;

  isUpdating.value = true;
  error.value = null;

  try {
    // 1. Update role in backend (CommunityProfile)
    const result = await updateMemberRole(props.memberAid, selectedRole.value);
    if (result.error) {
      error.value = result.error;
      return;
    }

    // 2. If promoting to steward role, add to org multisig
    if (STEWARD_ROLES.includes(selectedRole.value)) {
      console.log(`[ChangeRoleModal] Promoting to ${selectedRole.value}, triggering multisig rotation...`);
      const multisigOk = await addStewardToOrgMultisig(props.memberAid);
      if (!multisigOk) {
        console.warn('[ChangeRoleModal] Multisig rotation failed, role updated but steward cannot yet issue credentials');
        // Don't block — role is updated, multisig join will happen async
      }
    }

    emit('role-updated', selectedRole.value);
    emit('close');
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to update role';
  } finally {
    isUpdating.value = false;
  }
}
```

**Step 2: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit --skipLibCheck 2>&1 | head -20`
Expected: No new errors

**Step 3: Commit**

```bash
git add frontend/src/components/dashboard/ChangeRoleModal.vue
git commit -m "feat: trigger multisig rotation in ChangeRoleModal for steward roles"
```

---

### Task 6: Update useAdminAccess to detect org group membership

**Files:**
- Modify: `frontend/src/composables/useAdminAccess.ts`

**Step 1: Add org group membership check**

After the existing credential checks (around line 157, before Method 2), add a check for org group AID membership. When a steward joins the org group, the org AID appears in their `identifiers().list()`. We check for this.

Add after the credential loop (after line 157) and before Method 2 (line 159):

```typescript
// Method 1b: Check if user participates in the org group AID
// After multisig join, the org AID appears in identifiers list
try {
  const configResult2 = await fetchOrgConfig();
  const orgConfig = configResult2.status === 'configured'
    ? configResult2.config
    : configResult2.status === 'server_unreachable'
      ? configResult2.cached
      : null;

  if (orgConfig?.organization?.aid) {
    const aids = await client.identifiers().list();
    const orgGroupAid = aids.aids?.find(
      (a: { prefix: string }) => a.prefix === orgConfig.organization.aid
    );
    if (orgGroupAid) {
      console.log('[AdminAccess] User is a member of the org group AID');
      isAdmin.value = true;
      adminCredential.value = {
        said: '',
        schema: '',
        issuer: orgConfig.organization.aid,
        issuee: currentAID.prefix,
        status: 'group_member',
        role: 'Community Steward', // Default for group members
        permissions: ['approve_registrations', 'admin', 'issue_membership'],
      };
      permissions.value = adminCredential.value.permissions || [];
      return true;
    }
  }
} catch (groupErr) {
  console.warn('[AdminAccess] Failed to check org group membership:', groupErr);
}
```

**Step 2: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit --skipLibCheck 2>&1 | head -20`
Expected: No new errors

**Step 3: Commit**

```bash
git add frontend/src/composables/useAdminAccess.ts
git commit -m "feat: detect org group membership in useAdminAccess"
```

---

### Task 7: Wire useMultisigJoin into DashboardPage

**Files:**
- Modify: `frontend/src/pages/DashboardPage.vue`

**Step 1: Import and start multisig join polling**

In the `<script setup>` section, add the import and start polling:

After the existing `useAdminActions` destructuring (around line 220), add:
```typescript
import { useMultisigJoin } from 'src/composables/useMultisigJoin';

const {
  hasJoined: hasJoinedMultisig,
  startPolling: startMultisigPolling,
  stopPolling: stopMultisigPolling,
} = useMultisigJoin();
```

In `onMounted`, after `checkAdminStatus()` (around line 341), add multisig polling for non-admin users (members who might get promoted):

```typescript
// Start multisig join polling for all authenticated users
// (stewards who were just promoted need to detect and join the org group)
startMultisigPolling(5000);
```

In `onUnmounted`, add:
```typescript
stopMultisigPolling();
```

Also watch `hasJoinedMultisig` to re-check admin status after joining:
```typescript
watch(hasJoinedMultisig, async (joined) => {
  if (joined) {
    console.log('[Dashboard] Joined org multisig, re-checking admin status...');
    await checkAdminStatus();
    if (isSteward.value) {
      startPolling(); // Start registration polling now that we're a steward
    }
  }
});
```

**Step 2: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit --skipLibCheck 2>&1 | head -20`
Expected: No new errors

**Step 3: Commit**

```bash
git add frontend/src/pages/DashboardPage.vue
git commit -m "feat: wire useMultisigJoin into DashboardPage"
```

---

### Task 8: Update useAdminActions.approveRegistration to work for non-admin stewards

**Files:**
- Modify: `frontend/src/composables/useAdminActions.ts`

**Step 1: Update getOrgAidName()**

The existing `getOrgAidName()` returns a prefix. After multisig join, the steward's KERIA has the org AID in its identifiers list. The existing logic should already find it, but update it to prioritize the org config AID prefix:

Replace `getOrgAidName()` (lines 80-112):

```typescript
async function getOrgAidName(): Promise<string> {
  const client = keriClient.getSignifyClient();
  if (!client) throw new Error('Not connected to KERIA');

  // First: check org config for the canonical org AID prefix
  try {
    const configResult = await fetchOrgConfig();
    const config = configResult.status === 'configured'
      ? configResult.config
      : configResult.status === 'server_unreachable'
        ? configResult.cached
        : null;

    if (config?.organization?.aid) {
      const aids = await client.identifiers().list();
      const orgAid = aids.aids?.find(
        (a: { prefix: string }) => a.prefix === config.organization.aid
      );
      if (orgAid) {
        console.log('[AdminActions] Using org AID from config:', orgAid.name);
        return orgAid.prefix;
      }
    }
  } catch {
    // Fall through to other methods
  }

  // Second: check secure storage (set during org setup or multisig join)
  const storedOrgAid = await secureStorage.getItem('matou_org_aid');
  if (storedOrgAid) {
    const aids = await client.identifiers().list();
    const orgAid = aids.aids?.find((a: { prefix: string }) => a.prefix === storedOrgAid);
    if (orgAid) {
      console.log('[AdminActions] Using stored org AID:', orgAid.name);
      return orgAid.prefix;
    }
  }

  // Fallback: look for an org-type AID by name pattern
  const aids = await client.identifiers().list();
  if (!aids?.aids?.length) {
    throw new Error('No AIDs found in wallet');
  }

  const orgAid = aids.aids.find((a: { name: string }) =>
    a.name.includes('org') || a.name.includes('matou') || a.name.includes('community')
  );

  if (orgAid) {
    return orgAid.prefix;
  }

  return aids.aids[0].prefix;
}
```

**Step 2: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit --skipLibCheck 2>&1 | head -20`
Expected: No new errors

**Step 3: Commit**

```bash
git add frontend/src/composables/useAdminActions.ts
git commit -m "feat: update getOrgAidName to find org AID via config for stewards"
```

---

### Task 9: Clean up useOrgSetup credential data (schema v2)

**Files:**
- Modify: `frontend/src/composables/useOrgSetup.ts` (lines 107-121)

**Step 1: Remove deprecated fields from admin credential**

The membership schema v2 removed `permissions` and `verificationStatus`. Update the credential data in `setupOrg()`:

Replace lines 107-121:
```typescript
const credentialData = {
  communityName: 'MATOU',
  role: 'Operations Steward',
  joinedAt: new Date().toISOString(),
};
```

**Step 2: Verify TypeScript compiles**

Run: `cd frontend && npx tsc --noEmit --skipLibCheck 2>&1 | head -20`

**Step 3: Commit**

```bash
git add frontend/src/composables/useOrgSetup.ts
git commit -m "fix: remove deprecated permissions/verificationStatus from org setup credential"
```

---

### Task 10: Update E2E test for multisig join flow

**Files:**
- Modify: `frontend/tests/e2e/e2e-registration.spec.ts`

**Step 1: Update Test 2 to account for multisig join**

The existing Test 2 has the admin upgrade User1 to Community Steward. After this change, the ChangeRoleModal will trigger the multisig rotation. User1's dashboard needs to detect the `/multisig/rot` notification and join.

In the test, after admin upgrades User1's role (step I), add a wait for User1's dashboard to detect the multisig join:

After the admin upgrades User1's role and before User1 reopens User2's profile, add:
```typescript
// Wait for User1's multisig join to complete
// The dashboard polls every 5 seconds for /multisig/rot notifications
await user1Page.waitForTimeout(10000); // Allow time for multisig join polling

// Re-check admin status after multisig join
// User1's dashboard should auto-detect the join and re-check
await user1Page.reload();
await user1Page.waitForTimeout(5000);
```

**Important:** The exact test modifications depend on the current test structure. The subagent implementing this task should read the current test file and adapt accordingly. The key requirement is:
1. After admin upgrades User1, wait for multisig join
2. After join, User1's dashboard should show approve button for User2
3. User1 can approve User2 and User2 gets credential

**Step 2: Run the test to verify it passes (or note expected failures)**

Run: `cd frontend && npx playwright test e2e-registration --timeout 180000`

**Step 3: Commit**

```bash
git add frontend/tests/e2e/e2e-registration.spec.ts
git commit -m "test: update registration spec for multisig join flow"
```

---

### Task 11: Build verification

**Step 1: Run full TypeScript check**

Run: `cd frontend && npx tsc --noEmit --skipLibCheck 2>&1 | tail -30`
Expected: No new errors from our changes (pre-existing errors may be present)

**Step 2: Verify all new files are committed**

Run: `cd frontend && git status && git log --oneline -15`
Expected: Clean working tree, all tasks committed

**Step 3: Commit if needed**

Fix any remaining issues and commit.
