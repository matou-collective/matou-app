# Network Request Optimization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reduce steady-state network requests from ~80/min to ~4-6/min by consolidating KERIA polling, caching org config, merging SSE connections, and removing redundant polling.

**Architecture:** A new singleton `useKERINotificationService` fetches KERIA notifications and credentials on a single 30s timer. Existing composables become consumers that watch reactive refs instead of fetching directly. Org config is fetched once at startup and cached in memory. The two SSE connections merge into one. DashboardLayout's 15s profile poll is replaced by debounced SSE event handling.

**Tech Stack:** Vue 3 Composition API, Pinia stores, signify-ts (KERIA client), EventSource (SSE)

**Design doc:** `docs/plans/2026-02-26-network-request-optimization-design.md`

---

### Task 1: Add TTL cache to `fetchOrgConfig()`

Smallest, safest change. Eliminates ~24 config requests/min with zero structural risk.

**Files:**
- Modify: `frontend/src/api/config.ts`

**Step 1: Add module-level cache variables**

At the top of `config.ts`, after the existing constants (line 16), add:

```ts
// In-memory config cache — fetched once at startup, never re-fetched during session
let orgConfigCache: OrgConfig | null = null;
let orgConfigFetchedAt = 0;
```

**Step 2: Add synchronous getter**

After `clearCachedConfig()` (line 224), add:

```ts
/**
 * Get org config from in-memory cache (no network call).
 * Returns null if not yet fetched. Call fetchOrgConfig() once at startup.
 */
export function getOrgConfig(): OrgConfig | null {
  return orgConfigCache;
}
```

**Step 3: Update `fetchOrgConfig()` to populate the cache**

In `fetchOrgConfig()`, after each successful `normalizeOrgConfig()` call (lines 107 and 130), add:

```ts
orgConfigCache = config;
orgConfigFetchedAt = Date.now();
```

Also after `getCachedConfig()` (line 145), if the cached config is not null:

```ts
if (cached) {
  orgConfigCache = cached;
  orgConfigFetchedAt = Date.now();
}
```

**Step 4: Add a `getOrFetchOrgConfig()` convenience function**

After the `getOrgConfig()` function, add:

```ts
/**
 * Returns cached org config if available, otherwise fetches once from network.
 * Use this in pollers and composables instead of fetchOrgConfig() directly.
 */
export async function getOrFetchOrgConfig(): Promise<OrgConfig | null> {
  if (orgConfigCache) return orgConfigCache;

  const result = await fetchOrgConfig();
  if (result.status === 'configured') return result.config;
  if (result.status === 'server_unreachable') return result.cached;
  return null;
}
```

**Step 5: Commit**

```
feat: add in-memory cache for org config

fetchOrgConfig() now stores the result in a module-level cache.
New getOrgConfig() returns the cached value synchronously.
New getOrFetchOrgConfig() returns cache or fetches once.
Eliminates ~24 redundant config requests/min from pollers.
```

---

### Task 2: Create `useKERINotificationService` singleton

The core new composable. Single timer, shared data, consumed by all pollers.

**Files:**
- Create: `frontend/src/composables/useKERINotificationService.ts`

**Step 1: Create the composable**

```ts
/**
 * Singleton service that fetches KERIA notifications and credentials on a
 * single shared timer. Consumers watch the reactive refs instead of making
 * their own KERIA calls.
 *
 * Usage:
 *   const { notifications, credentials, triggerNow } = useKERINotificationService();
 *   // In DashboardLayout.onMounted():
 *   start();
 *   // In composables:
 *   watch(notifications, (notes) => { /* process your subset */ });
 */
import { ref, readonly, type DeepReadonly, type Ref } from 'vue';
import { useKERIClient } from 'src/lib/keri/client';

export interface KERINotification {
  i: string;
  a: {
    r: string;
    d: string;
    i?: string;
    a?: Record<string, unknown>;
    dt?: string;
    m?: string;
    [key: string]: unknown;
  };
  r: boolean;
}

// Module-level singleton state
const notifications = ref<KERINotification[]>([]);
const credentials = ref<any[]>([]);
const lastFetchTime = ref(0);
const isRunning = ref(false);
const fetchError = ref<string | null>(null);

let pollTimer: ReturnType<typeof setInterval> | null = null;
let keriClientInstance: ReturnType<typeof useKERIClient> | null = null;

const DEFAULT_INTERVAL = 30_000; // 30 seconds

async function fetchAll(): Promise<void> {
  const client = keriClientInstance?.getSignifyClient();
  if (!client) return;

  try {
    // Single call for all notifications (replaces 3+ separate calls)
    const notifResult = await client.notifications().list(0, 1000);
    notifications.value = notifResult.notes ?? [];

    // Single call for all credentials
    try {
      credentials.value = await client.credentials().list();
    } catch (credErr) {
      console.warn('[KERINotificationService] Credential fetch failed:', credErr);
      // Non-fatal: keep previous credentials, only update notifications
    }

    lastFetchTime.value = Date.now();
    fetchError.value = null;
  } catch (err) {
    console.error('[KERINotificationService] Fetch failed:', err);
    fetchError.value = err instanceof Error ? err.message : String(err);
  }
}

function start(interval = DEFAULT_INTERVAL): void {
  if (pollTimer) return;

  const keriClient = useKERIClient();
  keriClientInstance = keriClient;

  const client = keriClient.getSignifyClient();
  if (!client) {
    console.warn('[KERINotificationService] No SignifyClient available');
    return;
  }

  isRunning.value = true;
  console.log(`[KERINotificationService] Starting (interval: ${interval}ms)`);

  // Fetch immediately
  fetchAll();

  // Then on interval
  pollTimer = setInterval(fetchAll, interval);
}

function stop(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  isRunning.value = false;
  console.log('[KERINotificationService] Stopped');
}

/**
 * Trigger an immediate fetch (e.g. after admitting a grant).
 * Resets the timer so the next interval starts fresh.
 */
async function triggerNow(): Promise<void> {
  const interval = DEFAULT_INTERVAL;
  if (pollTimer) {
    clearInterval(pollTimer);
  }
  await fetchAll();
  if (isRunning.value) {
    pollTimer = setInterval(fetchAll, interval);
  }
}

export function useKERINotificationService() {
  return {
    notifications: readonly(notifications) as DeepReadonly<Ref<KERINotification[]>>,
    credentials: readonly(credentials) as DeepReadonly<Ref<any[]>>,
    lastFetchTime: readonly(lastFetchTime),
    isRunning: readonly(isRunning),
    fetchError: readonly(fetchError),
    start,
    stop,
    triggerNow,
  };
}
```

**Step 2: Commit**

```
feat: add unified KERIA notification service

Single singleton composable that fetches all KERIA notifications and
credentials on one 30s timer. Replaces three independent polling loops
that were tripling notification API calls.
```

---

### Task 3: Refactor `useCredentialPolling` to consume from notification service

Remove its own `setInterval` and direct KERIA notification/credential calls. Watch the service's refs instead. Keep all grant processing, admission, verification, and rejection logic.

**Files:**
- Modify: `frontend/src/composables/useCredentialPolling.ts`

**Step 1: Replace KERIA imports and add service + config imports**

Replace line 6 (`import { useKERIClient }`) with:

```ts
import { useKERIClient } from 'src/lib/keri/client';
import { useKERINotificationService, type KERINotification } from './useKERINotificationService';
```

Replace line 8 (`import { fetchOrgConfig }`) with:

```ts
import { fetchOrgConfig, getOrFetchOrgConfig, getOrgConfig } from 'src/api/config';
```

**Step 2: Add service consumption in setup**

After the existing `const keriClient = useKERIClient();` (line 46), add:

```ts
const notificationService = useKERINotificationService();
```

**Step 3: Replace `pollForGrants()` notification and credential fetching**

In `pollForGrants()`, replace the direct KERIA calls with reads from the service:

- Replace `cachedCredentials = await client.credentials().list();` (line 250) with:
  ```ts
  cachedCredentials = [...notificationService.credentials.value];
  ```

- Replace `const notifications = await client.notifications().list();` (line 342) with:
  ```ts
  const allNotes = notificationService.notifications.value;
  const notifications = { notes: [...allNotes] };
  ```

- Replace the `fetchOrgConfig()` call inside the polling loop (lines 292-301) with:
  ```ts
  const config = await getOrFetchOrgConfig();
  orgAid = config?.organization?.aid || null;
  ```

Note: Keep all `client.exchanges().get()`, `client.ipex().submitAdmit()`, `client.notifications().mark()` calls as-is — these are one-off operations on specific notifications, not bulk fetches.

**Step 4: Replace `pollForCredential()` inner loop credential fetching**

In `pollForCredential()` (line 581), the inner `checkCredential()` function calls `client.credentials().list()` in a tight 2s loop. Replace this:

- Change `const credentials = await client.credentials().list();` (line 596) to:
  ```ts
  // Trigger a fresh fetch so we get the latest credentials
  await notificationService.triggerNow();
  const credentials = [...notificationService.credentials.value];
  ```

**Step 5: Replace `startPolling()` timer with watch**

Rewrite `startPolling()` (lines 650-695) to use a watch instead of setInterval:

```ts
import { watch } from 'vue';
```

(Add `watch` to the existing vue import on line 5.)

Remove the `pollingTimer` variable (line 84) and the `setInterval` in `startPolling()` (line 692-694). Replace with:

```ts
let stopWatcher: (() => void) | null = null;

async function startPolling(): Promise<void> {
  if (isPolling.value) return;

  const client = keriClient.getSignifyClient();
  const aidName = getAIDName();
  console.log('[CredentialPolling] Starting polling...', {
    hasClient: !!client,
    aidName,
  });

  if (!client || !aidName) {
    error.value = !client
      ? 'Not connected to KERIA. Please refresh the page.'
      : 'No identity found. Please complete registration first.';
    return;
  }

  // Check for persisted rejection state first (fast path)
  const wasRejected = await loadRejectionState();
  if (wasRejected) {
    console.log('[CredentialPolling] Registration was previously rejected - not polling');
    return;
  }

  isPolling.value = true;
  error.value = null;
  consecutiveErrors.value = 0;

  // Resolve org/admin OOBIs once at start
  await resolveOrgOobis();

  // Process immediately with current data
  pollForGrants();

  // Then react whenever the notification service fetches new data
  stopWatcher = watch(
    () => notificationService.lastFetchTime.value,
    () => { pollForGrants(); },
  );
}
```

Update `stopPolling()`:

```ts
function stopPolling(): void {
  if (stopWatcher) {
    stopWatcher();
    stopWatcher = null;
  }
  isPolling.value = false;
  console.log('[CredentialPolling] Polling stopped');
}
```

Remove the old `pollingTimer` cleanup from `onUnmounted` — `stopPolling()` already handles it.

**Step 6: Update `resolveOrgOobis()` to use cached config**

Replace the `fetchOrgConfig()` call in `resolveOrgOobis()` (line 160) with:

```ts
const config = await getOrFetchOrgConfig();
```

And remove the status checking — `getOrFetchOrgConfig()` returns `OrgConfig | null` directly:

```ts
if (!config) {
  console.log('[CredentialPolling] No org config available for OOBI resolution');
  return;
}
```

**Step 7: Commit**

```
refactor: useCredentialPolling consumes from notification service

Removes direct KERIA polling (setInterval + notifications().list() +
credentials().list()). Now watches the shared notification service's
reactive refs. All grant processing, admission, and verification logic
unchanged.
```

---

### Task 4: Refactor `useRegistrationPolling` to consume from notification service

**Files:**
- Modify: `frontend/src/composables/useRegistrationPolling.ts`

**Step 1: Add service import**

After line 14, add:

```ts
import { useKERINotificationService, type KERINotification } from './useKERINotificationService';
```

**Step 2: Add service in setup**

After `const keriClient = useKERIClient();` (line 81), add:

```ts
const notificationService = useKERINotificationService();
```

**Step 3: Replace notification fetching in `pollForRegistrations()`**

Replace the 5 separate `keriClient.listNotifications()` calls (lines 116-119, 163-166, 210-213, 261-264, 397-400) with filtered reads from the service's `notifications` ref.

At the start of `pollForRegistrations()`, after the client check:

```ts
const allNotes = notificationService.notifications.value;
```

Then replace each `keriClient.listNotifications({ route: X, read: false })` with:

```ts
const pendingNotifications = allNotes.filter(
  n => n.a?.r === REGISTRATION_ROUTES.PENDING && !n.r
);
```

```ts
const ipexApplyPendingNotifications = allNotes.filter(
  n => n.a?.r === REGISTRATION_ROUTES.IPEX_APPLY_PENDING && !n.r
);
```

```ts
const ipexApplyNotifications = allNotes.filter(
  n => n.a?.r === REGISTRATION_ROUTES.IPEX_APPLY && !n.r
);
```

```ts
const verifiedNotifications = allNotes.filter(
  n => n.a?.r === REGISTRATION_ROUTES.VERIFIED && !n.r
);
```

```ts
const messageReplyNotifications = allNotes.filter(
  n => n.a?.r === REGISTRATION_ROUTES.MESSAGE_REPLY && !n.r
);
```

Keep all `keriClient.getExchange()` and `keriClient.markNotificationRead()` calls as-is.

**Step 4: Replace `setInterval` with watch**

Same pattern as Task 3. Replace `startPolling()`:

```ts
let stopWatcher: (() => void) | null = null;

function startPolling(): void {
  if (isPolling.value) return;

  const client = keriClient.getSignifyClient();
  if (!client) {
    console.warn('[RegistrationPolling] No SignifyClient available');
    error.value = 'Not connected to KERIA';
    return;
  }

  console.log('[RegistrationPolling] Starting...');
  isPolling.value = true;
  error.value = null;
  consecutiveErrors.value = 0;

  // Process immediately
  pollForRegistrations();

  // React to service fetches
  stopWatcher = watch(
    () => notificationService.lastFetchTime.value,
    () => { pollForRegistrations(); },
  );
}

function stopPolling(): void {
  if (stopWatcher) {
    stopWatcher();
    stopWatcher = null;
  }
  isPolling.value = false;
  console.log('[RegistrationPolling] Polling stopped');
}
```

Remove the old `pollingTimer` variable and `setInterval`/`clearInterval` code.

Add `watch` to the vue import on line 14.

**Step 5: Commit**

```
refactor: useRegistrationPolling consumes from notification service

Removes 5 separate keriClient.listNotifications() calls per cycle.
Now filters the shared notification service's data. All registration
parsing, dedup, and profile creation logic unchanged.
```

---

### Task 5: Refactor `useMultisigJoin` to consume from notification service

**Files:**
- Modify: `frontend/src/composables/useMultisigJoin.ts`

**Step 1: Add imports**

Replace line 1's vue import with:

```ts
import { ref, watch, onUnmounted } from 'vue';
```

After line 8, add:

```ts
import { useKERINotificationService } from './useKERINotificationService';
import { getOrFetchOrgConfig } from 'src/api/config';
```

**Step 2: Add service in setup, replace config fetch**

After `const keriClient = useKERIClient();` (line 14), add:

```ts
const notificationService = useKERINotificationService();
```

**Step 3: Refactor `checkAndJoinMultisig()`**

Replace `await keriClient.listNotifications()` (line 33) with:

```ts
const allNotifications = notificationService.notifications.value;
```

Replace `await fetchOrgConfig()` (line 43) with:

```ts
const config = await getOrFetchOrgConfig();
```

And simplify the config extraction (remove the status checks):

```ts
if (!config?.organization?.aid) {
  console.warn('[MultisigJoin] No org config available');
  return false;
}
```

Remove the `fetchOrgConfig` import (line 8).

**Step 4: Replace polling with watch**

```ts
let stopWatcher: (() => void) | null = null;

function startPolling(interval?: number): void {
  if (stopWatcher) return;

  console.log('[MultisigJoin] Starting watch for /multisig/rot...');

  // Check immediately
  checkAndJoinMultisig().then(joined => {
    if (joined && stopWatcher) {
      stopWatcher();
      stopWatcher = null;
    }
  });

  // React to service fetches
  stopWatcher = watch(
    () => notificationService.lastFetchTime.value,
    async () => {
      const joined = await checkAndJoinMultisig();
      if (joined) stopPolling();
    },
  );
}

function stopPolling(): void {
  if (stopWatcher) {
    stopWatcher();
    stopWatcher = null;
  }
  console.log('[MultisigJoin] Stopped');
}
```

Remove the old `pollingTimer` variable.

**Step 5: Commit**

```
refactor: useMultisigJoin consumes from notification service

Removes independent KERIA notification polling and fetchOrgConfig()
calls. Now watches the shared service and uses cached org config.
```

---

### Task 6: Merge `useChatEvents` into `useBackendEvents`

**Files:**
- Modify: `frontend/src/composables/useBackendEvents.ts`
- Modify: `frontend/src/layouts/DashboardLayout.vue`
- Delete: `frontend/src/composables/useChatEvents.ts`

**Step 1: Add chat event types and imports to `useBackendEvents.ts`**

Update the type union (line 14) to include chat events:

```ts
export type BackendEventType =
  | 'credential:new'
  | 'credential:community'
  | 'space:joined'
  | 'identity:configured'
  | 'notice_created'
  | 'notice_published'
  | 'notice_archived'
  | 'notice_comment'
  | 'notice_reaction'
  | 'profile:updated'
  | 'chat:message:new'
  | 'chat:message:edit'
  | 'chat:message:delete'
  | 'chat:reaction:add'
  | 'chat:reaction:remove'
  | 'chat:channel:new'
  | 'chat:channel:update'
  | 'connected';
```

Add imports at the top:

```ts
import { Notify } from 'quasar';
import { useRouter } from 'vue-router';
import { useChatStore } from 'stores/chat';
```

**Step 2: Add chat event listeners inside `connect()`**

After the existing `profile:updated` listener (line 137), add all chat event listeners from `useChatEvents.ts`. Copy lines 62-153 from `useChatEvents.ts` into the `connect()` function, adjusting to use the singleton `eventSource`:

```ts
  // --- Chat events ---
  const chatStore = useChatStore();
  const router = useRouter();

  eventSource.addEventListener('chat:message:new', (event) => {
    const data = safeParse(event);
    if (!data) return;
    lastEvent.value = { type: 'chat:message:new', data };
    chatStore.handleNewMessage(data);

    // Toast notification for messages in non-active channels
    if (data.channelId !== chatStore.currentChannelId) {
      const channel = chatStore.channels.find(c => c.id === data.channelId);
      const channelName = channel?.name ?? 'Unknown';
      const content = data.content as string | undefined;
      const contentPreview = content?.substring(0, 80) ?? '';
      const profilesStore = useProfilesStore();
      const profile = profilesStore.profilesByAid[data.senderAid as string];
      const displayName = profile?.displayName || data.senderName;
      Notify.create({
        html: true,
        message: `<strong>${displayName}</strong><br>${contentPreview}`,
        caption: `#${channelName}`,
        position: 'top-right',
        timeout: 5000,
        color: 'primary',
        actions: [
          {
            label: 'View',
            color: 'white',
            handler: () => {
              router.push({ name: 'chat' });
              chatStore.selectChannel(data.channelId as string);
            },
          },
          { label: 'Dismiss', color: 'white' },
        ],
      });
    }
  });

  eventSource.addEventListener('chat:message:edit', (event) => {
    const data = safeParse(event);
    if (!data) return;
    lastEvent.value = { type: 'chat:message:edit', data };
    chatStore.handleEditMessage(data);
  });

  eventSource.addEventListener('chat:message:delete', (event) => {
    const data = safeParse(event);
    if (!data) return;
    lastEvent.value = { type: 'chat:message:delete', data };
    chatStore.handleDeleteMessage(data);
  });

  eventSource.addEventListener('chat:reaction:add', (event) => {
    const data = safeParse(event);
    if (!data) return;
    lastEvent.value = { type: 'chat:reaction:add', data };
    if (chatStore.currentChannelId) {
      chatStore.loadMessages(chatStore.currentChannelId);
    }
  });

  eventSource.addEventListener('chat:reaction:remove', (event) => {
    const data = safeParse(event);
    if (!data) return;
    lastEvent.value = { type: 'chat:reaction:remove', data };
    if (chatStore.currentChannelId) {
      chatStore.loadMessages(chatStore.currentChannelId);
    }
  });

  eventSource.addEventListener('chat:channel:new', (event) => {
    const data = safeParse(event);
    if (!data) return;
    lastEvent.value = { type: 'chat:channel:new', data };
    chatStore.handleNewChannel(data);
  });

  eventSource.addEventListener('chat:channel:update', (event) => {
    const data = safeParse(event);
    if (!data) return;
    lastEvent.value = { type: 'chat:channel:update', data };
    chatStore.handleUpdateChannel(data);
  });
```

**Step 3: Update `DashboardLayout.vue`**

Remove the `useChatEvents` import and call:

- Remove: `import { useChatEvents } from 'src/composables/useChatEvents';` (line 84)
- Remove: `useChatEvents();` (line 95)

**Step 4: Delete `useChatEvents.ts`**

```bash
git rm frontend/src/composables/useChatEvents.ts
```

**Step 5: Verify no other imports of `useChatEvents`**

Search for any remaining imports. There should be none — only `DashboardLayout.vue` used it.

**Step 6: Commit**

```
refactor: merge useChatEvents into useBackendEvents

Single SSE connection for all event types. Eliminates duplicate
EventSource to /api/v1/events. Deletes useChatEvents.ts.
```

---

### Task 7: Remove DashboardLayout profile polling + add debounced SSE handler

**Files:**
- Modify: `frontend/src/layouts/DashboardLayout.vue`
- Modify: `frontend/src/composables/useBackendEvents.ts`

**Step 1: Remove the 15s profile poll from DashboardLayout**

Remove the `profilePollTimer` variable (line 125) and the `setInterval` (lines 135-138), and the `clearInterval` in `onBeforeUnmount` (lines 155-160).

Keep the `onMounted` initial loads (lines 131-133) — those are one-time.

**Step 2: Add debounced profile reload in `useBackendEvents`**

At the top of `useBackendEvents.ts`, add a debounce helper:

```ts
let profileDebounceTimer: ReturnType<typeof setTimeout> | null = null;

function debouncedProfileReload() {
  if (profileDebounceTimer) clearTimeout(profileDebounceTimer);
  profileDebounceTimer = setTimeout(() => {
    const profilesStore = useProfilesStore();
    profilesStore.loadCommunityProfiles();
    profilesStore.loadCommunityReadOnlyProfiles();
    profileDebounceTimer = null;
  }, 2000);
}
```

Replace the `profile:updated` listener (lines 129-137) with:

```ts
eventSource.addEventListener('profile:updated', (event) => {
  const data = safeParse(event);
  if (!data) return;
  lastEvent.value = { type: 'profile:updated', data };
  debouncedProfileReload();
});
```

**Step 3: Commit**

```
refactor: replace 15s profile polling with debounced SSE handler

Removes setInterval profile poll from DashboardLayout. The SSE
profile:updated event now triggers a debounced reload (2s) that
covers both SharedProfile and CommunityProfile. Collapses rapid
any-sync profile update bursts into a single API call.
```

---

### Task 8: Wire up notification service in DashboardLayout + org config init

**Files:**
- Modify: `frontend/src/layouts/DashboardLayout.vue`

**Step 1: Import and start the notification service**

Add imports:

```ts
import { useKERINotificationService } from 'src/composables/useKERINotificationService';
import { fetchOrgConfig } from 'src/api/config';
```

In setup:

```ts
const notificationService = useKERINotificationService();
```

In `onMounted()`, after `connectBackendEvents()`:

```ts
// Fetch org config once at startup (cached for entire session)
fetchOrgConfig().catch(err => console.warn('[DashboardLayout] Org config fetch failed:', err));

// Start the unified KERIA notification service
notificationService.start();
```

In `onBeforeUnmount()`:

```ts
notificationService.stop();
```

**Step 2: Commit**

```
feat: wire up notification service and org config init in DashboardLayout

Starts the unified 30s KERIA poll on mount, stops on unmount.
Fetches org config once at startup for session-long caching.
```

---

### Task 9: Verify and clean up

**Files:**
- All modified files

**Step 1: Check for any remaining direct KERIA notification polling**

Search for `setInterval` in the composables directory — should only appear in `useKERINotificationService.ts` now (and `TitleBar.vue` / `FileUploadInput.vue` which are unrelated).

Search for `notifications().list()` — should only appear in `useKERINotificationService.ts` and `lib/keri/client.ts`.

Search for `credentials().list()` — should only appear in `useKERINotificationService.ts`.

**Step 2: Run linter**

```bash
cd frontend && npm run lint
```

Fix any issues.

**Step 3: Run Vitest unit tests**

```bash
cd frontend && npm run test:script
```

**Step 4: Build check**

```bash
cd frontend && npx quasar build
```

Verify no TypeScript or import errors.

**Step 5: Manual smoke test**

Launch the app and verify:
- Dashboard loads normally
- Profile data appears
- Chat messages work
- Credential polling works on PendingApprovalScreen (if testable)
- Network tab shows dramatically fewer requests (~2 KERIA calls per 30s instead of ~14 per 5s)

**Step 6: Final commit if any cleanup needed**

```
chore: clean up residual imports and lint fixes
```
