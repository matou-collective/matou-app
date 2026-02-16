# any-sync Rebuild Plan: Development Specification

> Compiled February 2026 from research by: architecture-lead, anyproto-expert, data-model-designer, fact-checker

## Table of Contents

1. [Decision: anytype-heart vs Replicate](#1-decision)
2. [Root Cause Analysis](#2-root-cause-analysis)
3. [Architecture Design](#3-architecture-design)
4. [Data Model](#4-data-model)
5. [Implementation Phases](#5-implementation-phases)
6. [File-by-File Change List](#6-file-by-file-change-list)
7. [Migration Strategy](#7-migration-strategy)
8. [Testing Strategy](#8-testing-strategy)
9. [Risk Assessment](#9-risk-assessment)

---

## 1. Decision

### anytype-heart Cannot Be Used as a Library

**License**: anytype-heart uses the "Any Source Available License 1.0" — a restrictive license that prohibits use as a library in other projects. This was verified by the fact-checker against the actual repository.

**Recommendation: Hybrid Approach**

- **Use any-sync (MIT)** as the protocol/sync layer — it's already a dependency
- **Replicate ~500 LOC of orchestration patterns** from anytype-heart, specifically:
  - Unified tree cache (single instance per tree)
  - TreeSyncer with worker pools (request pool + head pool)
  - WaitMandatoryObjects pattern for sync-readiness
  - Proper SyncTree lifecycle management
- **Do NOT import** anytype-heart or any other restrictively-licensed code

This approach gives us protocol correctness from the MIT-licensed any-sync library while implementing the application-layer patterns ourselves.

---

## 2. Root Cause Analysis

### The Bug (Revised by Fact-Checker)

**Symptom**: Admin approves member → member joins space → member gets all profiles EXCEPT their own (the latest entry).

**Primary causes** (confirmed critical):

| # | Issue | Severity | Why |
|---|-------|----------|-----|
| 3 | `ReadObjects()` destroys live SyncTree on every read | **CRITICAL** | The persistent SyncTree that receives HeadUpdate broadcasts is deleted, replaced by a new tree built from storage. The new tree only has what's been persisted — if HeadSync hasn't run yet, it's stale. |
| 4 | Dual tree cache (sdkTreeManager by treeId + TreeCache by spaceId) | **CRITICAL** | After cache invalidation, the old SyncTree still exists in sdkTreeManager's cache (receiving HeadUpdates), while the new tree in TreeCache is what Matou reads from. Two instances, updates go to the wrong one. |
| 5 | No sync-readiness wait after space join | **HIGH** | No equivalent of anytype-heart's `WaitMandatoryObjects`. Member can read before HeadSync has completed even one cycle. |
| 7 | Admin creates profile AFTER sending invite | **MEDIUM** | Race condition — member may join and read before the profile has propagated to the sync node. |

**Secondary causes** (contribute but don't block):

| # | Issue | Severity | Why |
|---|-------|----------|-----|
| 2 | `StartSync()` is a no-op | **MEDIUM** | No background worker pools. SyncAll works synchronously via HeadSync every 5 seconds, but queued work can be lost. |
| 1 | `noOpSyncStatus` | **LOW** | Fact-checker verified: broadcasts are UNCONDITIONAL in `SyncTree.AddContentWithValidator`. The no-op only affects observability/tracking, not broadcast behavior. |
| 6 | `SyncAll` silently skips failed trees | **LOW** | Fact-checker verified: `BuildSyncTreeOrGetRemote` DOES attempt remote fetch. Silent skip only matters for transient failures. |

### Why the Bug Manifests Consistently

The combination of Issues 3 + 4 creates a deterministic failure:

1. Admin calls `AddObject()` → SyncTree broadcasts HeadUpdate to sync node ✓
2. Member joins space → HeadSync starts, SyncTree created in sdkTreeManager cache ✓
3. Member's frontend calls `GET /api/v1/profiles` → `ReadObjects()` runs
4. `ReadObjects()` calls `m.trees.Delete(spaceID)` — destroys the SyncTree in TreeCache
5. `ReadObjects()` calls `m.loadTree()` → `discoverTree()` → `builder.BuildTree()` — creates a NEW tree from storage
6. The NEW tree is stored in TreeCache. The OLD SyncTree still lives in sdkTreeManager.cache
7. The new tree only has what's in local storage (may not include the latest profile yet)
8. Future HeadUpdates arrive at the OLD tree (via sdkTreeManager), never reaching the NEW tree in TreeCache
9. The member never sees the latest profile

---

## 3. Architecture Design

### Current Architecture (Problems)

```
sdkTreeManager.cache (by treeId) ─── SyncTree A ← receives HeadUpdates
                                         │
                                    (disconnected)
                                         │
TreeCache (by spaceId) ──────────── SyncTree B ← Matou reads from this
                                    (rebuilt from storage on every read)
```

### Target Architecture

```
UnifiedTreeManager
  └── cache (by treeId) ─── SyncTree ← receives HeadUpdates
        │                      │         AND Matou reads from this
        │                      │
        └── spaceIndex (spaceId → []treeId) ← for space-level lookups
```

**Key principles**:
1. **One SyncTree instance per tree** — used by both sync protocol and application reads
2. **Never destroy a live SyncTree** — reads use the live tree, not rebuilt copies
3. **Wait for sync before reading** — after joining a space, block until initial sync completes
4. **Profile creation before invite** — reorder admin flow to eliminate race condition

### Component Architecture

```
┌─────────────────────────────────────────────────┐
│                   API Layer                       │
│  profiles.go  spaces.go  credentials.go          │
├─────────────────────────────────────────────────┤
│              Space Manager                        │
│  (owns UnifiedTreeManager, ACLManager)           │
├──────────────┬──────────────────────────────────┤
│ ObjectTreeManager │ CredentialTreeManager        │
│ (reads/writes     │ (reads/writes                │
│  via unified      │  via unified                 │
│  tree manager)    │  tree manager)               │
├──────────────┴──────────────────────────────────┤
│           UnifiedTreeManager                      │
│  - Single cache: treeId → SyncTree               │
│  - Space index: spaceId → []treeId               │
│  - Implements treemanager.TreeManager             │
│  - Used by BOTH sync protocol and app logic      │
├─────────────────────────────────────────────────┤
│           any-sync SDK (MIT)                      │
│  SpaceService, HeadSync, TreeSync, ACL           │
└─────────────────────────────────────────────────┘
```

---

## 4. Data Model

### Space Architecture (Unchanged)

| Space | Purpose | Write Access | Read Access |
|-------|---------|-------------|-------------|
| Private | User's personal data | Owner only | Owner only |
| Community | Shared writable data (SharedProfile) | All members | All members |
| Community-Readonly | Admin-managed data (CommunityProfile) | Admin only | All members |
| Admin | Administrative data | Admins only | Admins only |

### Object Types — Tree-per-Object Model

Each object gets its own ObjectTree, identified by a `TreeRootHeader` in the root change's unencrypted `ChangePayload`. This matches the anytype-heart architecture where every object is its own tree.

**Tree root identification**:
- Root change `ChangeType`: `"matou.profile.v1"` or `"matou.credential.v1"`
- Root change `ChangePayload`: JSON-encoded `TreeRootHeader{ObjectID, ObjectType}`
- `BuildSpaceIndex()` scans `StoredIds()` and reads root headers to populate indexes

**Object types**:
- `SharedProfile` — member-editable profile in community space (one tree per member)
- `CommunityProfile` — admin-managed profile in community-readonly space (one tree per member)
- `PrivateProfile` — private user data in private space (one tree per user)
- Credentials — via CredentialTreeManager, one tree per credential (`"matou.credential.v1"`)

**Future extensibility**:
- Chat messages, projects, contributions, governance proposals
- Each would create its own tree with a unique `ChangeType` and `ObjectType`

### Change Format — Incremental Field Operations

Changes use incremental `ChangeOp` operations (matching anytype-heart's `StoreKeySet`/`StoreKeyUnset` pattern) rather than full object replacement:

```go
type ChangeOp struct {
    Op    string          `json:"op"`              // "set" | "unset"
    Field string          `json:"field"`           // field name
    Value json.RawMessage `json:"value,omitempty"` // field value (for "set" only)
}

type ObjectChange struct {
    Ops []ChangeOp `json:"ops"`
}
```

State is reconstructed by `BuildState()` which replays ops from tree history. `DiffState()` computes minimal ops for updates. Snapshots (`IsSnapshot=true`) are created every 10 changes for efficient reads.

### ObjectState (Replaces ObjectPayload for Internal Use)

```go
type ObjectState struct {
    ObjectID   string                     `json:"id"`
    ObjectType string                     `json:"type"`
    Fields     map[string]json.RawMessage `json:"fields"`
    OwnerKey   string                     `json:"ownerKey"`
    Version    int                        `json:"version"`
    HeadID     string                     `json:"headId"`
    Timestamp  int64                      `json:"timestamp"`
}
```

`ObjectState.ToJSON()` returns a flat JSON object matching the legacy `ObjectPayload.Data` format for backward-compatible API responses.

---

## 5. Implementation Phases

### Phase 1: Fix the Bug (Issues 3 + 4)

**Goal**: Eliminate the dual-cache problem and stop destroying SyncTrees on reads.

**Changes**:

1. **Create `UnifiedTreeManager`** — replaces both `sdkTreeManager.cache` and `TreeCache`
   - Single `sync.Map` keyed by treeId
   - Space index `sync.Map` keyed by spaceId → treeId for lookup
   - Implements `treemanager.TreeManager` interface
   - Used by sdkTreeManager (for sync protocol) AND ObjectTreeManager/CredentialTreeManager (for app reads)

2. **Remove cache invalidation from `ReadObjects()` and `ReadCredentials()`**
   - Delete the `m.trees.Delete(spaceID)` calls
   - Read directly from the live SyncTree (which receives HeadUpdates)

3. **Update `ObjectTreeManager` and `CredentialTreeManager`** to use the unified cache
   - Replace `TreeCache` field with a reference to `UnifiedTreeManager`
   - `loadTree()` looks up by spaceId via the space index
   - `discoverTree()` registers found trees in the unified cache

**Expected outcome**: The live SyncTree that receives HeadUpdates is the same one that `ReadObjects()` reads from. No more stale reads.

### Phase 2: Sync-Readiness After Join (Issue 5)

**Goal**: Ensure data is available before serving reads after a member joins a space.

**Changes**:

1. **Add `WaitForSync()` method** to the unified tree manager
   - After joining a space, trigger an explicit HeadSync cycle
   - Poll until the tree has content (heads > 0) or timeout (30 seconds)
   - Use exponential backoff: 200ms, 400ms, 800ms, 1.6s, 3.2s...

2. **Integrate into space join flow**
   - In `sdk_client.go`, after `JoinWithInvite()` succeeds, call `WaitForSync()`
   - The join API response is only sent after sync completes (or timeout with warning)

3. **Add sync-status endpoint** (optional, for frontend polling)
   - `GET /api/v1/sync/status?spaceId=...` returns `{synced: bool, heads: [...], lastSync: ...}`

**Expected outcome**: Member's first read after joining always has data.

### Phase 3: Reorder Admin Flow (Issue 7)

**Goal**: Create the member's profile BEFORE generating the invite, eliminating the race condition.

**Changes**:

1. **In `useAdminActions.ts`**, reorder the approval flow:
   ```
   BEFORE: (1) Generate invite → (2) Issue credential → (3) Create profiles
   AFTER:  (1) Create profiles → (2) Generate invite → (3) Issue credential
   ```

2. **In `HandleInitMemberProfiles`** (profiles.go), add an optional `waitForSync` parameter
   - When true, wait for the profile to propagate to the sync node before returning
   - This gives the profile maximum time to propagate before the member joins

**Expected outcome**: Profile is already in the sync node before the member even receives the invite.

### Phase 4: Persistent Worker Pools for Tree Sync (Issue 2)

**Goal**: Background processing of sync work for reliability and performance.

**Implementation** (note: `StartSync()`/`StopSync()` are declared by the `treesyncer.TreeSyncer` interface but are **never called** by the any-sync SDK — only `SyncAll()` is invoked by HeadSync's DiffSyncer every ~5 seconds):

1. **Create persistent worker pools in `Init()`** (not `StartSync()`):
   - Missing tree pool: 10 workers with buffered channel (256 items)
   - Existing tree pool: 4 workers with buffered channel (256 items)
   - Workers persist for the lifetime of the space, shut down in `Close()`

2. **`SyncAll()` queues work items** into the persistent channels:
   - Missing trees → missing pool (full fetch via BuildSyncTreeOrGetRemote)
   - Existing trees → existing pool (lightweight head updates)
   - Non-blocking with context cancellation support

3. **`StartSync()`/`StopSync()` remain no-ops** — documented as interface requirements never invoked by the SDK

**Expected outcome**: Sync work is processed by persistent goroutines, avoiding per-cycle goroutine creation/destruction overhead (~200 cycles/second under load).

### Phase 5: Observability and Error Handling (Issues 1 + 6)

**Goal**: Better visibility into sync state for debugging.

**Implementation**:

1. **`matouSyncStatus`** implements `syncstatus.StatusUpdater`:
   - Tracks `HeadsChange` (local changes), `HeadsReceive` (peer updates), `HeadsApply` (merged)
   - `GetStatus()` returns aggregate counts (treesChanged, headsReceived, headsApplied)
   - Registered per-space on `UnifiedTreeManager` via `RegisterSyncStatus()`

2. **Sync metrics exposed via API** (`GET /api/v1/spaces/sync-status`):
   - Each `SpaceSyncStatus` includes an optional `sync` field with `SyncMetrics`
   - `SyncMetrics`: `treesChanged`, `headsReceived`, `headsApplied`
   - Allows frontend/debugging to observe P2P sync activity

3. **Error logging in `SyncAll()`**:
   - Logs warnings for failed `GetTree()` and `SyncWithPeer()` calls
   - Includes tree ID and peer ID for debugging

**Expected outcome**: When sync issues occur, logs and API metrics reveal the problem.

---

## 6. File-by-File Change List

### Phase 1: Fix the Bug

| File | Action | Description |
|------|--------|-------------|
| `backend/internal/anysync/unified_tree_manager.go` | **CREATE** | New file: `UnifiedTreeManager` struct with single cache (treeId → ObjectTree) and space index (spaceId → treeId). Implements `treemanager.TreeManager`. Methods: `GetTree()`, `RegisterTree()`, `GetTreeForSpace()`, `RegisterSpaceTree()`. |
| `backend/internal/anysync/credential_tree.go` | **MODIFY** | Remove `TreeCache` struct entirely. Change `CredentialTreeManager.trees` field from `*TreeCache` to `*UnifiedTreeManager`. Update `Load()`, `Store()`, `Delete()` calls to use unified manager's methods. Remove cache invalidation in `ReadCredentials()`. |
| `backend/internal/anysync/object_tree.go` | **MODIFY** | Change `ObjectTreeManager.trees` field from `*TreeCache` to `*UnifiedTreeManager`. Remove `m.trees.Delete(spaceID)` from `ReadObjects()`. Update `discoverTree()` to register in unified cache. Update `loadTree()` to use space index lookup. |
| `backend/internal/anysync/sdk_client.go` | **MODIFY** | Remove `sdkTreeManager.cache sync.Map`. Have `sdkTreeManager` delegate to `UnifiedTreeManager`. Pass `UnifiedTreeManager` instance to both sdkTreeManager and SpaceManager. |
| `backend/internal/anysync/spaces.go` | **MODIFY** | Change `SpaceManager.treeCache` from `*TreeCache` to `*UnifiedTreeManager`. Update `NewSpaceManager()` to create `UnifiedTreeManager`. Pass it to both `ObjectTreeManager` and `CredentialTreeManager`. |

### Phase 2: Sync-Readiness

| File | Action | Description |
|------|--------|-------------|
| `backend/internal/anysync/unified_tree_manager.go` | **MODIFY** | Add `WaitForSync(ctx, spaceId, timeout)` method. Polls tree existence and head count with exponential backoff. |
| `backend/internal/anysync/sdk_client.go` | **MODIFY** | After `JoinWithInvite()`, call `WaitForSync()`. Update `JoinSpace()` to block until sync-ready. |
| `backend/internal/api/spaces.go` | **MODIFY** | Update join endpoint to return sync status. Add `GET /api/v1/sync/status` endpoint. |

### Phase 3: Reorder Admin Flow

| File | Action | Description |
|------|--------|-------------|
| `frontend/src/composables/useAdminActions.ts` | **MODIFY** | Move `initMemberProfiles()` call BEFORE `fetch(.../invite)` and `issueCredential()`. |
| `backend/internal/api/profiles.go` | **MODIFY** | Add optional `waitForSync` field to `InitMemberProfilesRequest`. When true, verify the profile's HeadUpdate was acknowledged before returning. |

### Phase 4: Worker Pools

| File | Action | Description |
|------|--------|-------------|
| `backend/internal/anysync/tree_syncer.go` | **CREATE** | New file: `MatouTreeSyncer` with request pool (10 workers) and head pool (1 per peer). Uses `syncqueues` for work items. Implements `treesyncer.TreeSyncer`. |
| `backend/internal/anysync/sdk_client.go` | **MODIFY** | Replace inline `matouTreeSyncer` with the new `MatouTreeSyncer` from `tree_syncer.go`. Update `newSpaceDeps()`. |

### Phase 5: Observability

| File | Action | Description |
|------|--------|-------------|
| `backend/internal/anysync/sync_status.go` | **CREATE** | New file: `matouSyncStatus` implementing `syncstatus.StatusUpdater`. Tracks HeadsChange, HeadsReceive, HeadsApply. Exposes metrics. |
| `backend/internal/anysync/sdk_client.go` | **MODIFY** | Replace `noOpSyncStatus{}` with `newMatouSyncStatus()` in `newSpaceDeps()`. |
| `backend/internal/anysync/sdk_client.go` | **MODIFY** | Add error logging in `matouTreeSyncer.SyncAll()` for failed GetTree/SyncWithPeer calls. |

---

## 7. Migration Strategy

### Pre-Production Status

The application is pre-production. There are no live users to migrate. This simplifies the approach:

1. **Clean break**: No backwards-compatibility shims needed
2. **Data reset**: Test environments can be reset with `make testnet-down && make testnet-up`
3. **No data migration**: Existing test data in any-sync spaces can be discarded

### Implementation Steps

1. **Branch**: Create `feat/anysync-rebuild` branch from `main`
2. **Phase 1 first**: Implement unified cache. This alone should fix the bug.
3. **Test Phase 1**: Run integration tests, verify the profile sync bug is fixed
4. **Phases 2-5**: Implement incrementally, testing each phase
5. **Clean test data**: After implementation, reset test network to start fresh
6. **Merge**: Squash-merge to `main` when all phases pass

### Backwards Compatibility

- `ObjectPayload` struct: replaced internally by `ObjectState` + `ChangeOp` operations, but `ObjectState.ToJSON()` produces the same API response format
- `CredentialPayload` struct: **unchanged** — used as input to `AddCredential()`, which creates a tree with incremental ops internally
- API endpoints: **unchanged** — same routes, same request/response format. Sync-status endpoint now includes sync metrics.
- Frontend: Only change is reordering calls in `useAdminActions.ts` (Phase 3)
- Config files: **unchanged**
- Data format: **breaking** — tree-per-object model is incompatible with single-tree-per-space. Test networks must be reset (`make testnet-down && make testnet-up`).

---

## 8. Testing Strategy

### Unit Tests

| Test | File | Verifies |
|------|------|----------|
| UnifiedTreeManager.GetTree | `unified_tree_manager_test.go` | Single instance returned for same treeId |
| UnifiedTreeManager.RegisterSpaceTree | `unified_tree_manager_test.go` | Space index correctly maps spaceId → treeId |
| UnifiedTreeManager.WaitForSync | `unified_tree_manager_test.go` | Blocks until heads appear, respects timeout |
| ReadObjects without cache invalidation | `object_tree_test.go` | Live tree is returned, not rebuilt copy |
| ReadCredentials without cache invalidation | `credential_tree_test.go` | Live tree is returned, not rebuilt copy |
| MatouTreeSyncer worker pools | `tree_syncer_test.go` | Missing and existing trees are queued correctly |
| matouSyncStatus tracking | `sync_status_test.go` | HeadsChange/HeadsReceive are recorded |

### Integration Tests

| Test | Description |
|------|-------------|
| Profile sync after approval | Admin creates profile → member joins → member reads → profile is present |
| Concurrent reads during sync | Multiple goroutines read while HeadSync is running — no panics or stale data |
| Join and immediate read | Member joins space and immediately reads — data is available (Phase 2) |
| Admin flow ordering | Profile creation happens before invite — verified via timestamps |
| SyncAll retry | Simulate transient failure in GetTree — verify retry succeeds |

### E2E Tests

Update `frontend/tests/e2e/e2e-registration.spec.ts`:

1. Admin approves registration
2. Member receives credential and joins space
3. Member can see their own profile in the community profiles list
4. No artificial timeouts needed (sync-readiness handles the wait)

### Manual Verification

1. Start test network: `make testnet-up`
2. Run backend in test mode: `make run-test`
3. Run frontend in test mode: `npm run dev`
4. Complete full registration → approval → join flow
5. Verify all profiles (including the latest) appear on member's dashboard

---

## 9. Risk Assessment

### High Risk

| Risk | Mitigation |
|------|-----------|
| Unified cache introduces memory leaks (trees never freed) | Add `Close()` method to UnifiedTreeManager that clears cache on space close. Monitor memory in integration tests. |
| WaitForSync blocks indefinitely | Hard timeout of 30 seconds. Return partial data with warning rather than failing. |

### Medium Risk

| Risk | Mitigation |
|------|-----------|
| Worker pools in Phase 4 introduce concurrency bugs | Use `syncqueues` from any-sync (battle-tested). Extensive unit tests with race detector. |
| Reordering admin flow breaks credential issuance | The IPEX grant message with invite data is independent of profile creation. Credential data doesn't reference the profile. Test the full flow. |

### Low Risk

| Risk | Mitigation |
|------|-----------|
| Removing cache invalidation causes stale reads for local-only changes | `AddContent()` on the live SyncTree updates it in-place. No rebuild needed. |
| any-sync API changes in future versions | Pin dependency version. The MIT-licensed any-sync API has been stable. |

---

## Appendix A: Key anyproto Patterns to Replicate

### A1. Unified Tree Cache (from anytype-heart)

anytype-heart's `TreeManager` maintains ONE cache. When `GetTree()` is called, it returns the same SyncTree instance used by the sync protocol. There is no separate "application cache" — the sync tree IS the application's view of the data.

```go
// Pattern to replicate (our implementation, not copied code):
type UnifiedTreeManager struct {
    mu         sync.RWMutex
    byTreeId   sync.Map // treeId → objecttree.ObjectTree
    bySpaceId  sync.Map // spaceId → treeId (for space-level lookups)
}

func (u *UnifiedTreeManager) GetTree(ctx context.Context, spaceId, treeId string) (objecttree.ObjectTree, error) {
    if val, ok := u.byTreeId.Load(treeId); ok {
        return val.(objecttree.ObjectTree), nil
    }
    // Build from storage, register in cache, return
}

func (u *UnifiedTreeManager) GetTreeForSpace(spaceId string) (objecttree.ObjectTree, bool) {
    treeId, ok := u.bySpaceId.Load(spaceId)
    if !ok {
        return nil, false
    }
    return u.byTreeId.Load(treeId.(string))
}
```

### A2. WaitMandatoryObjects (from anytype-heart)

anytype-heart blocks on space loading until critical objects are synced. The pattern:

1. After space is opened, check if mandatory objects exist in storage
2. If not, wait with exponential backoff (200ms to 20s)
3. Each retry triggers a HeadSync check
4. Once objects appear, proceed

```go
// Pattern to replicate:
func (u *UnifiedTreeManager) WaitForSync(ctx context.Context, spaceId string, timeout time.Duration) error {
    deadline := time.Now().Add(timeout)
    backoff := 200 * time.Millisecond

    for time.Now().Before(deadline) {
        if tree, ok := u.GetTreeForSpace(spaceId); ok {
            tree.Lock()
            hasContent := len(tree.Heads()) > 1 // More than just root
            tree.Unlock()
            if hasContent {
                return nil
            }
        }

        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-time.After(backoff):
            backoff = min(backoff*2, 5*time.Second)
        }
    }
    return fmt.Errorf("sync not completed within %v for space %s", timeout, spaceId)
}
```

### A3. TreeSyncer Worker Pools (from anytype-heart)

anytype-heart's TreeSyncer uses:
- **Request pool**: 10 goroutine workers processing missing tree requests
- **Head pool**: 1 goroutine worker per peer processing existing tree updates
- Both use `syncqueues.Queue` for thread-safe work queuing with deduplication

```go
// Pattern to replicate:
type MatouTreeSyncer struct {
    spaceId     string
    treeManager treemanager.TreeManager
    requestPool *syncqueues.Queue // missing trees
    headPools   sync.Map          // peerId → *syncqueues.Queue
}

func (t *MatouTreeSyncer) StartSync() {
    t.requestPool = syncqueues.NewQueue(10, t.processRequest)
    // Head pools created lazily per peer
}

func (t *MatouTreeSyncer) SyncAll(ctx context.Context, p peer.Peer, existing, missing []string) error {
    for _, id := range missing {
        t.requestPool.Add(syncWork{treeId: id, peer: p})
    }
    headPool := t.getOrCreateHeadPool(p.Id())
    for _, id := range existing {
        headPool.Add(syncWork{treeId: id, peer: p})
    }
    return nil
}
```

---

## Appendix B: Fact-Checker Corrections

The following corrections were made to the original research by the fact-checker:

1. **noOpSyncStatus (Issue 1)**: Demoted from CRITICAL to LOW. Broadcasts in `SyncTree.AddContentWithValidator` are unconditional — they happen regardless of sync status implementation. The no-op only affects observability.

2. **StartSync no-op (Issue 2)**: Demoted from CRITICAL to MEDIUM. `SyncAll()` IS functional and runs synchronously during HeadSync cycles (every 5 seconds). It's slower than background workers but works.

3. **SyncAll silent skip (Issue 6)**: Demoted from SHOULD FIX to LOW. `BuildSyncTreeOrGetRemote` does attempt remote fetch via `treeRemoteGetter`. The silent skip only matters for transient network failures.

4. **HeadSync interval**: The original report said "minimum 1 minute". Correction: the 1-minute parameter is the per-operation timeout, not the interval. With `SyncPeriod=5`, HeadSync runs every 5 seconds.

5. **SyncWithPeer behavior**: Uses `QueueRequest` internally — it's async. The `SyncAll` call dispatches work but doesn't wait for completion.

6. **ACL permission levels**: The original report missed `None` (0) and `Guest` (5) permission levels.

These corrections significantly changed the priority ordering. Issues 3+4 are confirmed as the real blockers, while Issues 1, 2, and 6 are quality-of-life improvements.
