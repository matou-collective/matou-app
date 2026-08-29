# MATOU Backend API Documentation

## Overview

The MATOU backend provides REST endpoints for identity management, credential management, sync operations, trust graph queries, space management, profiles, file uploads, and real-time events.

- **Base URL**: `http://localhost:8080`
- **Content-Type**: `application/json`

---

## Health & Info Endpoints

### GET /health

Service health check with sync and trust statistics.

**Response**:
```json
{
  "status": "healthy",
  "organization": "EOrg123456789",
  "admin": "EAdmin123456789",
  "sync": {
    "credentialsCached": 5,
    "spacesCreated": 2,
    "kelEventsStored": 10
  },
  "trust": {
    "totalNodes": 3,
    "totalEdges": 4,
    "averageScore": 4.5
  }
}
```

### GET /info

System information including organization and any-sync details.

**Response**:
```json
{
  "organization": {
    "name": "MATOU DAO",
    "aid": "EOrg123456789",
    "alias": "matou"
  },
  "admin": {
    "aid": "EAdmin123456789",
    "alias": "admin"
  },
  "anysync": {
    "networkId": "matou-network",
    "coordinator": "http://coordinator:1001"
  }
}
```

---

## Identity Endpoints

### POST /api/v1/identity/set

Set user identity (AID + mnemonic). Reinitializes the SDK client with the new identity.

**Request**:
```json
{
  "aid": "EUSER123",
  "mnemonic": "word1 word2 word3 ..."
}
```

**Response**:
```json
{
  "success": true,
  "aid": "EUSER123"
}
```

### GET /api/v1/identity

Get current identity status.

**Response**:
```json
{
  "configured": true,
  "aid": "EUSER123"
}
```

### DELETE /api/v1/identity

Clear identity (logout/reset).

**Response**:
```json
{
  "success": true
}
```

---

## Sync Endpoints

### POST /api/v1/sync/credentials

Sync credentials from KERIA (via frontend) to backend storage. The `userAid` field is optional in per-user mode (falls back to the configured identity).

**Request**:
```json
{
  "userAid": "EUSER123",
  "credentials": [
    {
      "said": "ESAID001",
      "issuer": "EOrg123456789",
      "recipient": "EUSER123",
      "schema": "EMatouMembershipSchemaV1",
      "data": {
        "communityName": "MATOU",
        "role": "Member",
        "verificationStatus": "community_verified",
        "permissions": ["read", "comment", "vote"],
        "joinedAt": "2026-01-19T00:00:00Z"
      }
    }
  ]
}
```

**Response**:
```json
{
  "success": true,
  "synced": 1,
  "failed": 0,
  "privateSpace": "space-abc123",
  "communitySpace": "space-community",
  "spaces": ["space-abc123", "space-community"],
  "errors": []
}
```

### POST /api/v1/sync/kel

Sync Key Event Log (KEL) events from KERIA to backend storage. The `userAid` field is optional in per-user mode.

**Request**:
```json
{
  "userAid": "EUSER123",
  "kel": [
    {
      "type": "icp",
      "sequence": 0,
      "digest": "EDIGEST001",
      "data": {"keys": ["key1", "key2"]},
      "timestamp": "2026-01-19T00:00:00Z"
    }
  ]
}
```

**Response**:
```json
{
  "success": true,
  "eventsStored": 2,
  "privateSpace": "space-abc123"
}
```

**KEL Event Types**:
- `icp`: Inception event (creates identifier)
- `rot`: Rotation event (key rotation)
- `ixn`: Interaction event (anchors, delegations)

---

## Community Endpoints

### GET /api/v1/community/members

List all community members with membership credentials.

**Response**:
```json
{
  "members": [
    {
      "aid": "EUSER123",
      "alias": "alice",
      "role": "Trusted Member",
      "verificationStatus": "community_verified",
      "permissions": ["read", "comment", "vote", "propose"],
      "joinedAt": "2026-01-19T00:00:00Z",
      "credentialSaid": "ESAID001"
    }
  ],
  "total": 1
}
```

### GET /api/v1/community/credentials

List all community-visible credentials (memberships, roles).

**Response**:
```json
{
  "credentials": [
    {
      "said": "ESAID001",
      "issuer": "EOrg123456789",
      "recipient": "EUSER123",
      "schema": "EMatouMembershipSchemaV1",
      "data": {
        "communityName": "MATOU",
        "role": "Member",
        "verificationStatus": "community_verified",
        "permissions": ["read", "comment", "vote"],
        "joinedAt": "2026-01-19T00:00:00Z"
      }
    }
  ],
  "total": 1
}
```

---

## Trust Graph Endpoints

### GET /api/v1/trust/graph

Get the computed trust graph.

**Query Parameters**:
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `aid` | string | - | Focus on specific AID (subgraph) |
| `depth` | int | 2 | Depth limit for subgraph (only used with `aid` param) |
| `summary` | bool | false | Include summary statistics |

When `aid` is omitted, the full graph is returned regardless of `depth`.

**Response**:
```json
{
  "graph": {
    "nodes": {
      "EOrg123456789": {
        "aid": "EOrg123456789",
        "alias": "matou",
        "role": "Organization",
        "joinedAt": "2026-01-01T00:00:00Z",
        "credentialCount": 5
      }
    },
    "edges": [
      {
        "from": "EOrg123456789",
        "to": "EUSER123",
        "credentialId": "ESAID001",
        "type": "membership",
        "bidirectional": false,
        "createdAt": "2026-01-19T00:00:00Z"
      }
    ],
    "orgAid": "EOrg123456789",
    "updated": "2026-01-22T10:30:00Z"
  },
  "summary": {
    "totalNodes": 2,
    "totalEdges": 1,
    "averageScore": 3.5,
    "maxScore": 5.0,
    "minScore": 2.0,
    "medianDepth": 1,
    "bidirectionalCount": 0
  }
}
```

### GET /api/v1/trust/score/{aid}

Get the trust score for a specific AID.

**Response**:
```json
{
  "score": {
    "aid": "EUSER123",
    "alias": "alice",
    "role": "Trusted Member",
    "incomingCredentials": 2,
    "outgoingCredentials": 1,
    "uniqueIssuers": 1,
    "bidirectionalRelations": 0,
    "graphDepth": 1,
    "score": 5.0
  }
}
```

### GET /api/v1/trust/scores

Get the top N trust scores.

**Query Parameters**:
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | int | 10 | Maximum number of scores |

**Response**:
```json
{
  "scores": [
    {
      "aid": "EUSER123",
      "alias": "alice",
      "role": "Trusted Member",
      "score": 5.0
    }
  ],
  "total": 2
}
```

### GET /api/v1/trust/summary

Get trust graph statistics summary.

**Response**:
```json
{
  "totalNodes": 5,
  "totalEdges": 8,
  "averageScore": 3.5,
  "maxScore": 7.0,
  "minScore": 1.0,
  "medianDepth": 1,
  "bidirectionalCount": 2
}
```

---

## Credential Endpoints

### GET /api/v1/credentials

List all cached credentials.

### GET /api/v1/credentials/{said}

Get a specific credential by SAID.

### POST /api/v1/credentials

Store a credential from the frontend.

**Response** (uses `StoreResponse` struct):
```json
{
  "success": true,
  "said": "ESAID001"
}
```

### POST /api/v1/credentials/validate

Validate a credential structure.

**Response**:
```json
{
  "valid": true,
  "orgIssued": true,
  "role": "Member"
}
```

### GET /api/v1/credentials/roles

List available membership roles.

**Response**:
```json
{
  "roles": [
    { "name": "Member", "permissions": ["read", "comment"] },
    { "name": "Verified Member", "permissions": ["read", "comment", "vote"] },
    { "name": "Trusted Member", "permissions": ["read", "comment", "vote", "propose"] },
    { "name": "Expert Member", "permissions": ["read", "comment", "vote", "propose", "review"] },
    { "name": "Contributor", "permissions": ["read", "comment", "vote", "contribute"] },
    { "name": "Moderator", "permissions": ["read", "comment", "vote", "moderate"] },
    { "name": "Admin", "permissions": ["read", "comment", "vote", "propose", "moderate", "admin"] },
    { "name": "Operations Steward", "permissions": ["read", "comment", "vote", "propose", "moderate", "admin", "issue_membership", "revoke_membership", "approve_registrations"] }
  ]
}
```

### GET /api/v1/org

Get organization info for the frontend.

**Response**:
```json
{
  "aid": "EOrg123456789",
  "alias": "matou",
  "name": "MATOU DAO",
  "roles": ["Member", "Verified Member", "Trusted Member", "Expert Member", "Contributor", "Moderator", "Admin", "Operations Steward"],
  "schema": "EMatouMembershipSchemaV1"
}
```

---

## Space Endpoints

### POST /api/v1/spaces/community

Create a community space.

### GET /api/v1/spaces/community

Get community space info.

### POST /api/v1/spaces/private

Create a private space.

### POST /api/v1/spaces/community/invite

Generate invite for user to join community space.

### POST /api/v1/spaces/community/join

Join community space with invite key.

### GET /api/v1/spaces/community/verify-access

Verify community space access for an AID.

### POST /api/v1/spaces/community-readonly/invite

Generate reader invite for community-readonly space.

### GET /api/v1/spaces/user

Get all spaces for a user (private, community, readonly, admin).

### GET /api/v1/spaces/sync-status

Check space sync readiness.

---

## Profile & Type Endpoints

### GET /api/v1/types

List all type definitions.

### GET /api/v1/types/{name}

Get specific type definition.

### POST /api/v1/profiles

Create/update a profile object.

### GET /api/v1/profiles/{type}

List profiles of a type.

### GET /api/v1/profiles/{type}/{id}

Get a specific profile object.

### GET /api/v1/profiles/me

Get current user's profiles across all spaces.

### POST /api/v1/profiles/init-member

Initialize member profiles (admin operation).

---

## Notice Endpoints

The community notice board stores each notice in its own object tree. Notices
follow the configurable schema model: the org's `Notice` type definition (see
`GET /api/v1/types/Notice`) is the source of truth for which fields exist, which
are required, their enums, and which may be filtered/sorted on.

### Core vs custom fields

Every `Notice` field carries a `core` flag. **Core** fields (the built-in
type/title/summary/state/issuer/schedule set) back the fixed handler logic and
the notice lifecycle state machine. Fields an org **adds** by extending the
`Notice` schema are non-core (custom); they are validated on write and
round-trip through the object's `data` map on read:

```json
{
  "id": "1724900000000",
  "type": "announcement",
  "title": "Working bee",
  "state": "published",
  "data": { "marae": "Ōrākei", "headcount": 42 }
}
```

Custom keys that are not defined by the schema are dropped; a custom key can
never shadow a core field.

### Subtype variants

`Notice` declares `variantField: "subtype"`. A schema may attach a `variants`
map keyed by subtype, each contributing extra field definitions that are
validated only when a notice's `subtype` matches. This lets one `Notice` type
carry per-subtype field sets (e.g. a `tangihanga` subtype requiring `location`)
without a separate type per subtype.

### POST /api/v1/notices

Create a notice. The request body's core fields are mapped to the notice, and
schema-defined custom fields are captured into `data`. The fully assembled
notice is validated against the org's `Notice` schema (`registry.Validate`);
missing required fields (core or custom), failed enums, or type mismatches
return `400` with a `validationErrors` array. Interaction payloads
(ack/RSVP/save/comment/reaction) are protocol, not content, and remain fixed —
they are not schema-validated against `Notice`.

### GET /api/v1/notices

List notices. Query params:

- `view=upcoming|current|past` — board selector (reserved).
- Any other param is treated as a field-equality filter and is only honoured if
  the schema marks that field **filterable** (e.g. `type`, `subtype`, `state`,
  `pinned`); a filter on a non-filterable field returns `400`. Filters match
  core fields and schema-defined custom fields alike.

### GET /api/v1/notices/{id}

Get a single notice (includes its `data` custom fields).

### Notice lifecycle & interactions

- `POST /api/v1/notices/{id}/publish` — draft → published.
- `POST /api/v1/notices/{id}/archive` — published → archived.
- `POST /api/v1/notices/{id}/pin` — toggle pinned.
- `POST|GET /api/v1/notices/{id}/rsvp` — event RSVP (going/maybe/not_going).
- `POST|GET /api/v1/notices/{id}/ack` — acknowledgment.
- `POST /api/v1/notices/{id}/save`, `GET /api/v1/notices/saved` — personal bookmarks.
- `POST|GET /api/v1/notices/{id}/comments` — comments.
- `POST|GET /api/v1/notices/{id}/reactions` — emoji reactions.

---

## File Endpoints

### POST /api/v1/files/upload

Upload file (multipart, images only, max 5MB).

### GET /api/v1/files/{ref}

Download file by CID ref.

---

## Events Endpoint

### GET /api/v1/events

SSE (Server-Sent Events) stream for real-time updates.

---

## Invites Endpoint

### POST /api/v1/invites/send-email

Email invite code to a user.

---

## Space Types

| Type | Description |
|------|-------------|
| `private` | User's private space for self-claims and personal data |
| `community` | Shared community space for membership credentials |
| `community-readonly` | Read-only community space for CommunityProfile and OrgProfile |
| `admin` | Admin space for administrative operations |

---

## Credential Schema

The `Credential` struct includes these fields:

```json
{
  "said": "ESAID001",
  "issuer": "EOrg123456789",
  "recipient": "EUSER123",
  "schema": "EMatouMembershipSchemaV1",
  "data": {
    "communityName": "MATOU",
    "role": "Member",
    "verificationStatus": "community_verified",
    "permissions": ["read", "comment", "vote"],
    "joinedAt": "2026-01-19T00:00:00Z",
    "expiresAt": "2027-01-19T00:00:00Z"
  },
  "signature": "...",
  "timestamp": "2026-01-19T00:00:00Z"
}
```

The `signature`, `timestamp`, and `expiresAt` fields are optional.

---

## Trust Score Formula

The trust score is calculated using weighted factors:

```
Score = (IncomingCredentials x 1.0)
      + (UniqueIssuers x 2.0)
      + (BidirectionalRelations x 3.0)
      + (OrgIssuedBonus: +2.0 per incoming credential from org AID)
      - (GraphDepth x 0.1, only when depth > 0)

Minimum score: 0 (cannot be negative)
```

**Factors**:
- **IncomingCredentials**: Number of credentials issued TO this AID
- **UniqueIssuers**: Number of distinct AIDs that issued credentials
- **BidirectionalRelations**: Mutual credential relationships (A->B and B->A)
- **OrgIssuedBonus**: +2.0 for each incoming credential from the organization AID
- **GraphDepth**: Distance from organization (closer = higher trust). Only applies when depth > 0.

**Graph Depth**:
- Depth 0: Organization (root node)
- Depth 1: Direct members (org -> member)
- Depth 2+: Invited members (member -> member chain)
- Depth -1: Unreachable nodes (no path from org)

---

## Error Responses

Error response format varies by endpoint. Most handlers return:

```json
{
  "error": "description of error"
}
```

Some endpoints return typed response structs that include additional fields alongside the error (e.g., `{"success": false, "error": "...", "said": ""}` for credential storage).

**HTTP Status Codes**:
| Code | Description |
|------|-------------|
| 200 | Success |
| 400 | Bad Request (invalid input) |
| 404 | Not Found |
| 405 | Method Not Allowed |
| 409 | Conflict (identity not configured, space not available) |
| 500 | Internal Server Error |
| 503 | Service Unavailable (any-sync client or filenode not configured) |

---

## Example Workflows

### Member Registration Flow

1. Frontend creates AID in KERIA via signify-ts
2. Admin issues membership credential
3. Frontend syncs credential: `POST /api/v1/sync/credentials`
4. Member appears in: `GET /api/v1/community/members`
5. Trust graph updated: `GET /api/v1/trust/graph`

### Trust Score Query Flow

1. Get full graph: `GET /api/v1/trust/graph?summary=true`
2. Get individual score: `GET /api/v1/trust/score/EUSER123`
3. Get leaderboard: `GET /api/v1/trust/scores?limit=10`

### Credential Verification Flow

1. Validate structure: `POST /api/v1/credentials/validate`
2. Store if valid: `POST /api/v1/credentials`
3. Retrieve later: `GET /api/v1/credentials/{said}`
