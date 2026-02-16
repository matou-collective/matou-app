# any-sync / Matou Comparison: Identified Issues and Required Changes

> Analysis compiled by the anysync-research team, February 2026

## The Bug

**Symptom**: When admin approves a new member, the member joins the space, retrieves all profile records EXCEPT their own (the latest entry created during approval). Even waiting several minutes does not resolve this.

**Root cause**: Multiple compounding issues in how Matou manages SyncTree lifecycle, sync status, and tree caching — all of which prevent reliable propagation of the latest changes.

---

## Critical Issues (Ordered by Impact)

### Issue 1: `noOpSyncStatus` Disables Sync Tracking

**File**: `backend/internal/anysync/sdk_client.go:1322-1331`

```go
type noOpSyncStatus struct{}
func (n *noOpSyncStatus) HeadsChange(treeId string, heads []string)                {}
func (n *noOpSyncStatus) HeadsReceive(senderId, treeId string, heads []string)     {}
func (n *noOpSyncStatus) ObjectReceive(senderId, treeId string, heads []string)    {}
func (n *noOpSyncStatus) HeadsApply(senderId, treeId string, heads []string, allAdded bool) {}
```

**Problem**: When SyncTree calls `syncStatus.HeadsChange()` after `AddContent()`, this is a no-op. The SyncTree uses sync status to determine whether a HeadUpdate broadcast is needed and to track what has been synced. With a no-op implementation, **the SyncTree may not correctly track what needs to be broadcast or may skip broadcasting entirely**.

**anytype-heart pattern**: Uses a real `syncstatus.StatusUpdater` that tracks head changes, receives, and applications. This is used by the SyncTree to manage sync state.

**Fix**: Implement a real sync status tracker that records head changes. At minimum, `HeadsChange` must function correctly for the SyncTree's broadcast logic to work.

---

### Issue 2: `matouTreeSyncer.StartSync()` Is a No-Op

**File**: `backend/internal/anysync/sdk_client.go:1356`

```go
func (t *matouTreeSyncer) StartSync() {}
```

**Problem**: In any-sync's space initialization flow, `StartSync()` is called after the space is loaded and mandatory objects are ready. In anytype-heart, this activates **request pools** (10 workers for missing trees) and **head pools** (1 worker per peer for existing trees) that process sync work asynchronously in the background.

With a no-op `StartSync()`, tree sync only happens during the synchronous `SyncAll()` call from HeadSync's DiffSyncer. There are **no background workers** processing sync requests, so any sync work that fails or is queued gets lost.

**Fix**: Either implement background worker pools like anytype-heart, or ensure `SyncAll()` is robust enough to handle all sync work synchronously (with retries).

---

### Issue 3: Tree Cache Invalidation Destroys Live SyncTree Subscriptions

**File**: `backend/internal/anysync/object_tree.go:89-96`

```go
func (m *ObjectTreeManager) ReadObjects(ctx context.Context, spaceID string) ([]*ObjectPayload, error) {
    if m.client != nil {
        m.trees.Delete(spaceID)  // Destroys the live SyncTree!
    }
    tree, err := m.loadTree(ctx, spaceID)  // Builds a NEW SyncTree from storage
```

**Problem**: Every read operation:
1. Deletes the cached SyncTree (which is subscribed to receive HeadUpdate broadcasts)
2. Builds a brand new SyncTree from local storage
3. The new SyncTree starts with only what's in local storage
4. Immediately reads from it (before any async sync can complete)

This means:
- Between the delete and rebuild, there is a **window where no SyncTree is receiving updates** for this space
- The rebuilt tree only reflects what's already persisted in local storage
- If HeadSync hasn't completed yet (changes not in storage), the tree is stale
- The new SyncTree broadcasts its heads on creation, but **doesn't wait for sync responses before the read happens**

**anytype-heart pattern**: Maintains persistent SyncTree instances. Does not rebuild from storage on every read. Uses `WaitMandatoryObjects` during space loading to ensure data is available before reads.

**Fix**: Stop invalidating the tree cache on every read. Instead:
- Keep the SyncTree alive and let it receive real-time HeadUpdate broadcasts
- After joining a space, wait for initial sync to complete before reading
- If cache invalidation is truly needed, implement a `SyncWithPeer()` call and wait for it to complete before reading

---

### Issue 4: Dual Tree Cache Causes Stale References

**Files**:
- `backend/internal/anysync/sdk_client.go:1096` — `sdkTreeManager.cache sync.Map` (keyed by **treeId**)
- `backend/internal/anysync/credential_tree.go:37` — `TreeCache.trees sync.Map` (keyed by **spaceId**)

**Problem**: Two independent caches store the same trees:
- `sdkTreeManager` caches by treeId (used by sync protocol, stream handler, TreeSyncer)
- `TreeCache` caches by spaceId (used by ObjectTreeManager and CredentialTreeManager for reads/writes)

When `ReadObjects` deletes from `TreeCache` and rebuilds:
- The old SyncTree still exists in `sdkTreeManager.cache`
- A new SyncTree is created and stored in `TreeCache`
- Now **two SyncTree instances exist for the same tree**: one in sdkTreeManager (sync-active but orphaned from Matou's perspective) and one in TreeCache (Matou reads from this one)
- HeadUpdate broadcasts might be delivered to the old instance in sdkTreeManager, not the new one in TreeCache

**anytype-heart pattern**: Uses a single tree manager with one cache. The `TreeManager.GetTree()` returns the same instance used by both sync and application logic.

**Fix**: Unify the tree caches. Either:
- Have ObjectTreeManager/CredentialTreeManager use sdkTreeManager's cache (look up by treeId)
- Or remove sdkTreeManager's cache and use TreeCache everywhere
- Ensure that only ONE SyncTree instance exists per tree

---

### Issue 5: No "Wait for Sync" After Space Join

**File**: `backend/internal/anysync/sdk_client.go:1313-1319` (newSpaceDeps)

**Problem**: When a new member joins a space, there is no mechanism to wait for initial sync to complete. The member's backend:
1. Calls `JoinWithInvite` (ACL join)
2. Space is opened via `sdkSpaceResolver.GetSpace()`
3. HeadSync starts running periodically (every `SyncPeriod` seconds — currently 5)
4. The frontend can immediately call GET /api/v1/profiles which reads from storage

But HeadSync hasn't completed yet! The first HeadSync cycle needs time to:
- Compare diffs with the sync node
- Discover missing trees
- Fetch those trees
- Apply changes to local storage

**anytype-heart pattern**: `WaitMandatoryObjects(ctx)` blocks until critical objects are synchronized. Uses exponential backoff retry (up to 20 seconds). Only then proceeds to make the space available for reads.

**Fix**: After joining a space, implement a sync-readiness check:
- Option A: Block the join response until initial HeadSync completes and objects are in storage
- Option B: Add a sync-status endpoint that the frontend polls before reading profiles
- Option C: In ReadObjects, if no objects are found, trigger an explicit `SyncWithPeer()` and retry

---

### Issue 6: `SyncAll` Silently Skips Failed Trees

**File**: `backend/internal/anysync/sdk_client.go:1360-1386`

```go
func (t *matouTreeSyncer) SyncAll(ctx context.Context, p peer.Peer, existing, missing []string) error {
    for _, id := range missing {
        tr, err := t.treeManager.GetTree(peerCtx, t.spaceId, id)
        if err != nil {
            continue  // Silently skip!
        }
```

**Problem**: For missing trees (ones the member doesn't have locally), `GetTree` calls `BuildTree` which tries to build from local storage. If the tree doesn't exist in local storage yet (which is the case for missing trees!), BuildTree may fail. The error is silently ignored with `continue`.

The any-sync `BuildTree` implementation may or may not attempt remote fetching depending on internal logic and the presence of a peer ID in context. If it fails, the tree is simply skipped and will be retried on the next HeadSync cycle (5 seconds later). But by then, the member may have already read stale data.

**anytype-heart pattern**: Uses dedicated request pool workers with retry logic. Missing trees are queued for async download with proper error handling.

**Fix**: Add error logging at minimum. Better: implement retry logic or use `BuildSyncTreeOrGetRemote` explicitly for missing trees.

---

### Issue 7: Admin Creates Profile After Invite — No Sync Guarantee

**File**: `frontend/src/composables/useAdminActions.ts:181-258`

```typescript
// 4b. Generate space invite BEFORE issuing credential
const inviteResponse = await fetch(`${BACKEND_URL}/api/v1/spaces/community/invite`, ...);

// 4. Issue credential (with invite embedded)
const credResult = await keriClient.issueCredential(...);

// 5b. Initialize member's CommunityProfile (AFTER invite + credential)
const initResult = await initMemberProfiles({...});
```

**Problem**: The admin's approval flow:
1. Creates invite keys
2. Issues credential (with invite keys embedded in IPEX grant message)
3. Creates CommunityProfile and SharedProfile

Step 3 happens AFTER the invite keys are created and the credential is issued. The member receives the credential via KERI IPEX, extracts invite keys, and joins the space. But the CommunityProfile from step 3 might not have propagated to the sync node yet when the member joins.

While `AddContent()` broadcasts a HeadUpdate immediately, there is no guarantee the sync node has received and stored it before the member's first HeadSync. Combined with Issues 1-5 above, this creates a race condition where the latest profile is consistently missing.

**Fix**: Either:
- Create the profile BEFORE generating the invite (so it has more time to propagate)
- Add an explicit sync confirmation step after creating the profile
- Have the member's backend wait for sync completion before serving reads

---

## Summary of Changes Needed

### Must Fix (Blocking the bug)

| # | Change | File(s) | Effort |
|---|--------|---------|--------|
| 1 | Implement real sync status tracker | `sdk_client.go` | Medium |
| 2 | Implement `StartSync()` or ensure SyncAll is robust | `sdk_client.go` | Medium |
| 3 | Stop destroying SyncTree on every read | `object_tree.go`, `credential_tree.go` | Medium |
| 4 | Unify tree caches (sdkTreeManager + TreeCache) | `sdk_client.go`, `credential_tree.go`, `object_tree.go` | High |
| 5 | Add sync-readiness wait after space join | `sdk_client.go` + new endpoint or frontend logic | Medium |

### Should Fix (Reliability)

| # | Change | File(s) | Effort |
|---|--------|---------|--------|
| 6 | Add error logging/retry in SyncAll | `sdk_client.go` | Low |
| 7 | Reorder admin flow: create profile before invite | `useAdminActions.ts`, `profiles.go` | Low |

### Recommended Approach

The most impactful single change is **Issue 3** (stop destroying SyncTree on reads). This alone would likely fix the bug in most cases, because:

1. The admin's `AddContent()` would broadcast to the node via the persistent SyncTree
2. The member's persistent SyncTree would receive HeadUpdate broadcasts from the node
3. Reads would see the live tree state including all received changes

However, for production reliability, all issues should be addressed. The recommended implementation order:

1. **First**: Fix Issue 3 (stop cache invalidation on reads) — immediate bug fix
2. **Second**: Fix Issue 4 (unify caches) — prevents duplicate SyncTree instances
3. **Third**: Fix Issue 5 (sync-readiness after join) — ensures member has data before reading
4. **Fourth**: Fix Issues 1 and 2 (sync status + StartSync) — ensures protocol correctness
5. **Fifth**: Fix Issues 6 and 7 (error handling + flow reorder) — reliability improvements

---

## Detailed Code Change Proposals

### Proposal for Issue 3: Persistent SyncTree

Replace the cache-invalidation pattern in ReadObjects/ReadCredentials:

```go
// BEFORE (current):
func (m *ObjectTreeManager) ReadObjects(ctx context.Context, spaceID string) ([]*ObjectPayload, error) {
    if m.client != nil {
        m.trees.Delete(spaceID)  // BAD: destroys live SyncTree
    }
    tree, err := m.loadTree(ctx, spaceID)
    // ... reads from rebuilt tree (may be stale)
}

// AFTER (proposed):
func (m *ObjectTreeManager) ReadObjects(ctx context.Context, spaceID string) ([]*ObjectPayload, error) {
    tree, err := m.loadTree(ctx, spaceID)
    if err != nil {
        return nil, err
    }
    // Tree is the persistent SyncTree — it receives HeadUpdate broadcasts
    // and reflects the latest state including changes from peers
    // No cache invalidation needed!

    tree.Lock()
    defer tree.Unlock()
    // ... iterate and read as before
}
```

The key insight: if you keep the SyncTree alive, it **automatically receives** HeadUpdate broadcasts from the sync node and applies them. You don't need to rebuild from storage because the live tree IS the most up-to-date view.

### Proposal for Issue 5: Sync-Readiness After Join

Add a method that waits for initial sync after joining a space:

```go
func (m *SpaceManager) WaitForInitialSync(ctx context.Context, spaceID string, timeout time.Duration) error {
    deadline := time.Now().Add(timeout)

    for time.Now().Before(deadline) {
        // Check if the tree exists and has been synced
        if tree, ok := m.treeCache.Load(spaceID); ok {
            tree.Lock()
            heads := tree.Heads()
            tree.Unlock()
            if len(heads) > 0 {
                // Tree exists and has content — sync has started
                // Optionally: compare with node's heads to confirm fully synced
                return nil
            }
        }

        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-time.After(500 * time.Millisecond):
            continue
        }
    }

    return fmt.Errorf("sync not completed within %v", timeout)
}
```

### Proposal for Issue 4: Unified Tree Cache

Replace the dual-cache system with a single cache:

```go
// Single cache used by both sync layer and application layer
type UnifiedTreeCache struct {
    byTreeId  sync.Map // treeId → objecttree.ObjectTree (for sync protocol)
    bySpaceId sync.Map // spaceId → treeId (for application lookups)
}
```

When `sdkTreeManager.GetTree` builds or receives a tree, it registers in the unified cache. When `ObjectTreeManager` needs a tree, it looks up the spaceId → treeId mapping, then gets the same SyncTree instance that the sync layer uses.
