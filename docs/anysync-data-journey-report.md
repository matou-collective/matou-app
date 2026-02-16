# any-sync Data Journey Report: From Creation to Peer Retrieval

> Research compiled by the anysync-research team, February 2026

## Table of Contents

1. [Object Tree Data Structure](#1-object-tree-data-structure)
2. [Change Creation and Local Storage](#2-change-creation-and-local-storage)
3. [Sync to Node (Protocol Layer)](#3-sync-to-node-protocol-layer)
4. [Node Storage and Distribution](#4-node-storage-and-distribution)
5. [New Peer Joining a Space (ACL + Coordinator)](#5-new-peer-joining-a-space)
6. [Peer Requesting and Receiving Data](#6-peer-requesting-and-receiving-data)
7. [Profile/Identity Objects](#7-profileidentity-objects)

---

## 1. Object Tree Data Structure

The core data structure is an **encrypted Directed Acyclic Graph (DAG)** of changes, implemented in `any-sync/commonspace/object/tree/objecttree/`.

### Tree Structure

```
root               *Change          // The root/snapshot change
headIds            []string         // Current leaf nodes (tips of the DAG)
attached           map[string]*Change  // Successfully added changes
unAttached         map[string]*Change  // Pending changes waiting for dependencies
waitList           map[string][]string // Dependency tracking
```

### Change Structure

Each `Change` contains:
- **Navigation**: `Next`, `Previous`, `PreviousIds` (DAG links, can be multiple for merges)
- **Identity**: `Id` (content-addressable CID), `AclHeadId`, `SnapshotId`
- **Data**: `Data`, `Signature`, `DataType`, `Model`
- **Crypto**: `ReadKeyId`, `Identity` (crypto.PubKey)
- **Temporal**: `Timestamp`, `SnapshotCounter`

Changes are linked via `PreviousIds`. **Head nodes** are changes with no successors. Changes use topological ordering with lexicographic IDs for consistent sequencing across peers.

### Protobuf Definitions (`treechange.proto`)

- `TreeChange`: `previousIds`, `aclHeadId`, `snapshotBaseId`, `changesData`, `readKeyId`, `timestamp`, `identity`, `isSnapshot`, `dataType`
- `RawTreeChange`: Marshalled TreeChange payload + signature
- `RawTreeChangeWithId`: Raw change + computed CID

---

## 2. Change Creation and Local Storage

### Building a Change (`changebuilder.go`)

1. Content is optionally encrypted if a read key exists
2. A `TreeChange` protobuf is assembled with current heads as `previousIds`, timestamp, identity, data
3. The change is marshalled to bytes and signed with the creator's Ed25519 private key
4. A `RawTreeChange` wraps payload + signature
5. A CID (content-addressable ID) is computed from the serialized change
6. The change is wrapped as `RawTreeChangeWithId`

### Adding Content (`objecttree.go` — `AddContent`)

```go
tree.Lock()
result, err := tree.AddContent(ctx, SignableChangeContent{
    Data, Key, IsSnapshot, ShouldBeEncrypted, Timestamp, DataType,
})
tree.Unlock()
```

1. Caller locks the tree
2. Change is built via the change builder
3. Change is added to the internal DAG
4. Change is persisted to local storage via `Storage.AddAll()`
5. Returns `AddResult{OldHeads, Heads, Added, Mode}` where Mode is Append/Rebuild/Nothing

### SyncTree Wrapper (Critical for Sync)

`SyncTree` wraps `ObjectTree` with sync capabilities. When `AddContent()` succeeds on a SyncTree:

1. Delegates to underlying `ObjectTree.AddContentWithValidator()`
2. Updates sync status via `syncStatus.HeadsChange()`
3. **Creates and broadcasts a HeadUpdate to all connected peers**: `syncClient.CreateHeadUpdate()` + `syncClient.Broadcast()`

**Key insight**: There is NO explicit "flush" or "push to node" API. Every `AddContent()` on a SyncTree **automatically broadcasts** to all connected peers (including the sync node).

---

## 3. Sync to Node (Protocol Layer)

Sync operates at **two levels**: space-level (HeadSync) and object-level (TreeSync).

### Space-Level: HeadSync (Periodic Diff Comparison)

Uses an **ldiff** (logical diff) data structure to efficiently compare which objects differ between peers.

**Periodic sync flow** (runs at configurable interval, minimum 1 minute):

1. `HeadSync.periodicSync` triggers
2. `DiffManager.FillDiff()` populates local diff with all object head hashes
3. `DiffSyncer.Sync()` for each responsible peer:
   a. Creates a `RemoteDiff` for the peer
   b. Calls `DiffManager.TryDiff(ctx, rdiff)`:
      - First sends `HeadSyncRequest` with hash of entire local state
      - Remote compares hash — if equal, no sync needed
      - If different, does range-based comparison to find specific differing objects
   c. Returns three lists: `newIds`, `changedIds`, `removedIds`

4. **Ordered sync** (critical):
   ```
   1. ACL sync FIRST: d.syncAcl.SyncWithPeer(ctx, p)
   2. KeyValue sync:  d.keyValue.SyncWithPeer(p)
   3. Object sync:    d.treeSyncer.SyncAll(ctx, p, existingIds, missingIds)
   ```

### Object-Level: TreeSync (Per-Object)

#### HeadUpdate (Push-based, Real-time)

When `AddContent()` succeeds on a SyncTree:
1. Creates head update containing: heads, changes, snapshotPath, root
2. Broadcasts to all connected peers via `peerManager.BroadcastMessage()`

When a peer receives a HeadUpdate (`HandleHeadUpdate`):
1. Compares peer heads with local heads
2. If update includes actual changes, applies via `tree.AddRawChangesFromPeer()`
3. If heads still don't match, requests full sync
4. If heads match, acknowledges

#### FullSyncRequest/Response (Pull-based, Catching Up)

1. `SyncWithPeer()` creates a `FullSyncRequest` containing: current heads, snapshot path, tree header
2. Remote handles via `ResponseProducer`:
   - Finds common snapshot between local and remote snapshot paths
   - Creates `LoadIterator` for changes after common snapshot
   - Uses DFS to mark changes the peer already has (based on heads)
   - Streams batched responses (1MB batch size)
3. Requester applies each batch via `tree.AddRawChangesFromPeer()`

---

## 4. Node Storage and Distribution

The sync node (`any-sync-node`) acts as a **relay and persistent store**.

### When a peer sends a change to the node:

1. Peer broadcasts HeadUpdate to the node (as one of its connected peers)
2. Node's SyncTree receives via `HandleHeadUpdate` → `AddRawChangesFromPeer()`
3. Node's SyncTree **rebroadcasts** to all OTHER connected peers
4. Node updates `NodeHead` for node-to-node sync

### When a NEW peer connects:

1. New peer opens space via `SpaceService.NewSpace()`
2. If space doesn't exist locally: `sendPushSpaceRequest()` delivers space header, ACL root, settings
3. HeadSync starts and does initial diff
4. DiffSyncer discovers all objects with different heads
5. For each differing object, TreeSyncer calls `SyncWithPeer()` → FullSyncRequest/Response
6. Changes arrive in local storage

### Node-to-Node Sync

- Uses partition-based consistent hashing
- Periodic sync identifies changed spaces via `ldiff.Diff()`
- Hot sync proactively warms cache for changed spaces (every 10ms, up to 300 concurrent)

---

## 5. New Peer Joining a Space

### ACL Tree Structure

The ACL maintains:
- `accountStates`: Per-member permissions (Owner/Admin/Writer/Reader) and status (Active/Joining/Declined/Removed)
- `invites`: Pending invitations with encrypted read keys
- `keys`: Encryption key chain (read keys, metadata keys)
- `readKeyChanges`: Historical chain for decrypting older data

ACL records form a **strict linear chain** (not a DAG). Each record has `PrevId` that MUST equal `lastRecordId`.

### Invitation Flow (AnyoneCanJoin — used by Matou)

1. **Owner** calls `BuildInviteAnyone(permissions)`:
   - Generates ephemeral Ed25519 key pair
   - Encrypts current read key with invite public key
   - Creates invite record, submits to consensus node via `aclClient.AddRecord()`

2. **Joiner** calls `BuildInviteJoinWithoutApprove(InviteJoinPayload{InviteKey, Metadata})`:
   - Decrypts read key from invite using invite private key
   - Re-encrypts with own public key
   - Creates join record, submits to consensus node

### Space Loading (anytype-heart Pattern)

After joining, the space is loaded via `spaceloader/loadingspace.go`:

1. Opens space via `spaceServiceProvider.open(ctx)`
2. **`sp.WaitMandatoryObjects(ctx)`** — blocks until critical objects are synchronized
3. Validates ACL head if provided
4. Uses exponential backoff retry (up to 20 seconds) on failure
5. `TreeSyncer.StartSync()` activates request pools and head pools

**Critical**: `WaitMandatoryObjects` ensures the space is usable before proceeding. Without this, reads could happen before data has synced.

### Ordering Requirements

- ACL is ALWAYS synced before objects (enforced in `diffSyncer.syncWithPeer()`)
- Object tree changes reference `AclHeadId` — validator checks permissions at that ACL state
- Read key decryption depends on ACL state
- HeadUpdate broadcasts are async and independent — an object update could arrive before ACL update

---

## 6. Peer Requesting and Receiving Data

### TreeSyncer Architecture (anytype-heart)

```
Request pools (10 workers): Handle missing tree requests — load and SyncWithPeer()
Head pools (1 worker per peer): Update existing trees sequentially
Deduplication: tryAdd() prevents duplicate sync work
```

`SyncAll()` queues both missing and existing trees for async processing.

### Full Sync Sequence for New Peer

1. HeadSync periodic diff runs
2. DiffSyncer compares local vs remote state
3. Returns missing IDs (new to this peer) and changed IDs (different heads)
4. ACL syncs first (permissions needed for object decryption)
5. TreeSyncer processes:
   - **Missing trees**: `BuildSyncTreeOrGetRemote()` fetches full tree from peer
   - **Existing trees**: `SyncWithPeer()` sends FullSyncRequest to get missing changes
6. Changes applied to local tree and persisted to storage

### Ensuring Data Completeness

anytype-heart uses multiple mechanisms:
1. **Automatic broadcast on every change** (immediate, push)
2. **Periodic HeadSync** (background, pull, every SyncPeriod seconds)
3. **WaitMandatoryObjects** (blocking, ensures critical objects exist)
4. **TreeSyncer worker pools** (async, processes sync work in parallel)
5. **Exponential backoff retry** on space loading failure

---

## 7. Profile/Identity Objects

### Account Objects in anytype-heart

User profiles are **AccountObjects** — a specialized SmartBlock using store-based persistence:

- Collection: `"account"` in key-value store
- Maps profile relations to store keys (Name, Description, IconImage, IconOption)
- `OnPushChange()` intercepts state changes, extracts `DetailsSet`, maps to store values
- `PushStoreChange()` adds to object tree (triggers broadcast) and applies to local store

### Participant Objects

Each user's identity in a shared space is a **Participant object**:
- `ModifyProfileDetails()` copies identity attributes from source profile
- Required relations: GlobalName, Identity, Permissions, Status, IdentityProfileLink
- These sync through the same tree mechanism

### Key Insight

Profile/identity objects in anytype-heart go through the **same AddContent → broadcast pipeline** as all other objects. There is no special sync handling for profiles. The same SyncTree mechanisms ensure they reach all peers.

---

## Summary: Critical Sync Guarantees

| Mechanism | Type | When | Purpose |
|-----------|------|------|---------|
| HeadUpdate broadcast | Push, real-time | Every `AddContent()` | Immediate propagation to connected peers |
| HeadSync periodic diff | Pull, background | Every SyncPeriod | Catch-up for missed broadcasts |
| WaitMandatoryObjects | Blocking | Space loading | Ensure critical data available |
| TreeSyncer pools | Async workers | After HeadSync diff | Parallel tree sync processing |
| FullSyncRequest/Response | Pull, on-demand | When heads differ | Fetch missing changes |
| BuildSyncTreeOrGetRemote | Pull, on-demand | Tree not in local storage | Fetch entire tree from peer |

**There is NO explicit "flush to node" API.** The system relies on:
1. Automatic HeadUpdate broadcasts (immediate)
2. Periodic HeadSync (eventual)
3. WaitMandatoryObjects (blocking guarantee for space loading)
