
# Mātou Community Notice Board

## Technical Design Document (AnySync Backend)

**Backend:** AnySync (CRDT replication layer)
**Local storage:** AnyStore (per-device object store)
**Encryption model:** Space-based encryption
**Identity model (v1):** Local user identity (UID/AID mapped)
**Identity model (v2+):** AID-based issuer verification (KERI-ready)

---

# 1. Architectural Overview

## 1.1 Core Principle

The Notice Board is implemented as:

> A replicated, append-only collection of Notice objects within one or more AnySync Spaces.

No central database.
No global server query engine.
No feed algorithm.

Each Space contains:

* Notice objects
* Notice interaction objects
* Optional derived index objects (for fast querying)

Replication happens via AnySync CRDT layer between peers.

---

# 2. AnySync Model Alignment

## 2.1 Spaces

Each Notice exists inside a **Space**.

Example spaces:

* `community-space`
* `tech-working-group`
* `treasury`
* `governance`

Access control is enforced via:

* Space encryption keys
* Space membership rules
* AnySync permission model

This replaces Firestore security rules entirely.

If you don’t have the space key → you cannot see the notice.

---

## 2.2 Object Types

We define structured object types stored in AnyStore and replicated via AnySync.

### Object Type: `notice`

```ts
Notice {
  id: string                // ULID or UUID
  schemaVersion: number
  type: 'event' | 'update' | future
  subtype: string
  title: string
  summary: string
  body?: string
  links?: Link[]
  
  issuer: {
    issuerType: 'person' | 'role' | 'org' | 'system'
    issuerId: string        // AID or internal ID
    displayName?: string
  }

  audience: {
    mode: 'space' | 'role' | 'community'
    roleIds?: string[]
  }

  time: {
    publishAt: timestamp
    activeFrom?: timestamp
    activeUntil?: timestamp
    eventStart?: timestamp
    eventEnd?: timestamp
    timezone?: string
  }

  location?: {
    mode: 'physical' | 'online' | 'hybrid'
    text?: string
    url?: string
  }

  rsvp?: {
    enabled: boolean
    required: boolean
    capacity?: number
  }

  ack?: {
    required: boolean
    dueAt?: timestamp
  }

  lifecycle: {
    state: 'draft' | 'published' | 'archived'
    createdAt: timestamp
    createdBy: string
    publishedAt?: timestamp
    archivedAt?: timestamp
  }

  amendsNoticeId?: string

  signature?: {
    method: 'aid-signature'
    signer: string
    signature: string
  }
}
```

---

# 3. Append-Only Design

## 3.1 Immutability Rule

Once `lifecycle.state == 'published'`:

* Core content is immutable.
* Changes must be made via:

  * New Notice with `amendsNoticeId`
  * Or lifecycle transition only

This aligns naturally with:

* CRDT principles
* Institutional memory
* Auditability

---

## 3.2 Lifecycle Transitions

State machine:

```
draft → published → archived
```

Rules:

* Only issuer or role-holder can transition draft → published
* Archive may be automatic (based on time.activeUntil)
* Amendments do NOT overwrite

---

# 4. Interaction Objects (CRDT-Friendly)

Interactions should NOT modify the Notice object.

Instead, create separate object types:

---

## 4.1 `notice_ack`

```ts
NoticeAck {
  id: string
  noticeId: string
  userId: string
  ackAt: timestamp
  method: 'open' | 'explicit'
}
```

Stored in:

* Same Space as notice
  OR
* Personal Space (if private acks preferred)

Recommendation:

* Store in same space but visible only to issuer via UI logic.
* Encryption already prevents outsiders.

---

## 4.2 `notice_rsvp`

```ts
NoticeRSVP {
  id: string
  noticeId: string
  userId: string
  status: 'going' | 'maybe' | 'not_going'
  updatedAt: timestamp
}
```

CRDT handling:

* Last-write-wins per userId
* Unique constraint: one RSVP per (noticeId, userId)

---

## 4.3 `notice_save`

```ts
NoticeSave {
  id: string
  noticeId: string
  userId: string
  savedAt: timestamp
  pinned: boolean
}
```

These can optionally live in:

* Personal space only (preferred)
  So that saved notices don’t replicate unnecessarily.

---

# 5. Board Construction (Without Central Queries)

Since AnySync is peer-based, we construct boards locally.

## 5.1 Local Indexing Strategy

When a notice object arrives or changes:

Client:

* Stores in AnyStore
* Updates a local derived index:

Example local index object:

```ts
NoticeIndex {
  id: 'index-community'
  noticeIdsByUpcoming: string[]
  noticeIdsByUpdate: string[]
  noticeIdsByArchived: string[]
}
```

Alternatively:

* Use in-memory filtering on:

  * type
  * lifecycle.state
  * time fields

For v1 scale (< 5,000 notices per space):
→ In-memory filtering is sufficient.

---

## 5.2 Board Views

### Upcoming

Filter:

* type == event
* lifecycle.state == published
* eventStart >= now - graceWindow

Sort:

* eventStart ascending

---

### Current Updates

Filter:

* type == update
* lifecycle.state == published
* activeUntil null OR activeUntil >= now

Sort:

* publishAt descending

---

### Past

Filter:

* lifecycle.state == archived
  OR
* activeUntil < now

---

# 6. Permissions Model (AnySync)

Access control is enforced at the Space level.

## 6.1 Publish Permissions

Within a Space:

* Only users with role `publisher` or specific permission flag can:

  * Create notice objects
  * Transition lifecycle to published

This can be enforced via:

* Application-layer checks
* Or future AnySync access rules if implemented

---

## 6.2 Audience Modes

Since encryption is Space-based:

### Community mode

→ Notice lives in `community-space`

### Space mode

→ Notice lives in specific working group space

### Role mode (v1 workaround)

Either:

* Place notice in space + filter by role in UI
  OR
* Create role-specific subspace

For v1:
Keep it simple:
→ Space-based audience only
→ Role filtering happens in client.

---

# 7. Notifications (Optional Layer)

AnySync does not push by default.

You have options:

### Option A – Polling

Client checks:

* New notice objects since lastSeenTimestamp

### Option B – Lightweight relay server

* Relay watches AnySync updates
* Sends FCM push to relevant members

Recommendation:
Keep v1 polling + in-app badge.

---

# 8. Offline Behavior

Strength of AnySync:

* Notices fully available offline once replicated
* Acks and RSVPs stored locally and synced later
* No central dependency for read

Conflict resolution:

* CRDT ensures consistent object state
* RSVP uses last-write-wins
* Acks are append-only per user

---

# 9. Federation Readiness

To support future cross-community notices:

Add issuer verification:

```ts
signature: {
  method: 'aid-signature'
  signer: string
  signature: string
}
```

Client:

* Verifies signature against known AID
* Marks notice as:

  * Verified
  * Unverified
  * External

No server required.

---

# 10. Performance Considerations

For v1 scale (hundreds to low thousands notices):

* Local filtering acceptable
* No heavy indexing needed
* No central query cost

If scaling to 50k+ notices per space:

* Introduce NoticeIndex CRDT object
* Maintain sorted ID lists
* Or time-bucketed partitioning

---

# 11. Security Model

Security is derived from:

1. Space encryption keys
2. Membership control
3. Optional AID signatures

There is:

* No public unauthenticated read
* No centralized admin override
* No database-level leak

---

# 12. Risks & Mitigations

### Risk: Space becomes too large

Mitigation:

* Partition by:

  * Year
  * Domain (governance, tech, community)

### Risk: Role-based audience difficult

Mitigation:

* Keep v1 space-based
* Introduce role-based subspaces later

### Risk: Publisher abuse

Mitigation:

* Role-based publish permission
* Immutable audit trail

---
