# MATOU Backend API Documentation

## Overview

The MATOU backend provides REST endpoints for credential management, sync operations, trust graph queries, and community data access.

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

## Sync Endpoints (Week 3)

### POST /api/v1/sync/credentials

Sync credentials from KERIA (via frontend) to backend storage.

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
  "errors": []
}
```

### POST /api/v1/sync/kel

Sync Key Event Log (KEL) events from KERIA to backend storage.

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
    },
    {
      "type": "rot",
      "sequence": 1,
      "digest": "EDIGEST002",
      "data": {"keys": ["key3"]},
      "timestamp": "2026-01-19T01:00:00Z"
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

## Community Endpoints (Week 3)

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

## Trust Graph Endpoints (Week 3)

### GET /api/v1/trust/graph

Get the computed trust graph.

**Query Parameters**:
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `aid` | string | - | Focus on specific AID (subgraph) |
| `depth` | int | full | Depth limit for subgraph |
| `summary` | bool | false | Include summary statistics |

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
      },
      "EUSER123": {
        "aid": "EUSER123",
        "alias": "alice",
        "role": "Trusted Member",
        "joinedAt": "2026-01-19T00:00:00Z",
        "credentialCount": 2
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
    },
    {
      "aid": "EUSER456",
      "alias": "bob",
      "role": "Member",
      "score": 3.0
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

## Credential Endpoints (Week 2)

### GET /api/v1/credentials

List all cached credentials.

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
        "role": "Member"
      }
    }
  ],
  "total": 1
}
```

### GET /api/v1/credentials/{said}

Get a specific credential by SAID.

**Response**:
```json
{
  "credential": {
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
}
```

### POST /api/v1/credentials

Store a credential from the frontend.

**Request**:
```json
{
  "credential": {
    "said": "ESAID001",
    "issuer": "EOrg123456789",
    "recipient": "EUSER123",
    "schema": "EMatouMembershipSchemaV1",
    "data": {
      "communityName": "MATOU",
      "role": "Member",
      "verificationStatus": "unverified",
      "permissions": ["read"],
      "joinedAt": "2026-01-19T00:00:00Z"
    }
  }
}
```

**Response**:
```json
{
  "success": true,
  "said": "ESAID001"
}
```

### POST /api/v1/credentials/validate

Validate a credential structure.

**Request**:
```json
{
  "credential": {
    "said": "ESAID001",
    "issuer": "EOrg123456789",
    "recipient": "EUSER123",
    "schema": "EMatouMembershipSchemaV1",
    "data": {
      "communityName": "MATOU",
      "role": "Member"
    }
  }
}
```

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
    {
      "name": "Member",
      "permissions": ["read", "comment"]
    },
    {
      "name": "Verified Member",
      "permissions": ["read", "comment", "vote"]
    },
    {
      "name": "Trusted Member",
      "permissions": ["read", "comment", "vote", "propose"]
    },
    {
      "name": "Expert Member",
      "permissions": ["read", "comment", "vote", "propose", "review"]
    },
    {
      "name": "Operations Steward",
      "permissions": ["read", "comment", "vote", "propose", "moderate", "admin", "issue_membership", "revoke_membership", "approve_registrations"]
    }
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

## Space Types & Visibility

| Schema | Space | Description |
|--------|-------|-------------|
| `EMatouMembershipSchemaV1` | Community | Public membership credentials |
| `EOperationsStewardSchemaV1` | Community | Admin/steward role credentials |
| `ESelfClaimSchemaV1` | Private | User self-assertions (bio, display name) |
| `EInvitationSchemaV1` | Private | Invitation credentials between users |

---

## Trust Score Formula

The trust score is calculated using weighted factors:

```
Score = (IncomingCredentials × 1.0)
      + (UniqueIssuers × 2.0)
      + (BidirectionalRelations × 3.0)
      + (OrgIssuedCredentials × 2.0)
      - (GraphDepth × 0.1)
```

**Factors**:
- **IncomingCredentials**: Number of credentials issued TO this AID
- **UniqueIssuers**: Number of distinct AIDs that issued credentials
- **BidirectionalRelations**: Mutual credential relationships (A→B and B→A)
- **OrgIssuedCredentials**: Bonus for credentials issued by the organization
- **GraphDepth**: Distance from organization (closer = higher trust)

**Graph Depth**:
- Depth 0: Organization (root node)
- Depth 1: Direct members (org → member)
- Depth 2+: Invited members (member → member chain)
- Depth -1: Unreachable nodes (no path from org)

---

## Error Responses

All error responses follow this format:

```json
{
  "error": "description of error"
}
```

**HTTP Status Codes**:
| Code | Description |
|------|-------------|
| 200 | Success |
| 400 | Bad Request (invalid input) |
| 404 | Not Found |
| 405 | Method Not Allowed |
| 500 | Internal Server Error |

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
