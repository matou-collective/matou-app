# Week 3 Implementation Report

**Task**: Backend Sync Integration + Frontend Start
**Date**: January 19, 2026
**Status**: 🔄 IN PROGRESS (Day 1 Complete)

---

## Week 3 Goal

**Objective**: Enable the backend to sync credentials and KELs from the frontend to any-sync spaces, providing both local caching and P2P synchronization.

### Why This Work Is Needed

The MATOU architecture follows a specific data flow pattern:

```
KERIA (source of truth)
    ↓ signify-ts
Frontend (fetches on startup + credential events)
    ↓ POST /sync/*
Backend
    ├── anystore (local cache)
    └── any-sync
        ├── User's private space (personal creds, KEL)
        └── Community space (memberships, roles)
```

**Key architectural decisions driving this work:**

1. **KERIA as Source of Truth**: All identity data (AIDs, KELs, ACDCs) originates from KERIA, managed via signify-ts in the frontend.

2. **Frontend-Issued Credentials**: No production-ready Go Signify library exists, so credential issuance happens entirely in the frontend via signify-ts. The backend receives credentials from the frontend, doesn't issue them.

3. **Multi-Layer Storage**:
   - **anystore** (local SQLite): Fast queries, offline access, computed data caching
   - **any-sync** (P2P): Cross-device sync, community data sharing

4. **Space-Based Privacy Model**:
   - **Private spaces**: Each user has an encrypted space for personal credentials
   - **Community space**: Shared space for membership/role credentials visible to all members

5. **Trust Graph Computation**: The backend needs all credentials cached locally to compute trust scores and relationship graphs.

Without this sync layer, the backend would be isolated from identity data, unable to provide trust computation, offline access, or community-wide credential visibility.

---

## Week 3 Timeline

| Day | Focus | Status |
|-----|-------|--------|
| Day 1 | any-sync Space Management | ✅ Complete |
| Day 2 | Sync Endpoints | ⏳ Pending |
| Day 3 | Trust Graph Foundation | ⏳ Pending |
| Day 4-5 | Integration Testing | ⏳ Pending |

---

## Day 1: any-sync Space Management

**Date**: January 19, 2026
**Status**: ✅ COMPLETE

### Goal

Implement space management for creating and managing user private spaces and the community space, with local registry for tracking space assignments.

### Activities Completed

#### 1. SpaceManager Implementation ✅

**File**: `internal/anysync/spaces.go` (210 lines)

Created `SpaceManager` struct with the following capabilities:

| Method | Description |
|--------|-------------|
| `NewSpaceManager()` | Initialize with any-sync client and config |
| `CreatePrivateSpace()` | Create user's private space with deterministic ID |
| `GetOrCreatePrivateSpace()` | Idempotent space creation with local caching |
| `GetCommunitySpace()` | Return MATOU community space |
| `AddToCommunitySpace()` | Add credentials to community space |
| `SyncToPrivateSpace()` | Sync credentials to user's private space |
| `RouteCredential()` | Route credentials to appropriate spaces |

**Credential Routing Logic**:
```go
func IsCommunityVisible(cred *Credential) bool {
    switch cred.Schema {
    case "EMatouMembershipSchemaV1":
        return true  // Memberships are public
    case "EOperationsStewardSchemaV1":
        return true  // Roles are public
    case "ESelfClaimSchemaV1":
        return false // Self-claims are private
    case "EInvitationSchemaV1":
        return false // Invitations are private
    default:
        return false
    }
}
```

**Deterministic Space ID Generation**:
```go
func generatePrivateSpaceID(userAID string) string {
    hash := sha256.Sum256([]byte("matou-private:" + userAID))
    return "space-" + hex.EncodeToString(hash[:16])
}
```

#### 2. Space Registry in anystore ✅

**File**: `internal/anystore/client.go` (extended)

Added space record persistence:

| Type/Method | Description |
|-------------|-------------|
| `SpaceRecord` | Struct for storing space metadata |
| `Spaces()` | Get spaces collection |
| `SaveSpaceRecord()` | Persist space record |
| `GetSpaceByID()` | Retrieve by space ID |
| `GetUserSpaceRecord()` | Find user's private space |
| `ListAllSpaceRecords()` | List all registered spaces |
| `UpdateSpaceLastSync()` | Update sync timestamp |

**SpaceRecord Structure**:
```go
type SpaceRecord struct {
    ID        string    `json:"id"`        // SpaceID (document ID)
    UserAID   string    `json:"userAid"`   // Owner's AID
    SpaceType string    `json:"spaceType"` // "private" or "community"
    SpaceName string    `json:"spaceName"` // Human-readable name
    CreatedAt time.Time `json:"createdAt"` // Creation timestamp
    LastSync  time.Time `json:"lastSync"`  // Last sync timestamp
}
```

#### 3. SpaceStore Adapter ✅

**File**: `internal/anystore/space_adapter.go` (75 lines)

Created adapter to bridge anystore and anysync packages:

```go
type SpaceStoreAdapter struct {
    store *LocalStore
}

// Implements anysync.SpaceStore interface
func (a *SpaceStoreAdapter) GetUserSpace(ctx, userAID) (*anysync.Space, error)
func (a *SpaceStoreAdapter) SaveSpace(ctx, space) error
func (a *SpaceStoreAdapter) ListAllSpaces(ctx) ([]*anysync.Space, error)
```

#### 4. Server Integration ✅

**File**: `cmd/server/main.go` (updated)

Added space manager initialization on startup:

```go
// Initialize space manager
spaceManager := anysync.NewSpaceManager(anysyncClient, &anysync.SpaceManagerConfig{
    CommunitySpaceID: cfg.GetOrgSpaceID(),
    OrgAID:           cfg.GetOrgAID(),
})
spaceStore := anystore.NewSpaceStoreAdapter(store)
```

#### 5. Comprehensive Tests ✅

**File**: `internal/anysync/spaces_test.go` (370 lines)

| Test | Coverage |
|------|----------|
| `TestGeneratePrivateSpaceID` | Deterministic ID generation |
| `TestIsCommunityVisible` | All credential types (6 cases) |
| `TestSpaceManager_CreatePrivateSpace` | Space creation logic |
| `TestSpaceManager_CreatePrivateSpace_EmptyAID` | Error handling |
| `TestSpaceManager_GetCommunitySpace` | Community space retrieval |
| `TestSpaceManager_GetCommunitySpace_NotConfigured` | Error case |
| `TestSpaceManager_GetOrCreatePrivateSpace` | Idempotent creation |
| `TestSpaceManager_AddToCommunitySpace` | Credential routing |
| `TestSpaceManager_RouteCredential` | Full routing logic |
| `TestSpace_Fields` | Struct validation |

**File**: `internal/anystore/client_test.go` (extended)

| Test | Coverage |
|------|----------|
| `TestSpaceRecordCRUD` | Basic CRUD operations |
| `TestGetUserSpaceRecord` | Query by user AID |
| `TestListAllSpaceRecords` | List all spaces |
| `TestUpdateSpaceLastSync` | Timestamp updates |
| `TestSpacesCollectionAccess` | Collection access |

### Test Results

```
ok  github.com/matou-dao/backend/internal/anystore   0.839s
ok  github.com/matou-dao/backend/internal/anysync    0.181s
ok  github.com/matou-dao/backend/internal/api        0.677s
ok  github.com/matou-dao/backend/internal/config     (cached)
ok  github.com/matou-dao/backend/internal/keri       (cached)
```

All 55+ tests passing.

### Files Created/Modified

| File | Action | Lines |
|------|--------|-------|
| `internal/anysync/spaces.go` | Created | 210 |
| `internal/anysync/spaces_test.go` | Created | 370 |
| `internal/anystore/client.go` | Modified | +130 |
| `internal/anystore/space_adapter.go` | Created | 75 |
| `internal/anystore/client_test.go` | Modified | +120 |
| `cmd/server/main.go` | Modified | +20 |

---

## Day 2 Preview: Sync Endpoints

### Planned Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/v1/sync/credentials` | POST | Sync credentials from KERIA |
| `/api/v1/sync/kel` | POST | Sync KEL from KERIA |
| `/api/v1/community/members` | GET | Get all community members |

### Planned Implementation

```go
// POST /api/v1/sync/credentials
type SyncCredentialsRequest struct {
    UserAID     string            `json:"userAid"`
    Credentials []keri.Credential `json:"credentials"`
}

func (h *SyncHandler) HandleSyncCredentials(w, r) {
    // 1. Parse request
    // 2. Validate each credential structure
    // 3. Get or create user's private space
    // 4. For each credential:
    //    a. Store in anystore (cache)
    //    b. Sync to user's private space (any-sync)
    //    c. If membership/role → also sync to community space
    // 5. Return sync status
}
```

---

## Architecture Reference

```
┌─────────────────────────────────────────────────────────────────┐
│                    WEEK 3 FOCUS AREA                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Frontend (signify-ts)                                          │
│       │                                                         │
│       │ POST /api/v1/sync/credentials                           │
│       │ POST /api/v1/sync/kel                                   │
│       ▼                                                         │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                 BACKEND (Go)                             │   │
│  │                                                          │   │
│  │  ┌──────────────┐     ┌──────────────────────────────┐  │   │
│  │  │ SyncHandler  │────►│      SpaceManager            │  │   │
│  │  │ (Day 2)      │     │      (Day 1) ✅              │  │   │
│  │  └──────────────┘     └──────────────┬───────────────┘  │   │
│  │                                       │                  │   │
│  │                          ┌────────────┼────────────┐     │   │
│  │                          ▼            ▼            ▼     │   │
│  │                   ┌──────────┐  ┌──────────┐  ┌───────┐ │   │
│  │                   │ anystore │  │ Private  │  │Commun-│ │   │
│  │                   │ (cache)  │  │ Space    │  │ity    │ │   │
│  │                   │ (Day 1)✅│  │ (Day 1)✅│  │Space  │ │   │
│  │                   └──────────┘  └──────────┘  └───────┘ │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

**Day 1 Implementation**: Complete
**Tests**: All passing (55+)
**Status**: ✅ Ready for Day 2
