# anyproto vs Proposed Matou: Data Journey Side-by-Side Comparison

> Step-by-step comparison of the anyproto data journey with the proposed Matou rebuild

---

## Journey 1: Object Creation and Local Storage

### Step 1.1: Create a New Object

```
┌─────────────────────────────────────┬─────────────────────────────────────┐
│           ANYPROTO                  │        PROPOSED MATOU               │
├─────────────────────────────────────┼─────────────────────────────────────┤
│                                     │                                     │
│ SmartBlock.Apply(state)             │ ObjectTreeManager.AddObject(        │
│   → object.PushStoreChange()        │     ctx, spaceID, payload, key)     │
│   → creates SignableChangeContent   │   → creates SignableChangeContent   │
│                                     │                                     │
│ Each SmartBlock IS its own tree.    │ Each ObjectPayload gets its own     │
│ The tree was created when the       │ tree. If tree doesn't exist for     │
│ SmartBlock was first instantiated.  │ payload.ID, CreateObjectTree()      │
│                                     │ makes a new one first.              │
│                                     │                                     │
│ TREE-PER-OBJECT ✓                   │ TREE-PER-OBJECT ✓                   │
└─────────────────────────────────────┴─────────────────────────────────────┘
```

**anyproto detail**: In anytype-heart, a SmartBlock wraps an ObjectTree. When a user edits a page, `PushStoreChange()` builds a `SignableChangeContent{Data, Key, IsSnapshot, ShouldBeEncrypted, Timestamp, DataType}` and calls `tree.AddContent()`.

**Proposed Matou detail**: `ObjectTreeManager.AddObject()` checks `treeManager.GetTreeForObject(payload.ID)`. If no tree exists, calls `treeManager.CreateObjectTree(ctx, spaceId, payload.ID, payload.Type, ProfileTreeType, signingKey)` which creates a NEW tree with a root header containing `{objectId, objectType}`. Then adds the content change with the full `ObjectPayload` data.

**Alignment**: Both create one tree per object. Both use `SignableChangeContent`. The object type metadata is accessible from the tree root without decryption.

---

### Step 1.2: Build the Change

```
┌─────────────────────────────────────┬─────────────────────────────────────┐
│           ANYPROTO                  │        PROPOSED MATOU               │
├─────────────────────────────────────┼─────────────────────────────────────┤
│                                     │                                     │
│ changebuilder.go:                   │ Same any-sync code path:            │
│ 1. Encrypt data with read key       │ 1. Encrypt data with read key       │
│ 2. Assemble TreeChange protobuf     │ 2. Assemble TreeChange protobuf     │
│    - previousIds = current heads    │    - previousIds = current heads    │
│    - aclHeadId                      │    - aclHeadId                      │
│    - timestamp, identity, data      │    - timestamp, identity, data      │
│ 3. Marshal + sign with Ed25519      │ 3. Marshal + sign with Ed25519      │
│ 4. Compute CID                      │ 4. Compute CID                      │
│ 5. Wrap as RawTreeChangeWithId      │ 5. Wrap as RawTreeChangeWithId      │
│                                     │                                     │
│ IDENTICAL — same any-sync code ✓    │ IDENTICAL — same any-sync code ✓    │
└─────────────────────────────────────┴─────────────────────────────────────┘
```

**Alignment**: This is handled entirely by any-sync's `changebuilder.go`. Both use the same library code. No difference.

---

### Step 1.3: Add Change to Tree (DAG + Storage)

```
┌─────────────────────────────────────┬─────────────────────────────────────┐
│           ANYPROTO                  │        PROPOSED MATOU               │
├─────────────────────────────────────┼─────────────────────────────────────┤
│                                     │                                     │
│ tree.Lock()                         │ tree.Lock()                         │
│ tree.AddContent(ctx, content)       │ tree.AddContent(ctx, content)       │
│   → change added to internal DAG    │   → change added to internal DAG    │
│   → Storage.AddAll() persists       │   → Storage.AddAll() persists       │
│ tree.Unlock()                       │ tree.Unlock()                       │
│                                     │                                     │
│ Returns AddResult{                  │ Returns AddResult{                  │
│   OldHeads, Heads, Added, Mode      │   OldHeads, Heads, Added, Mode      │
│ }                                   │ }                                   │
│                                     │                                     │
│ Tree is a SyncTree (created via     │ Tree is from UnifiedTreeManager     │
│ PutSyncTree or BuildSyncTree-       │ which calls BuildSyncTreeOrGet-     │
│ OrGetRemote)                        │ Remote — returns SyncTree ✓         │
│                                     │                                     │
│ IDENTICAL — same any-sync code ✓    │ IDENTICAL — same any-sync code ✓    │
└─────────────────────────────────────┴─────────────────────────────────────┘
```

**Alignment**: `AddContent()` is any-sync library code. Both use SyncTrees. The key change from current Matou: trees returned by `UnifiedTreeManager.GetTree()` go through `BuildSyncTreeOrGetRemote`, ensuring they are SyncTrees with sync handlers initialized.

---

### Step 1.4: SyncTree Auto-Broadcast

```
┌─────────────────────────────────────┬─────────────────────────────────────┐
│           ANYPROTO                  │        PROPOSED MATOU               │
├─────────────────────────────────────┼─────────────────────────────────────┤
│                                     │                                     │
│ SyncTree.AddContent() succeeds:     │ SyncTree.AddContent() succeeds:     │
│                                     │                                     │
│ 1. ObjectTree.AddContentWith-       │ 1. ObjectTree.AddContentWith-       │
│    Validator() ✓                    │    Validator() ✓                    │
│                                     │                                     │
│ 2. syncStatus.HeadsChange()         │ 2. syncStatus.HeadsChange()         │
│    → real StatusUpdater tracks      │    → matouSyncStatus tracks         │
│      head changes                   │      head changes (NEW)             │
│                                     │                                     │
│ 3. syncClient.CreateHeadUpdate()    │ 3. syncClient.CreateHeadUpdate()    │
│    → builds HeadUpdate proto msg    │    → builds HeadUpdate proto msg    │
│                                     │                                     │
│ 4. syncClient.Broadcast()           │ 4. syncClient.Broadcast()           │
│    → peerManager.BroadcastMessage() │    → peerManager.BroadcastMessage() │
│    → streamPool.Send() to all       │    → streamPool.Send() to all       │
│      connected peers (incl. node)   │      connected peers (incl. node)   │
│                                     │                                     │
│ Broadcast is UNCONDITIONAL —        │ Broadcast is UNCONDITIONAL —        │
│ happens on every AddContent() ✓     │ happens on every AddContent() ✓     │
│                                     │                                     │
│ IDENTICAL — same any-sync code ✓    │ IDENTICAL — same any-sync code ✓    │
└─────────────────────────────────────┴─────────────────────────────────────┘
```

**Key change from current Matou**: Current Matou uses `noOpSyncStatus` (all methods empty). Proposed Matou uses `matouSyncStatus` which actually tracks changes. Note: the fact-checker confirmed broadcasts are unconditional regardless of SyncStatus implementation, but the real tracker enables observability.

**Alignment**: The broadcast path is identical — it's all any-sync library code. The SyncTree wrapper handles this automatically.

---

### Step 1.5: HeadSync Registration (Automatic)

```
┌─────────────────────────────────────┬─────────────────────────────────────┐
│           ANYPROTO                  │        PROPOSED MATOU               │
├─────────────────────────────────────┼─────────────────────────────────────┤
│                                     │                                     │
│ When tree is stored:                │ When tree is stored:                │
│                                     │                                     │
│ 1. HeadStorage.UpdateEntry()        │ 1. HeadStorage.UpdateEntry()        │
│    records {Id, Heads, Snapshot}    │    records {Id, Heads, Snapshot}    │
│                                     │                                     │
│ 2. OnUpdate() observer fires        │ 2. OnUpdate() observer fires        │
│    → DiffManager.UpdateHeads()      │    → DiffManager.UpdateHeads()      │
│                                     │                                     │
│ 3. ldiff.Add(HashedEl{Id, Hash})    │ 3. ldiff.Add(HashedEl{Id, Hash})   │
│    → tree now visible to HeadSync   │    → tree now visible to HeadSync   │
│                                     │                                     │
│ Each new tree auto-registers.       │ Each new tree auto-registers.       │
│ No manual registration needed.      │ No manual registration needed.      │
│                                     │                                     │
│ With tree-per-object: each new      │ With tree-per-object: each new      │
│ SmartBlock creates a new ldiff      │ profile/credential creates a new    │
│ entry. StoredIds() returns all.     │ ldiff entry. StoredIds() returns    │
│                                     │ all.                                │
│                                     │                                     │
│ IDENTICAL — same any-sync code ✓    │ IDENTICAL — same any-sync code ✓    │
└─────────────────────────────────────┴─────────────────────────────────────┘
```

**Alignment**: This is entirely handled by the any-sync space internals. When `PutTree()` or `AddContent()` persists changes, HeadStorage notifies DiffManager automatically. Both anyproto and proposed Matou benefit from this — it's the same code path.

**Key insight**: With tree-per-object, each profile gets its own ldiff entry. When HeadSync runs, each profile tree is individually discoverable by peers. This is fundamentally different from current Matou where all objects share one ldiff entry (one tree per space).

---

## Journey 2: Sync to Node

### Step 2.1: Immediate Push (HeadUpdate Broadcast)

```
┌─────────────────────────────────────┬─────────────────────────────────────┐
│           ANYPROTO                  │        PROPOSED MATOU               │
├─────────────────────────────────────┼─────────────────────────────────────┤
│                                     │                                     │
│ Peer → broadcasts HeadUpdate        │ Peer → broadcasts HeadUpdate        │
│        to sync node                 │        to sync node                 │
│                                     │                                     │
│ HeadUpdate contains:                │ HeadUpdate contains:                │
│ - treeId (this specific object)     │ - treeId (this specific object)     │
│ - heads (new head CIDs)             │ - heads (new head CIDs)             │
│ - changes (the actual data)         │ - changes (the actual data)         │
│ - snapshotPath                      │ - snapshotPath                      │
│                                     │                                     │
│ Triggered by SyncTree.AddContent()  │ Triggered by SyncTree.AddContent()  │
│ immediately after local persist.    │ immediately after local persist.    │
│                                     │                                     │
│ IDENTICAL ✓                         │ IDENTICAL ✓                         │
└─────────────────────────────────────┴─────────────────────────────────────┘
```

---

### Step 2.2: Node Receives and Rebroadcasts

```
┌─────────────────────────────────────┬─────────────────────────────────────┐
│           ANYPROTO                  │        PROPOSED MATOU               │
├─────────────────────────────────────┼─────────────────────────────────────┤
│                                     │                                     │
│ Node receives HeadUpdate:           │ Node receives HeadUpdate:           │
│                                     │                                     │
│ 1. HandleHeadUpdate()               │ 1. HandleHeadUpdate()               │
│ 2. AddRawChangesFromPeer()          │ 2. AddRawChangesFromPeer()          │
│ 3. Rebroadcasts to OTHER peers      │ 3. Rebroadcasts to OTHER peers      │
│ 4. Updates NodeHead (node-to-node)  │ 4. Updates NodeHead (node-to-node)  │
│                                     │                                     │
│ This is sync node code — same       │ This is sync node code — same       │
│ for all clients.                    │ for all clients.                    │
│                                     │                                     │
│ IDENTICAL — node-side code ✓        │ IDENTICAL — node-side code ✓        │
└─────────────────────────────────────┴─────────────────────────────────────┘
```

---

### Step 2.3: Periodic HeadSync (Background Pull)

```
┌─────────────────────────────────────┬─────────────────────────────────────┐
│           ANYPROTO                  │        PROPOSED MATOU               │
├─────────────────────────────────────┼─────────────────────────────────────┤
│                                     │                                     │
│ HeadSync.periodicSync triggers      │ HeadSync.periodicSync triggers      │
│ every SyncPeriod seconds            │ every SyncPeriod seconds            │
│                                     │                                     │
│ 1. DiffManager.FillDiff()           │ 1. DiffManager.FillDiff()           │
│    populates ldiff with all tree    │    populates ldiff with all tree    │
│    head hashes                      │    head hashes                      │
│                                     │                                     │
│ 2. DiffSyncer.Sync() per peer:     │ 2. DiffSyncer.Sync() per peer:     │
│    a. HeadSyncRequest (full hash)   │    a. HeadSyncRequest (full hash)   │
│    b. Range comparison if diff      │    b. Range comparison if diff      │
│    c. Returns: newIds, changedIds,  │    c. Returns: newIds, changedIds,  │
│       removedIds                    │       removedIds                    │
│                                     │                                     │
│ 3. Ordered sync:                    │ 3. Ordered sync:                    │
│    a. ACL sync FIRST                │    a. ACL sync FIRST                │
│    b. KeyValue sync                 │    b. KeyValue sync                 │
│    c. TreeSyncer.SyncAll(           │    c. TreeSyncer.SyncAll(           │
│         existingIds, missingIds)    │         existingIds, missingIds)    │
│                                     │                                     │
│ With tree-per-object: each object   │ With tree-per-object: each object   │
│ appears as separate entry in ldiff. │ appears as separate entry in ldiff. │
│ Missing objects → missingIds.       │ Missing objects → missingIds.       │
│ Changed objects → existingIds.      │ Changed objects → existingIds.      │
│                                     │                                     │
│ IDENTICAL — same any-sync code ✓    │ IDENTICAL — same any-sync code ✓    │
└─────────────────────────────────────┴─────────────────────────────────────┘
```

**Alignment**: HeadSync is entirely any-sync library code. The only difference is what TreeSyncer does with the work items (see next step).

---

### Step 2.4: TreeSyncer Processes Sync Work

```
┌─────────────────────────────────────┬─────────────────────────────────────┐
│           ANYPROTO                  │        PROPOSED MATOU               │
├─────────────────────────────────────┼─────────────────────────────────────┤
│                                     │                                     │
│ TreeSyncer.SyncAll() queues work:   │ MatouTreeSyncer.SyncAll() queues:   │
│                                     │                                     │
│ MISSING TREES:                      │ MISSING TREES:                      │
│ → requestPool.Add(work)             │ → requestPool.Add(work)             │
│   10 worker goroutines              │   10 worker goroutines              │
│   Each: BuildSyncTreeOrGetRemote()  │   Each: BuildSyncTreeOrGetRemote()  │
│         + SyncWithPeer()            │         + SyncWithPeer()            │
│                                     │                                     │
│ EXISTING TREES:                     │ EXISTING TREES:                     │
│ → headPool.Add(work)               │ → headPool.Add(work)               │
│   1 worker per peer                 │   1 worker per peer                 │
│   Each: SyncWithPeer()              │   Each: SyncWithPeer()              │
│                                     │                                     │
│ Deduplication: tryAdd() prevents    │ Deduplication: tryAdd() prevents    │
│ duplicate sync work                 │ duplicate sync work                 │
│                                     │                                     │
│ StartSync() activates pools ✓       │ StartSync() activates pools ✓       │
│ StopSync() shuts them down          │ StopSync() shuts them down          │
│                                     │                                     │
│ Uses syncqueues.ActionPool          │ Uses syncqueues.ActionPool          │
│                                     │                                     │
│ ALIGNED ✓                           │ ALIGNED ✓                           │
└─────────────────────────────────────┴─────────────────────────────────────┘
```

**Key change from current Matou**: Current Matou has `StartSync() {}` (no-op) and processes sync synchronously in `SyncAll()`. Proposed Matou replicates the anyproto worker pool pattern using `syncqueues.ActionPool` from the any-sync library.

---

## Journey 3: New Peer Joining a Space

### Step 3.1: ACL Invitation

```
┌─────────────────────────────────────┬─────────────────────────────────────┐
│           ANYPROTO                  │        PROPOSED MATOU               │
├─────────────────────────────────────┼─────────────────────────────────────┤
│                                     │                                     │
│ OWNER:                              │ ADMIN:                              │
│ BuildInviteAnyone(permissions)      │ MatouACLManager.CreateOpenInvite()  │
│ → generates Ed25519 key pair        │ → generates Ed25519 key pair        │
│ → encrypts read key with invite     │ → encrypts read key with invite     │
│   public key                        │   public key                        │
│ → aclClient.AddRecord()             │ → aclClient.AddRecord()             │
│                                     │                                     │
│ JOINER:                             │ MEMBER:                             │
│ BuildInviteJoinWithoutApprove(      │ MatouACLManager.JoinWithInvite(     │
│   InviteJoinPayload{InviteKey})     │   InviteJoinPayload{InviteKey})     │
│ → decrypts read key from invite     │ → decrypts read key from invite     │
│ → re-encrypts with own public key   │ → re-encrypts with own public key   │
│ → submits join record               │ → submits join record               │
│                                     │                                     │
│ AnyoneCanJoin flow.                 │ AnyoneCanJoin flow.                 │
│ No approval step needed.            │ No approval step needed.            │
│                                     │                                     │
│ IDENTICAL — same ACL code path ✓    │ IDENTICAL — same ACL code path ✓    │
└─────────────────────────────────────┴─────────────────────────────────────┘
```

**Alignment**: ACL management uses the same any-sync ACL primitives. The `MatouACLManager` wraps the same `aclRecordBuilder` calls.

---

### Step 3.2: Space Loading After Join

```
┌─────────────────────────────────────┬─────────────────────────────────────┐
│           ANYPROTO                  │        PROPOSED MATOU               │
├─────────────────────────────────────┼─────────────────────────────────────┤
│                                     │                                     │
│ 1. spaceServiceProvider.open(ctx)   │ 1. spaceService.NewSpace(ctx,       │
│    → SpaceService.NewSpace()        │       spaceId, deps)                │
│                                     │                                     │
│ 2. sp.Init(ctx)                     │ 2. sp.Init(ctx)                     │
│    → internal HeadSync starts       │    → internal HeadSync starts       │
│    → DiffManager initialized        │    → DiffManager initialized        │
│    → TreeSyncer ready               │    → TreeSyncer ready               │
│                                     │                                     │
│ 3. sp.WaitMandatoryObjects(ctx)     │ 3. utm.WaitForSync(ctx, spaceId,   │
│    → BLOCKS until critical objects  │       minTrees, 30s)                │
│      are synchronized               │    → BLOCKS until trees appear      │
│    → exponential backoff retry      │    → exponential backoff retry      │
│    → up to 20 seconds               │    → up to 30 seconds               │
│                                     │                                     │
│ 4. TreeSyncer.StartSync()           │ 4. TreeSyncer.StartSync()           │
│    → activates request pools        │    → activates request pools        │
│    → activates head pools           │    → activates head pools           │
│                                     │                                     │
│ 5. Space is now READY for use       │ 5. BuildSpaceIndex(ctx, spaceId)    │
│                                     │    → scans StoredIds()              │
│                                     │    → builds objectId → treeId map   │
│                                     │    → Space is now READY for use     │
│                                     │                                     │
│ ALIGNED ✓                           │ ALIGNED ✓                           │
└─────────────────────────────────────┴─────────────────────────────────────┘
```

**Key change from current Matou**: Current Matou has no WaitForSync and no StartSync. The space is immediately available for reads after `Init()`. Proposed Matou adds blocking wait + worker pool activation + index building — matching the anyproto pattern.

**Matou addition (Step 5)**: `BuildSpaceIndex` is Matou-specific — it scans tree root headers to build the `objectId → treeId` lookup. anytype-heart doesn't need this because SmartBlocks are managed by a higher-level object graph (Anytype's block-based document model). Matou's simpler model uses this index for efficient object-by-ID lookup.

---

### Step 3.3: Initial Sync (First HeadSync Cycle)

```
┌─────────────────────────────────────┬─────────────────────────────────────┐
│           ANYPROTO                  │        PROPOSED MATOU               │
├─────────────────────────────────────┼─────────────────────────────────────┤
│                                     │                                     │
│ HeadSync runs first diff:           │ HeadSync runs first diff:           │
│                                     │                                     │
│ 1. DiffSyncer compares with node    │ 1. DiffSyncer compares with node    │
│ 2. Returns: missingIds (objects     │ 2. Returns: missingIds (objects     │
│    that exist on node but not       │    that exist on node but not       │
│    locally)                         │    locally)                         │
│                                     │                                     │
│ For each missing tree:              │ For each missing tree:              │
│ 3. TreeSyncer queues to             │ 3. TreeSyncer queues to             │
│    requestPool                      │    requestPool                      │
│                                     │                                     │
│ 4. Worker calls                     │ 4. Worker calls                     │
│    BuildSyncTreeOrGetRemote()       │    BuildSyncTreeOrGetRemote()       │
│    → checks local storage           │    → checks local storage           │
│    → fetches from node if missing   │    → fetches from node if missing   │
│    → returns full SyncTree          │    → returns full SyncTree          │
│                                     │                                     │
│ 5. SyncWithPeer() ensures all       │ 5. SyncWithPeer() ensures all       │
│    changes are present              │    changes are present              │
│                                     │                                     │
│ 6. Tree registered in local         │ 6. Tree registered in local         │
│    storage → HeadStorage notifies   │    storage → HeadStorage notifies   │
│    DiffManager → ldiff updated      │    DiffManager → ldiff updated      │
│                                     │                                     │
│ With tree-per-object: each          │ With tree-per-object: each          │
│ profile is a separate missing tree  │ profile is a separate missing tree  │
│ that gets fetched independently.    │ that gets fetched independently.    │
│                                     │                                     │
│ ALIGNED ✓                           │ ALIGNED ✓                           │
└─────────────────────────────────────┴─────────────────────────────────────┘
```

**Alignment**: The initial sync follows the exact same pattern. Each object tree is discovered independently via HeadSync diff, fetched via `BuildSyncTreeOrGetRemote`, and registered automatically.

---

## Journey 4: Peer Reads Data

### Step 4.1: List All Objects in a Space

```
┌─────────────────────────────────────┬─────────────────────────────────────┐
│           ANYPROTO                  │        PROPOSED MATOU               │
├─────────────────────────────────────┼─────────────────────────────────────┤
│                                     │                                     │
│ space.StoredIds()                   │ treeManager.GetTreesForSpace(       │
│   → headSync.ExternalIds()          │     spaceId)                        │
│   → diffManager.AllIds()            │   → returns []ObjectIndexEntry      │
│   → returns all tree IDs            │   → pre-built from StoredIds()      │
│                                     │     during BuildSpaceIndex()        │
│ For each treeId:                    │                                     │
│   treeManager.GetTree(spaceId, id)  │ For each entry:                     │
│   → returns live SyncTree           │   treeManager.GetTree(spaceId,      │
│   → read latest state               │     entry.TreeID)                   │
│                                     │   → returns live SyncTree           │
│ The SyncTree IS the latest state.   │   → read latest change              │
│ No rebuild needed.                  │                                     │
│                                     │ The SyncTree IS the latest state.   │
│                                     │ No rebuild needed.                  │
│                                     │ No cache invalidation.              │
│                                     │                                     │
│ ALIGNED ✓                           │ ALIGNED ✓                           │
└─────────────────────────────────────┴─────────────────────────────────────┘
```

**Key change from current Matou**: Current Matou calls `m.trees.Delete(spaceID)` on EVERY read, destroying the live SyncTree and rebuilding from storage. Proposed Matou never invalidates — the live SyncTree receives HeadUpdate broadcasts and is always up-to-date.

**Matou addition**: The `SpaceObjectIndex` provides pre-built type filtering. anytype-heart uses Anytype's block-based object graph for this. Matou's simpler index serves the same purpose.

---

### Step 4.2: Read a Specific Object by ID

```
┌─────────────────────────────────────┬─────────────────────────────────────┐
│           ANYPROTO                  │        PROPOSED MATOU               │
├─────────────────────────────────────┼─────────────────────────────────────┤
│                                     │                                     │
│ treeManager.GetTree(                │ treeManager.GetTreeForObject(       │
│   spaceId, treeId)                  │   objectId)                         │
│ → returns live SyncTree             │ → looks up objectMap: objectId →    │
│ → read latest state from tree       │   treeId                            │
│                                     │ → GetTree(spaceId, treeId)          │
│ Caller knows the treeId because     │ → returns live SyncTree             │
│ SmartBlocks track their own         │ → read latest change                │
│ tree reference.                     │                                     │
│                                     │ Matou's objectMap provides the      │
│                                     │ same direct lookup that SmartBlock  │
│                                     │ references provide in anytype.      │
│                                     │                                     │
│ ALIGNED ✓                           │ ALIGNED ✓                           │
└─────────────────────────────────────┴─────────────────────────────────────┘
```

**Alignment**: Both get the tree directly by ID. anytype-heart knows the treeId because SmartBlocks maintain their tree reference. Matou uses an `objectId → treeId` map since it doesn't have a SmartBlock layer. Same result: O(1) lookup, no scanning.

---

### Step 4.3: Read Latest Change from a Tree

```
┌─────────────────────────────────────┬─────────────────────────────────────┐
│           ANYPROTO                  │        PROPOSED MATOU               │
├─────────────────────────────────────┼─────────────────────────────────────┤
│                                     │                                     │
│ tree.Lock()                         │ tree.Lock()                         │
│ // Read tree state:                 │ // Read latest change:              │
│ state := tree.GetState()            │ tree.IterateRoot(                   │
│ // State includes all changes       │   converter, iterator)              │
│ // applied in order                 │ // Walks DAG, decrypts changes,     │
│ tree.Unlock()                       │ // returns latest ObjectPayload     │
│                                     │ tree.Unlock()                       │
│ SmartBlock interprets state         │                                     │
│ changes and builds current view.    │ With tree-per-object: only changes  │
│                                     │ for THIS object are in this tree.   │
│ With tree-per-object: only changes  │ Latest change = current version.    │
│ for THIS SmartBlock are in tree.    │                                     │
│                                     │                                     │
│ ALIGNED ✓                           │ ALIGNED ✓                           │
└─────────────────────────────────────┴─────────────────────────────────────┘
```

**Key change from current Matou**: Current Matou iterates ALL changes in a shared tree, filtering by DataType and Type. Proposed Matou iterates only the changes in THIS object's tree — which are all for the same object. Much simpler and faster.

---

## Journey 5: Live Updates (Real-time)

### Step 5.1: Another Peer Makes a Change

```
┌─────────────────────────────────────┬─────────────────────────────────────┐
│           ANYPROTO                  │        PROPOSED MATOU               │
├─────────────────────────────────────┼─────────────────────────────────────┤
│                                     │                                     │
│ Peer A edits an object:             │ Peer A updates their profile:       │
│ → SyncTree.AddContent() succeeds    │ → SyncTree.AddContent() succeeds   │
│ → HeadUpdate broadcast to node      │ → HeadUpdate broadcast to node     │
│                                     │                                     │
│ Node rebroadcasts to Peer B:        │ Node rebroadcasts to Peer B:       │
│                                     │                                     │
│ Peer B receives HeadUpdate:         │ Peer B receives HeadUpdate:        │
│ 1. sdkStreamHandler routes to       │ 1. sdkStreamHandler routes to      │
│    space.HandleMessage()            │    space.HandleMessage()           │
│ 2. SyncTree.HandleHeadUpdate()      │ 2. SyncTree.HandleHeadUpdate()    │
│ 3. AddRawChangesFromPeer()          │ 3. AddRawChangesFromPeer()        │
│ 4. Change applied to live tree      │ 4. Change applied to live tree    │
│ 5. Tree persisted to storage        │ 5. Tree persisted to storage      │
│                                     │                                     │
│ Next time Peer B reads the object:  │ Next time Peer B reads profiles:  │
│ → GetTree() returns same SyncTree   │ → GetTree() returns same SyncTree │
│ → tree already has the new change   │ → tree already has the new change │
│ → NO rebuild from storage needed    │ → NO cache invalidation needed    │
│                                     │                                     │
│ ALIGNED ✓                           │ ALIGNED ✓                          │
└─────────────────────────────────────┴─────────────────────────────────────┘
```

**Key change from current Matou**: Current Matou's dual cache means HeadUpdates go to the tree in `sdkTreeManager.cache`, but reads come from a NEW tree rebuilt from `TreeCache`. The update is applied to the wrong tree instance. Proposed Matou has one cache, one tree instance — the live SyncTree that receives updates IS the tree that gets read.

---

## Journey 6: Profile-Specific Flow (Matou Registration)

### Step 6.1: Admin Approves Member

```
┌─────────────────────────────────────┬─────────────────────────────────────┐
│           ANYPROTO                  │        PROPOSED MATOU               │
├─────────────────────────────────────┼─────────────────────────────────────┤
│                                     │                                     │
│ N/A — anytype doesn't have an       │ Admin approval flow:                │
│ admin-approves-member pattern.      │                                     │
│                                     │ 1. Create CommunityProfile          │
│ Anytype's participant objects are    │    → NEW tree in readonly space     │
│ created by each user for            │    → auto-broadcast to node         │
│ themselves after joining.           │                                     │
│                                     │ 2. Create SharedProfile             │
│                                     │    → NEW tree in community space    │
│                                     │    → auto-broadcast to node         │
│                                     │                                     │
│                                     │ 3. Generate invite (AFTER profiles) │
│                                     │    → ACL invite created             │
│                                     │    → invite key generated           │
│                                     │                                     │
│                                     │ 4. Issue KERI credential            │
│                                     │    → embed invite key in grant      │
│                                     │    → send to member via IPEX        │
│                                     │                                     │
│                                     │ Profiles propagate to node BEFORE   │
│                                     │ member receives invite. By the      │
│                                     │ time member joins, profiles are     │
│                                     │ already on the sync node.           │
│                                     │                                     │
│ MATOU-SPECIFIC FLOW                 │ ALIGNED WITH ANYPROTO SYNC ✓       │
└─────────────────────────────────────┴─────────────────────────────────────┘
```

**Key change from current Matou**: Current Matou creates profiles AFTER generating the invite and issuing the credential. By the time the member joins, their profile may not have reached the sync node yet. Proposed Matou creates profiles FIRST, giving maximum time for sync propagation.

---

### Step 6.2: Member Joins and Reads Profiles

```
┌─────────────────────────────────────┬─────────────────────────────────────┐
│           ANYPROTO                  │        PROPOSED MATOU               │
├─────────────────────────────────────┼─────────────────────────────────────┤
│                                     │                                     │
│ After joining space:                │ After joining space:                │
│                                     │                                     │
│ 1. SpaceService.NewSpace()          │ 1. SpaceService.NewSpace(deps)      │
│ 2. sp.Init(ctx)                     │ 2. sp.Init(ctx)                     │
│ 3. WaitMandatoryObjects(ctx)        │ 3. WaitForSync(ctx, spaceId,        │
│    → blocks until synced            │       minTrees=1, 30s)              │
│ 4. StartSync() → pools active      │    → blocks until trees arrive      │
│                                     │ 4. StartSync() → pools active       │
│ 5. Read participant objects:        │ 5. BuildSpaceIndex(ctx, spaceId)    │
│    → space.StoredIds()              │    → index all synced trees         │
│    → GetTree for each               │                                     │
│    → read current state             │ 6. Read profiles:                   │
│                                     │    → GetTreesByType("SharedProfile")│
│                                     │    → GetTree for each               │
│                                     │    → read latest change             │
│                                     │                                     │
│ All participant objects present     │ All profile trees present           │
│ because WaitMandatoryObjects        │ because WaitForSync ensured         │
│ ensured sync completed first.       │ sync completed first.               │
│                                     │                                     │
│ INCLUDING the member's own          │ INCLUDING the member's own          │
│ profile (created before join).      │ profile (created before invite).    │
│                                     │                                     │
│ ALIGNED ✓                           │ ALIGNED ✓                           │
└─────────────────────────────────────┴─────────────────────────────────────┘
```

**This is where the original bug is fixed.** Three changes work together:
1. Profiles created BEFORE invite (propagation time)
2. WaitForSync blocks until trees arrive (sync readiness)
3. Live SyncTree read, no cache invalidation (correct data)

---

## Summary: Alignment Matrix

| Data Journey Step | anyproto | Proposed Matou | Alignment |
|-------------------|----------|---------------|-----------|
| **Object creation** | Tree-per-object (SmartBlock = tree) | Tree-per-object (ObjectPayload = tree) | Identical pattern |
| **Change building** | any-sync changebuilder.go | any-sync changebuilder.go | Same library code |
| **Local storage** | AddContent → Storage.AddAll | AddContent → Storage.AddAll | Same library code |
| **Auto-broadcast** | SyncTree.AddContent → Broadcast | SyncTree.AddContent → Broadcast | Same library code |
| **HeadSync registration** | HeadStorage → DiffManager → ldiff | HeadStorage → DiffManager → ldiff | Same library code |
| **Periodic sync** | HeadSync.periodicSync → DiffSyncer | HeadSync.periodicSync → DiffSyncer | Same library code |
| **TreeSyncer** | Worker pools (10 req + 1 head/peer) | Worker pools (10 req + 1 head/peer) | Replicated pattern |
| **Missing tree fetch** | BuildSyncTreeOrGetRemote | BuildSyncTreeOrGetRemote | Same library code |
| **Existing tree sync** | SyncWithPeer → FullSyncRequest | SyncWithPeer → FullSyncRequest | Same library code |
| **Space join + wait** | WaitMandatoryObjects (blocking) | WaitForSync (blocking) | Replicated pattern |
| **Read objects** | GetTree → live SyncTree → read state | GetTree → live SyncTree → read latest | Aligned pattern |
| **Tree cache** | Single TreeManager cache | Single UnifiedTreeManager cache | Replicated pattern |
| **SyncStatus** | Real StatusUpdater | Real matouSyncStatus | Replicated pattern |
| **ACL invites** | BuildInviteAnyone → Join | CreateOpenInvite → JoinWithInvite | Same ACL code |
| **Node relay** | Sync node code (unchanged) | Sync node code (unchanged) | Identical |

### What's the Same (any-sync library code — identical)
- Change building, encryption, signing
- ObjectTree DAG operations
- SyncTree broadcast on AddContent
- HeadSync periodic diff + DiffManager
- HeadStorage → ldiff registration
- BuildSyncTreeOrGetRemote for missing trees
- FullSyncRequest/Response for catching up
- ACL tree operations
- Node relay and rebroadcast

### What's Replicated (Matou implementation matching anyproto pattern)
- Tree-per-object model (vs current single-tree-per-space)
- Single unified tree cache (vs current dual cache)
- TreeSyncer worker pools (vs current no-op StartSync)
- WaitForSync after join (vs current no-wait)
- Real SyncStatus tracker (vs current no-op)
- Space object index (Matou-specific, replacing anytype's SmartBlock graph)

### What's Matou-Specific (no anyproto equivalent)
- Admin creates profiles before invite (anytype has no admin-approval flow)
- TreeRootHeader with objectId/objectType in ChangePayload (anytype uses SmartBlock type system)
- SpaceObjectIndex mapping objectId → treeId (anytype uses its own object graph)
- Profile types: SharedProfile, CommunityProfile, PrivateProfile (anytype uses Participant objects)
