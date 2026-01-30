# P2P Credential Sync Test — How It Works

Deep walkthrough of `TestIntegration_P2PSync_TwoClientPropagation` in `sync_test.go`.

## Network topology

There are 6 Docker services forming the any-sync test network:

- **3 tree nodes** (localhost:2001-2003) — store and relay ObjectTrees between peers
- **1 coordinator** (localhost:2004) — registers spaces, signs receipts, tracks shareable status
- **1 consensus node** — orders ACL records (invite, join) with total ordering guarantees
- **1 file node** — unused in this test

Client A and Client B are two `SDKClient` instances running in the Go test process. Each has its own data directory, its own randomly generated Ed25519 peer key (and therefore its own peer ID), and its own set of network connections to the tree nodes and coordinator.

## Line-by-line walkthrough

### Setup (lines 170-173)

```go
testNetwork.RequireNetwork()
ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
```

`RequireNetwork()` skips the test if the Docker network isn't running. The 120s context is the overall test timeout.

### Step 1: Create two independent SDK clients (lines 175-180)

```go
clientA := newTestSDKClientWithDir(t, t.TempDir())
clientB := newTestSDKClientWithDir(t, t.TempDir())
```

Each call to `newTestSDKClientWithDir`:

1. Reads the network config file (node addresses, peer IDs, network ID)
2. Generates a **fresh Ed25519 keypair** saved to `<tmpdir>/peer.key`
3. Boots the full any-sync component graph: secure service, yamux/quic transports, connection pool, stream pool, coordinator client, node client, space service, tree manager, stream handler, SpaceSync RPC server
4. Registers a cleanup function to close the client when the test ends

After this, Client A and Client B are two fully independent peers on the same any-sync network, with different identities and separate local storage.

### Step 2: Client A creates a space (lines 182-189)

```go
result, err := clientA.CreateSpace(ctx, "ETestPropagation_Owner", "anytype.space", nil)
```

`CreateSpace` does this internally:

1. Generates a **SpaceKeySet**: a signing key (reuses the peer key since `nil` was passed), a random Ed25519 master key, a random AES **ReadKey**, and a random Ed25519 metadata key
2. Computes a replication key (FNV-64 hash of the signing key) — used by tree nodes for consistent hashing
3. Calls `spaceService.CreateSpace()` which:
   - Builds the **space header** (contains the space type, replication key, signing key identity)
   - Builds the **ACL root record** — the first record in the ACL ObjectTree. It contains the ReadKey **encrypted with the owner's public key** and the owner's permissions (full owner)
   - Builds a **settings tree** (internal any-sync metadata tree)
   - Calls the coordinator's `SpaceSign` RPC to get a **space receipt** — the coordinator validates the space type ("anytype.space" is accepted) and signs a receipt proving this space is registered
   - Creates the space storage locally (an anystore SQLite database in `<tmpdir>/spaces/<spaceID>/data.db`)
4. Opens the space via the shared resolver (initializes HeadSync, peer manager, etc.)
5. Persists the key set to disk

At this point the space exists only on Client A's local storage. HeadSync starts running periodically in the background, trying to push the space to tree nodes.

### Step 3: Wait for space to propagate to tree nodes (lines 191-209)

```go
for time.Now().Before(pushDeadline) {
    _, err := clientB.GetSpace(ctx, spaceID)
    if err == nil {
        spaceReady = true
        break
    }
    time.Sleep(1 * time.Second)
}
```

**What's happening in the background on Client A:**

- HeadSync runs every ~5 seconds. It connects to each tree node and runs a diff protocol (like Merkle tree comparison). The tree nodes don't have this space yet, so Client A pushes:
  - The space header + receipt
  - The ACL root ObjectTree (contains the owner record with the encrypted ReadKey)
  - The settings ObjectTree
- The first push usually succeeds within 1-2 seconds. The tree nodes now store the space.

**What the polling loop does:**

- `clientB.GetSpace(spaceID)` calls through the shared resolver → `spaceService.NewSpace()` → this tries to **pull** the space from tree nodes
- If a tree node has it, Client B downloads the space header, ACL tree, and settings tree, creates local storage, and initializes the space
- If no tree node has it yet, the call fails and we retry in 1 second

Once Client B can open the space, it has:

- A local copy of the ACL root record (but can't decrypt the ReadKey — it's encrypted for Client A's public key)
- The space header and settings tree
- Its own HeadSync running against tree nodes for this space

### Step 4: Mark space as shareable (lines 211-215)

```go
clientA.MakeSpaceShareable(ctx, spaceID)
```

This calls the coordinator's `SpaceMakeShareable` RPC. The coordinator flips an internal `isShared` flag for this space in its MongoDB database.

**Why this is needed:** The consensus node (which processes ACL invite/join records) checks with the coordinator whether the space is shareable before accepting new ACL records. Without this, any `AclAddRecord` call returns "space not shareable". The space type `anytype.space` starts as not shareable — you must explicitly opt in.

### Step 5: Client A creates an open invite (lines 217-234)

```go
aclMgr := NewMatouACLManager(clientA, nil)
inviteKey, err = aclMgr.CreateOpenInvite(ctx, spaceID, PermissionWrite.ToSDKPermissions())
```

`CreateOpenInvite` does:

1. Gets the space from Client A's local cache
2. **Locks the ACL**, calls `builder.BuildInviteAnyone(permissions)`:
   - Generates a fresh Ed25519 **invite keypair**
   - Takes the space's ReadKey from the ACL state (Client A is the owner, so it can access it)
   - **Encrypts the ReadKey with the invite public key** → this becomes the `EncryptedReadKey` field in the invite record
   - Builds a signed `AclAccountInvite` protobuf record (type = AnyoneCanJoin, permissions = Writer)
   - Returns the invite record and the invite **private** key
3. **Unlocks the ACL** (critical — the next step internally re-locks it)
4. Calls `aclClient.AddRecord(inviteRec)`:
   - Sends the invite record to the **consensus node** via `nodeClient.AclAddRecord`
   - The consensus node validates: space exists, space is shareable, the signer has permission to invite, the record is well-formed
   - The consensus node appends it to its ordered ACL log and returns the record with its assigned ID
   - Back on Client A, `AddRecord` re-acquires the ACL lock and calls `acl.AddRawRecord()` to update the local ACL state with the new invite record

The returned `inviteKey` is the invite **private** key. In a real app this would be encoded and shared out-of-band (e.g., a link or QR code). In the test, it's passed directly in-process.

The retry loop exists because the consensus node might still be processing the initial ACL root from the space push. In practice the first attempt usually succeeds.

### Step 6: Client B joins with the invite key (lines 236-254)

```go
aclMgrB := NewMatouACLManager(clientB, nil)
err := aclMgrB.JoinWithInvite(ctx, spaceID, inviteKey, []byte(`{"aid":"ETestPropagation_Joiner"}`))
```

`JoinWithInvite` does:

1. Gets the space from Client B's local cache (opened in step 3)
2. **Locks the ACL**, calls `builder.BuildInviteJoinWithoutApprove(payload)`:
   - Looks up the invite record in Client B's local ACL state by scanning for `AnyoneCanJoin` invites
   - Takes the `EncryptedReadKey` from the invite record
   - **Decrypts it using the invite private key** → now Client B has the plaintext ReadKey
   - **Re-encrypts the ReadKey with Client B's own public key** → this goes into the join record so Client B can always derive the ReadKey from its ACL state going forward
   - Builds a signed `AclAccountInviteJoin` protobuf record with Client B's identity, the re-encrypted ReadKey, and the metadata
3. **Unlocks the ACL**
4. Calls `aclClient.AddRecord(joinRec)`:
   - Sends to the consensus node, which validates and appends to the ACL log
   - Client B's local ACL state is updated — Client B is now a member with Writer permissions and has the ReadKey

**Why it retries:** The invite record was created by Client A and submitted to the consensus node. It then propagates: consensus → tree nodes → Client B's HeadSync. Until Client B's local ACL state has the invite record, `BuildInviteJoinWithoutApprove` fails with "no such invite". In the test run it took ~6 seconds (3 retries at 2s intervals).

After joining, Client B's ACL state contains:

- The original owner record (Client A)
- The invite record
- Its own join record (with the ReadKey encrypted for Client B's key)

**This is the critical moment:** Client B now has the ReadKey. Any encrypted ObjectTree in this space can be decrypted by Client B.

### Step 7: Client A creates an encrypted credential tree (lines 256-271)

```go
treeMgrA := NewCredentialTreeManager(clientA, nil)
changeID, err := treeMgrA.AddCredential(ctx, spaceID, cred, signingKey)
```

`AddCredential` calls `getOrCreateTree` which calls `CreateCredentialTree`:

1. Gets a 32-byte random seed
2. Calls `treeBuilder.CreateTree()` with `IsEncrypted: true` and `ChangeType: "matou.credential.v1"`
   - This creates the **root change** of a new ObjectTree. The root is a `TreeChangeInfo` protobuf with the change type stored in its `ChangeType` field. Because `IsEncrypted: true`, the tree builder will use the space's ReadKey to encrypt all subsequent changes.
   - Returns a `TreeStorageCreatePayload` (the serialized tree)
3. Calls `treeBuilder.PutTree()` to store the tree in the space's local storage and register it with HeadSync

Then `AddCredential` itself:

1. JSON-marshals the `CredentialPayload` struct
2. Locks the tree, calls `tree.AddContent()` with `ShouldBeEncrypted: true` and `DataType: "matou.credential.v1"`
   - The tree builder encrypts the JSON payload using the ReadKey (AES)
   - Signs the encrypted change with the signing key (Ed25519)
   - Appends it to the ObjectTree

At this point Client A has a new ObjectTree in local storage with two changes: the root (metadata) and one encrypted credential. HeadSync will push this tree to tree nodes in the background.

### Step 8: Client B polls for the credential (lines 273-305)

```go
treeMgrB := NewCredentialTreeManager(clientB, nil)
creds, err := treeMgrB.ReadCredentials(ctx, spaceID)
```

`ReadCredentials` does:

1. Checks the in-memory tree cache — no tree cached for this space on Client B
2. Calls `discoverTree(ctx, spaceID)`:
   - Gets the space from Client B
   - Calls `space.StoredIds()` — returns the IDs of all ObjectTrees Client B has in storage for this space
   - For each stored tree ID, builds the tree and checks if it's a credential tree by examining:
     - `change.DataType` (for non-root changes)
     - `change.Model.(*TreeChangeInfo).ChangeType` (for the root change — this is the fix that was already in place)
   - If a credential tree is found, caches it and returns
3. Once the tree is found, iterates all changes:
   - The `IterateRoot` function calls the convert function for each change, which receives the **decrypted** bytes (the tree builder automatically decrypts using the ReadKey from Client B's ACL state)
   - The convert function unmarshals the JSON into a `CredentialPayload`
   - The iterate function collects all non-nil payloads

**Why it polls:** The credential tree was just created on Client A. It propagates: Client A HeadSync → tree nodes → Client B HeadSync. Until Client B's HeadSync picks up the new tree, `StoredIds()` won't include it and `discoverTree` fails. The polling loop retries every 500ms.

**Why decryption works:** When `BuildTree` constructs the ObjectTree from storage, it uses the space's ACL state to obtain the ReadKey. Client B's ACL state has the ReadKey (encrypted for Client B's public key) from the join record created in step 6. The tree builder decrypts the ReadKey with Client B's private key, then uses it to AES-decrypt each change's payload.

### Step 9: Final assertion (lines 307-310)

```go
if !found {
    t.Fatal("Client B did not receive Client A's credential within timeout")
}
```

If the credential was found with matching SAID, Issuer, and Schema, the test passes. This proves the full chain:

```
Client A writes encrypted credential
    → HeadSync pushes to tree nodes
        → Client B's HeadSync pulls from tree nodes
            → Client B decrypts using ReadKey obtained via ACL invite/join
                → Credential data matches
```

## The key distribution chain

The entire test exists to verify this cryptographic key distribution:

```
Space creation (Client A):
  ReadKey generated randomly
  ReadKey encrypted with Client A's public key → stored in ACL root

Invite creation (Client A):
  ReadKey decrypted with Client A's private key
  ReadKey encrypted with invite public key → stored in ACL invite record

Join (Client B):
  ReadKey decrypted with invite private key (received out-of-band)
  ReadKey encrypted with Client B's public key → stored in ACL join record

Credential read (Client B):
  ReadKey decrypted with Client B's private key (from join record)
  Credential decrypted with ReadKey (AES)
```

At no point does the plaintext ReadKey traverse the network. It's always encrypted for a specific recipient's public key.
