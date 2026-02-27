# Network Request Optimization Design

## Problem

The app makes ~503 HTTP requests in under 2 minutes (~4.4 req/s steady state).
Root causes identified via Chromium net-log analysis:

1. **Three independent KERIA pollers** each calling `notifications().list()` on overlapping timers (5s, 5s, 10s) — tripled notification requests
2. **`fetchOrgConfig()` called every poll cycle** — hits backend + config server (2 HTTP requests) inside two 5s pollers, despite config being static
3. **Two SSE connections** to the same `/api/v1/events` endpoint (`useBackendEvents` + `useChatEvents`)
4. **15s profile polling** in DashboardLayout, redundant with SSE `profile:updated` events
5. **Unbounded SSE-triggered API calls** — `profile:updated` fires `loadCommunityProfiles()` with no debounce; reaction events trigger full message reloads

## Design

### 1. Unified KERIA Notification Service

New singleton composable: `frontend/src/composables/useKERINotificationService.ts`

- **Single 30s timer** replaces three overlapping timers (5s + 5s + 10s)
- One call to `client.notifications().list()` per cycle
- One call to `client.credentials().list()` per cycle
- Exposes reactive refs consumed by existing composables:
  - `notifications: Ref<IPEXNotification[]>` — full notification list
  - `credentials: Ref<any[]>` — full credential list
  - `lastFetchTime: Ref<number>` — timestamp of last successful fetch
- Provides `triggerNow()` for on-demand refresh (e.g. after admitting a grant or processing a registration)
- Started once from `DashboardLayout.onMounted()`

Existing composables refactored:

- **`useCredentialPolling`**: Remove `setInterval` and direct KERIA calls. Add `watch()` on the service's `notifications` and `credentials` refs. Keep all grant processing, admission, and verification logic intact.
- **`useRegistrationPolling`**: Remove `setInterval` and direct `keriClient.listNotifications()` calls. Watch service's `notifications` ref, filter by registration routes, keep all parsing/dedup/profile-creation logic.
- **`useMultisigJoin`**: Remove `setInterval` and direct notification fetch. Watch service's `notifications` ref, filter for `/multisig/rot`, keep join logic.

Each composable's `startPolling()` becomes `start()` (registers as a consumer) and `stopPolling()` becomes `stop()` (deregisters). The public return interfaces stay compatible.

### 2. Static Org Config (No Polling)

Org config is set once during org setup and effectively never changes during a session.

- `fetchOrgConfig()` called **once** at app startup (in the notification service init or `DashboardLayout.onMounted()`)
- Result stored in a module-level reactive ref: `cachedOrgConfig: Ref<OrgConfig | null>`
- Export a synchronous getter: `getOrgConfig(): OrgConfig | null` that returns the cached value
- All consumers (`useCredentialPolling`, `useMultisigJoin`, `resolveOrgOobis`) read from the cached ref instead of fetching
- Secure storage fallback already exists for offline/unreachable scenarios
- No TTL, no refresh — if config ever needs updating mid-session, a page refresh or future SSE event can handle it

### 3. Merge SSE Connections

- Move all event listeners from `useChatEvents.ts` into `useBackendEvents.ts`
- `useBackendEvents` becomes the single SSE connection for all event types (backend + chat)
- Delete `useChatEvents.ts`
- `DashboardLayout` calls only `connectBackendEvents()` — removes `useChatEvents()` call
- Chat store methods (`handleNewMessage`, `handleEditMessage`, etc.) called from `useBackendEvents` listeners

### 4. Remove DashboardLayout Profile Polling

- Remove the 15s `setInterval` that calls `loadCommunityProfiles()` + `loadCommunityReadOnlyProfiles()`
- The SSE `profile:updated` handler already triggers `loadCommunityProfiles()`
- Add `loadCommunityReadOnlyProfiles()` to the `profile:updated` handler (currently missing)
- Keep the `onMounted` initial load (one-time, not a problem)

### 5. Debounce SSE-Triggered API Calls

- **`profile:updated`**: Debounce `loadCommunityProfiles()` + `loadCommunityReadOnlyProfiles()` to max once per 2s. During any-sync sync, multiple profile updates fire rapidly — debouncing collapses these into a single API call.
- **`chat:reaction:add` / `chat:reaction:remove`**: Instead of full `loadMessages()` reload, update the reaction in-place on the local message object. The SSE event data already contains `messageId`, `emoji`, `senderAid` — enough to patch locally.

## Projected Impact

| Metric | Before | After |
|---|---|---|
| KERIA notifications calls/min | ~36 | 2 |
| KERIA credentials calls/min | ~12 | 2 |
| fetchOrgConfig network calls/min | ~24 | 0 (cached at startup) |
| SSE connections | 2 | 1 |
| Profile poll calls/min | 8 | 0 (event-driven) |
| **Total steady-state requests/min** | **~80+** | **~4-6** |

## Files Affected

### New
- `frontend/src/composables/useKERINotificationService.ts`

### Modified
- `frontend/src/composables/useCredentialPolling.ts` — consume from notification service
- `frontend/src/composables/useRegistrationPolling.ts` — consume from notification service
- `frontend/src/composables/useMultisigJoin.ts` — consume from notification service
- `frontend/src/composables/useBackendEvents.ts` — absorb chat events, add debounce
- `frontend/src/api/config.ts` — add cached org config ref + sync getter
- `frontend/src/layouts/DashboardLayout.vue` — remove profile poll, remove useChatEvents, init notification service + org config

### Deleted
- `frontend/src/composables/useChatEvents.ts`

## Non-Goals

- Moving KERIA polling to the backend (Approach C — future consideration)
- Changing the any-sync periodic diffsync interval (backend/SDK level, separate concern)
- Optimizing the startup burst (one-time cost, acceptable)
