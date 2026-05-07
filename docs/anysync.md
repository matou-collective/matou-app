# AnySync — How It Works and How Matou Uses It

This document explains the AnySync protocol from first principles, then shows how Matou's infrastructure uses it. It covers the node types, the space model, how data replicates, and what happens when things go wrong.

---

## Part 1 — AnySync Concepts

### What is AnySync?

AnySync is an open-source protocol for building **local-first, peer-to-peer, end-to-end encrypted** applications. It was built by the Anytype team and powers the Anytype app.

The core idea is **local-first**: every user's data lives on their own device first. Servers exist purely to relay changes between devices — they can't read the content because everything is end-to-end encrypted.

---

### The Five Node Types

#### 1. Application peer (user node)

This is the **client app** — a user's phone, laptop, or the backend process running on their behalf. It holds a full local copy of all data the user has access to. The app works completely offline. When connectivity returns, it syncs in the background.

In Matou, the **Go backend** running per-user is the application peer. It connects to the sync nodes on behalf of the user and keeps the local anystore database in sync.

#### 2. Sync node (`any-sync-node`)

An always-online server that **stores and replicates spaces**. Multiple sync nodes share the load via a consistent hashing partition ring — each space is assigned to a set of responsible nodes. Sync nodes communicate directly with each other to stay in sync. They solve the "closed laptop problem": if your device is offline when a collaborator makes a change, the sync node buffers that change and delivers it when you reconnect.

Data stored on sync nodes is **encrypted** — the nodes hold ciphertext they cannot read.

#### 3. File node (`any-sync-filenode`)

Handles **binary file storage** separately from object/space data. Files are chunked into IPFS DAG blocks and pushed to an S3-compatible backend (MinIO or AWS S3). The file node uses Redis with a Bloom filter for fast block lookup.

#### 4. Coordinator node (`any-sync-coordinator`)

The **network's phonebook**. It maps spaces to their responsible sync nodes, manages space creation, handles membership, and enforces per-account storage limits. Clients query the coordinator once to find which sync node holds their space, then connect directly to that node for all future syncing. The coordinator is **not** in the critical path for ongoing sync — only for routing and administrative changes. Requires MongoDB.

#### 5. Consensus node (`any-sync-consensusnode`)

Handles **ACL (access control list) changes** using the RAFT consensus protocol. When a member is added to or removed from a space, that change needs to be agreed upon consistently across all nodes — the consensus node ensures this happens without conflicts. Also requires MongoDB.

---

### Spaces

A **space** is an isolated, end-to-end encrypted container. Think of it as a shared encrypted folder — it has a set of members (defined by its ACL), and it holds a collection of object trees.

Every space has:
- A unique space ID
- An access control list (who can read/write)
- A set of object trees (the actual data)
- A set of responsible sync nodes (assigned by the coordinator via consistent hashing)

Each space is replicated across **all sync nodes** in the network, so if any one node goes down the space remains available.

---

### Object Trees and DAGs

Inside each space, every individual object (a profile, a credential, a chat message, a notice) gets its own **object tree** — a Directed Acyclic Graph (DAG) of encrypted changes.

Think of it like a git commit history for a single object. Each block in the DAG is cryptographically signed and hashed. State is reconstructed by replaying the chain of changes from the root (or from the most recent snapshot). Snapshots are taken automatically every 10 changes for performance.

```mermaid
graph TD
    R["🌱 root<br>name='Hemi', bio=''"]
    A["change<br>set bio='Kaitiaki'"]
    B["change<br>set avatar='abc123'"]
    S["📸 snapshot<br>every 10 changes"]

    R --> A --> B --> S

    style R fill:#d1fae5,stroke:#059669,color:#064e3b
    style S fill:#dbeafe,stroke:#3b82f6,color:#1e3a5f
```

Changes are stored as **field-level operations**:

```json
{
  "ops": [
    {
      "op": "set",
      "field": "displayName",
      "value": "Hemi"
    },
    {
      "op": "unset",
      "field": "bio"
    }
  ]
}
```

This is more efficient than storing full document replacements, and it enables CRDT merge (see below).

---

### CRDT — Handling Concurrent Edits

AnySync uses **CRDTs (Conflict-free Replicated Data Types)** to handle the case where two peers edit the same object while offline from each other.

When two peers reconnect:
1. They exchange their latest **DAG heads** (the tip hashes of their chains)
2. If heads differ, they identify exactly where the chains diverged
3. They transfer only the **missing blocks** — not the whole object
4. Each node applies the incoming blocks to its DAG — changes merge automatically

```mermaid
graph LR
    R["root<br>name='Hemi'"]

    A["Peer A edits<br>set bio='Kaitiaki'"]
    B["Peer B edits<br>set name='Hemi W.'"]

    M["Heads compared<br>on reconnect"]

    F["✅ Final state<br>name='Hemi W.'<br>bio='Kaitiaki'"]

    R --> A
    R --> B
    A --> M
    B --> M
    M --> F

    style R fill:#e0e7ff,stroke:#6366f1,color:#312e81
    style A fill:#d1fae5,stroke:#059669,color:#064e3b
    style B fill:#fce7f3,stroke:#ec4899,color:#831843
    style M fill:#fef3c7,stroke:#d97706,color:#78350f
    style F fill:#d1fae5,stroke:#059669,color:#064e3b
```

The merge rules are:
- **Different fields edited** → both changes survive, final state has both
- **Same field edited by both** → the change with the later timestamp wins; the other is preserved in the DAG history
- **RSVP / interactions** → Matou avoids conflicts entirely by giving each user their own tree (`RSVP-{noticeId}-{userId}`)

---

### How Replication Works Between Sync Nodes

```mermaid
sequenceDiagram
    participant C as Client
    participant SN1 as Sync Node 1
    participant SN2 as Sync Node 2
    participant SN3 as Sync Node 3

    C->>SN1: write new DAG block
    SN1-->>C: ack

    par node-to-node replication
        SN1->>SN2: replicate block
        SN1->>SN3: replicate block
    end

    Note over SN1,SN3: nodes compare heads periodically (every 2h + on start)

    Note over SN1: Node 1 goes offline...

    SN2->>SN3: heads still in sync
    SN3->>SN2: ack

    Note over SN1: Node 1 comes back online

    SN1->>SN2: "my head is X, what's yours?"
    SN2->>SN1: send missing blocks (delta only)
    Note over SN1: fully caught up, no data lost
```

---

## Part 2 — Matou's Infrastructure

### Architecture Overview

```mermaid
graph TD
    subgraph Peers["App Peers — local-first, work offline"]
        PA["User Device A<br>Go backend + SDK"]
        PB["User Device B<br>Go backend + SDK"]
    end

    COORD["Coordinator :1004<br>space routing · membership · account limits<br>backed by MongoDB"]

    subgraph SyncLayer["Sync Layer — all spaces replicated 3×"]
        SN1["Sync Node 1 :1001<br>——————————————<br>Community space<br>All private spaces<br>Admin space<br>Read-only space"]
        SN2["Sync Node 2 :1002<br>——————————————<br>Community space<br>All private spaces<br>Admin space<br>Read-only space"]
        SN3["Sync Node 3 :1003<br>——————————————<br>Community space<br>All private spaces<br>Admin space<br>Read-only space"]
    end

    subgraph Support["Supporting Services"]
        FN["File Node :1005<br>IPFS DAG blocks"]
        CONS["Consensus Node :1006<br>ACL · RAFT"]
        MONGO[("MongoDB :27017<br>coordinator + consensus DB")]
        REDIS[("Redis :6379<br>file block index")]
        MINIO[("MinIO :9000<br>S3 object storage")]
    end

    PA -->|"① which node holds my space?"| COORD
    PB -->|"① which node holds my space?"| COORD
    COORD -->|"② route to node"| SN1
    COORD -->|"② route to node"| SN2
    COORD -->|"② route to node"| SN3
    PA -->|"③ direct sync"| SN1
    PB -->|"③ direct sync"| SN2
    SN1 <-->|"replicate"| SN2
    SN2 <-->|"replicate"| SN3
    SN1 <-->|"replicate"| SN3
    COORD --- MONGO
    CONS --- MONGO
    FN --- REDIS
    FN --- MINIO

    style Peers fill:#f0fdf4,stroke:#16a34a
    style SyncLayer fill:#eff6ff,stroke:#3b82f6
    style Support fill:#fafafa,stroke:#d1d5db
```

App peers connect to the coordinator **once** to discover their assigned sync nodes, then sync directly with those nodes. The coordinator is not involved in every operation — only in routing, space creation, and membership changes.

---

### The Four Space Types in Matou

Matou runs four distinct spaces, each with different access rules:

| Space | Type | Who can write | Who can read |
|---|---|---|---|
| Private space | `private` | Owner only | Owner only |
| Community space | `community` | Admin only | All members |
| Community read-only | `community-readonly` | Admin only | Public / unauthenticated |
| Admin space | `admin` | Admins only | Admins only |

Each user gets their own private space. The community, read-only, and admin spaces are shared across the org and configured at startup.

```mermaid
graph LR
    subgraph Private["Private Space — one per user"]
        P1["Credential trees<br>memberships · invitations · self-claims"]
        P2["Object trees<br>SharedProfile"]
        P3["File metadata<br>IPFS CIDs"]
    end

    subgraph Community["Community Space — all members"]
        C1["Credential trees<br>membership · role credentials"]
        C2["Object trees<br>CommunityProfile per member"]
        C3["Notice trees<br>events · announcements · updates"]
        C4["Interaction trees<br>RSVP · ack · save — one per user per notice"]
    end

    subgraph ReadOnly["Community Read-Only Space — public"]
        R1["Public profiles"]
        R2["Public notices"]
    end

    subgraph Admin["Admin Space — admins only"]
        A1["Registration queue"]
        A2["Approval records"]
    end

    style Private fill:#f0fdf4,stroke:#16a34a
    style Community fill:#eff6ff,stroke:#3b82f6
    style ReadOnly fill:#fdf4ff,stroke:#a855f7
    style Admin fill:#fff7ed,stroke:#f97316
```

#### Object tree types

| Change type | Used for | Mutable? |
|---|---|---|
| `matou.credential.v1` | KERI credentials (memberships, roles) | No — single init change |
| `matou.object.v1` | Profiles, chat channels, messages, type definitions | Yes — incremental field ops |
| `matou.notice.v1` | Events, updates, announcements | Yes — admin can update |
| `matou.interaction.v1` | RSVPs, acks, saves | Yes — user can change their RSVP |

Credentials are **immutable** — once issued, the tree has exactly one change (the initial snapshot). This preserves the integrity of the KERI credential.

---

### File Storage Path

```mermaid
graph LR
    U["User uploads file"]
    FM["FileManager.AddFile()"]
    CHUNK["Chunk into<br>IPFS DAG blocks"]
    FN["File Node :1005<br>dRPC BlockPush"]
    MINIO["MinIO S3<br>stores blocks"]
    BIND["BlocksBind<br>links CIDs to fileId"]
    META["FileMeta ObjectTree<br>written to user's space"]

    U --> FM --> CHUNK --> FN --> MINIO
    FN --> BIND --> META

    style MINIO fill:#fef3c7,stroke:#d97706
    style META fill:#d1fae5,stroke:#059669
```

---

### Dev vs Test Network

| Network | Sync nodes | Coordinator | File node | Consensus |
|---|---|---|---|---|
| Dev | :1001–1003 | :1004 | :1005 | :1006 |
| Test | :2001–2003 | :2004 | :2005 | :2006 |

```bash
make up          # start dev network
make up-test     # start test network (isolated, ports +1000)
make health      # check all nodes are reachable
```

---

## Part 3 — Failure Scenarios

### Normal operation

All three sync nodes are online. Every space is replicated 3×. Clients connect to their assigned node via coordinator routing.

```mermaid
graph TD
    PA["User Device A"]
    PB["User Device B"]
    COORD["Coordinator<br>✓ routing"]
    SN1["Sync Node 1<br>✓ online"]
    SN2["Sync Node 2<br>✓ online"]
    SN3["Sync Node 3<br>✓ online"]

    PA --> COORD
    PB --> COORD
    COORD --> SN1
    COORD --> SN2
    COORD --> SN3
    PA --> SN1
    PB --> SN2
    SN1 <--> SN2
    SN2 <--> SN3
    SN1 <--> SN3

    style SN1 fill:#d1fae5,stroke:#059669,color:#064e3b
    style SN2 fill:#d1fae5,stroke:#059669,color:#064e3b
    style SN3 fill:#d1fae5,stroke:#059669,color:#064e3b
    style COORD fill:#e0e7ff,stroke:#6366f1,color:#312e81
```

---

### Sync Node 1 (or 3) goes offline

```mermaid
graph TD
    PA["User Device A"]
    PB["User Device B"]
    COORD["Coordinator<br>stops routing to Node 1"]
    SN1["Sync Node 1<br>✗ OFFLINE"]
    SN2["Sync Node 2<br>✓ online"]
    SN3["Sync Node 3<br>✓ online"]

    PA --> COORD
    PB --> COORD
    COORD --> SN2
    COORD --> SN3
    PA --> SN2
    PB --> SN3
    SN2 <--> SN3

    style SN1 fill:#fca5a5,stroke:#ef4444,color:#7f1d1d
    style SN2 fill:#d1fae5,stroke:#059669,color:#064e3b
    style SN3 fill:#d1fae5,stroke:#059669,color:#064e3b
    style COORD fill:#e0e7ff,stroke:#6366f1,color:#312e81
```

**What happens:**
- Coordinator stops routing new connections to node 1 immediately
- All app peers reconnect to nodes 2 and 3 transparently
- All spaces remain fully available — full copies exist on the other two nodes
- When node 1 comes back, it catches up by comparing DAG heads and requesting only the missing blocks

**Impact:** None to users. ✅

---

### Sync Node 2 goes offline — coordinator risk

Node 2 is the recommended host for the coordinator and consensus node (the always-on cloud VPS). If it goes down, the coordinator goes with it.

```mermaid
graph TD
    PA["User Device A<br>✓ existing routing still works"]
    PB["User Device B<br>✓ existing routing still works"]
    COORD["Coordinator<br>✗ OFFLINE — on same server as Node 2"]
    SN1["Sync Node 1<br>✓ online"]
    SN2["Sync Node 2 + Coordinator<br>✗ OFFLINE"]
    SN3["Sync Node 3<br>✓ online"]
    NEW["New user / new space<br>✗ cannot resolve routing"]

    PA --> SN1
    PB --> SN3
    SN1 <--> SN3
    NEW -->|"cannot reach coordinator"| COORD

    style SN2 fill:#fca5a5,stroke:#ef4444,color:#7f1d1d
    style COORD fill:#fca5a5,stroke:#ef4444,color:#7f1d1d
    style SN1 fill:#d1fae5,stroke:#059669,color:#064e3b
    style SN3 fill:#d1fae5,stroke:#059669,color:#064e3b
    style NEW fill:#fde68a,stroke:#d97706,color:#78350f
```

**What happens:**
- Existing sync between nodes 1 and 3 continues unaffected
- App peers with existing routing continue syncing normally
- New member registrations and ACL changes fail until coordinator is back
- New connections from unknown clients cannot resolve routing

**Impact:** Ongoing sync works. New operations are blocked. ⚠️

**Mitigation:** Run a second coordinator instance on a different server.

---

### All three sync nodes offline

- App peers that are online cannot push changes — writes queue locally
- App peers that are offline are unaffected — local app keeps working
- Data is not lost: every device holds a full local copy of everything they've accessed
- Recovery is fully automatic when nodes come back

**Impact:** No remote sync. Local apps still work. ⚠️

---

### App peer (client device) goes offline

```mermaid
graph TD
    PA["User Device A<br>✗ OFFLINE<br>app still works fully<br>writes to local DAG"]
    PB["User Device B<br>✓ online<br>syncing normally"]

    SN1["Sync Node 1<br>✓ online"]
    SN2["Sync Node 2<br>✓ online<br>buffering changes for Device A"]
    SN3["Sync Node 3<br>✓ online"]

    PB --> SN2
    SN1 <--> SN2
    SN2 <--> SN3

    PA -.->|"reconnects → automatic catch-up"| SN1

    style PA fill:#fde68a,stroke:#d97706,color:#78350f
    style SN2 fill:#d1fae5,stroke:#059669,color:#064e3b
    style SN1 fill:#d1fae5,stroke:#059669,color:#064e3b
    style SN3 fill:#d1fae5,stroke:#059669,color:#064e3b
```

**What happens:**
- The app on Device A keeps working — all data is stored locally
- Any changes the user makes are written to their local DAG
- Changes from other users are buffered on the sync nodes
- On reconnect, the backend syncs bidirectionally — pushes local changes, pulls buffered changes
- CRDT merge handles any concurrent edits automatically

There is no difference from the user's perspective between being offline for an hour or a week — reconnecting triggers the same automatic catch-up.

**Impact:** None to the offline user's local experience. ✅

---

### Summary

| Scenario | Data safe? | Sync continues? | Blocked operations |
|---|---|---|---|
| Node 1 or 3 down | ✅ Yes | ✅ Yes (on 2 nodes) | None |
| Node 2 (cloud) down | ✅ Yes | ✅ Yes (on 2 nodes) | New spaces, ACL changes, new clients |
| All nodes down | ✅ Yes (local) | ❌ No remote sync | All remote sync |
| Client offline | ✅ Yes (local) | ✅ Local only | Remote sync until reconnect |
| Client offline + node down | ✅ Yes (local) | ❌ No | Remote sync until both recover |
