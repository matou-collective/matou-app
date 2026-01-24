# MATOU DAO Backend

Go backend service for the MATOU DAO MVP, providing integration with KERI (identity), any-sync (data synchronization), and anystore (local storage).

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        MATOU Backend                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐         │
│  │   Config    │    │   anystore  │    │   anysync   │         │
│  │  (bootstrap)│    │(local cache)│    │  (P2P sync) │         │
│  └──────┬──────┘    └──────┬──────┘    └──────┬──────┘         │
│         │                  │                  │                 │
│         └──────────────────┼──────────────────┘                 │
│                            │                                    │
│                     ┌──────┴──────┐                             │
│                     │  HTTP API   │                             │
│                     │  (port 8080)│                             │
│                     └─────────────┘                             │
└─────────────────────────────────────────────────────────────────┘
         │                                           │
         ▼                                           ▼
┌─────────────────┐                       ┌─────────────────┐
│     KERIA       │                       │    any-sync     │
│  (port 3901)    │                       │  (port 1004)    │
│                 │                       │                 │
│  Org AID keys   │                       │  P2P network    │
│  managed here   │                       │  10 containers  │
└─────────────────┘                       └─────────────────┘
```

### Identity Architecture

```
Organization AID                    Admin/User AIDs
(managed in KERIA)                  (managed on-device)
      │                                    │
      │  ──── issues credentials ────►     │
      │                                    │
      │  Steward credential grants         │
      │  permission to issue memberships   │
      │                                    │
```

- **Organization AID**: Created via `bootstrap-keria.py`, keys stored in KERIA
- **Admin/User AIDs**: Created in frontend via signify-ts, keys stored on device
- **Credentials**: Org issues steward credentials to admins, admins can then issue memberships

## Project Structure

```
backend/
├── cmd/
│   └── server/
│       └── main.go                 # Main server entry point
├── internal/
│   ├── config/
│   │   ├── config.go               # Configuration management
│   │   └── config_test.go          # Configuration tests
│   ├── anysync/
│   │   ├── client.go               # any-sync client wrapper
│   │   └── client_test.go          # any-sync client tests
│   ├── anystore/
│   │   ├── client.go               # Local storage layer (anytype-heart based)
│   │   └── client_test.go          # anystore tests
│   ├── keri/
│   │   ├── client.go               # KERI client (kli via Docker)
│   │   └── client_test.go          # KERI client tests
│   └── api/
│       ├── credentials.go          # Credential HTTP endpoints
│       └── credentials_test.go     # Credential API tests
├── config/
│   ├── bootstrap.yaml              # Bootstrap config (gitignored)
│   ├── .org-passcode               # Org passcode (gitignored)
│   └── .keria-config.json          # KERIA config (gitignored)
├── schemas/
│   ├── matou-membership-schema.json    # Membership ACDC schema
│   ├── operations-steward-schema.json  # Steward role schema
│   └── README.md                       # Schema management guide
├── .env                            # Environment variables (gitignored)
├── go.mod                          # Go module definition
└── go.sum                          # Go dependency checksums
```

## Quick Start

### Prerequisites

- Go 1.21+ installed
- Docker and Docker Compose
- KERI infrastructure running
- any-sync infrastructure running

### Setup Infrastructure

```bash
# Start KERI (4 containers)
cd infrastructure/keri && make up

# Start any-sync (10 containers)
cd infrastructure/any-sync && make start

# Bootstrap Organization AID
python3 infrastructure/scripts/bootstrap-keria.py
```

### Build & Run

```bash
cd backend
go build -o bin/matou-server ./cmd/server
./bin/matou-server
```

### Test Endpoints

```bash
curl http://localhost:8080/health
curl http://localhost:8080/info
```

## Environment Variables

Create `.env` file (gitignored):

```bash
# Organization Identity
MATOU_ORG_AID=<your-org-aid>
MATOU_ORG_PASSCODE=<your-org-passcode>

# KERIA Configuration
KERIA_ADMIN_URL=http://localhost:3901
KERIA_BOOT_URL=http://localhost:3903
KERIA_CONTAINER=matou-keria

# any-sync Configuration
ANYSYNC_COORDINATOR_URL=http://localhost:1004
```

## anystore - Local Storage Layer

The `anystore` package provides a local storage layer based on anytype-heart's storage patterns:

```go
import "github.com/matou-dao/backend/internal/anystore"

// Initialize store
store, err := anystore.NewLocalStore(&anystore.Config{
    DataDir: "./data",
})

// Store credentials
err = store.Credentials().Set(ctx, "cred-id", credentialData)

// Build trust graph
err = store.TrustGraph().Set(ctx, "node-id", trustNode)

// User preferences
err = store.Preferences().Set(ctx, "user-id", prefs)
```

### Collections

| Collection | Purpose |
|------------|---------|
| `CredentialsCache` | ACDC credentials storage |
| `TrustGraphCache` | Trust graph nodes and edges |
| `UserPreferences` | User settings and preferences |
| `KELCache` | Key Event Logs cache |
| `SyncIndex` | any-sync synchronization state |

## Testing

```bash
# Run all tests
go test ./... -v

# Test specific packages
go test ./internal/config/... -v
go test ./internal/anystore/... -v
go test ./internal/anysync/... -v

# With coverage
go test ./... -cover
```

## API Endpoints

### System

- `GET /health` - Health check with org AID
- `GET /info` - System information

### Organization

- `GET /api/v1/org` - Get organization info (AID, roles, schema) for frontend

### Credentials

**Note:** Credential issuance is handled by the frontend via signify-ts. The backend stores, retrieves, and validates credentials.

- `GET /api/v1/credentials` - List stored credentials
- `POST /api/v1/credentials` - Store a credential from frontend
- `GET /api/v1/credentials/{said}` - Get credential by SAID
- `POST /api/v1/credentials/validate` - Validate credential structure
- `GET /api/v1/credentials/roles` - List available roles and permissions

#### Get Organization Info

```bash
curl http://localhost:8080/api/v1/org
```

#### Store Credential (from frontend)

```bash
curl -X POST http://localhost:8080/api/v1/credentials \
  -H "Content-Type: application/json" \
  -d '{
    "credential": {
      "said": "ESAID123...",
      "issuer": "EORG_AID...",
      "recipient": "EUSER_AID...",
      "schema": "EMatouMembershipSchemaV1",
      "data": {
        "communityName": "MATOU",
        "role": "Member",
        "verificationStatus": "unverified",
        "permissions": ["read", "comment"],
        "joinedAt": "2026-01-18T00:00:00Z"
      }
    }
  }'
```

#### Validate Credential

```bash
curl -X POST http://localhost:8080/api/v1/credentials/validate \
  -H "Content-Type: application/json" \
  -d '{"credential": {...}}'
```

#### List Roles

```bash
curl http://localhost:8080/api/v1/credentials/roles
```

## ACDC Schemas

ACDC (Authentic Chained Data Containers) schemas define the structure of verifiable credentials. Schemas are located in `backend/schemas/`.

**Important:** Schemas use SAIDs (Self-Addressing IDentifiers) - cryptographic hashes of the schema content. If you modify a schema, you must re-SAIDify it.

See [schemas/README.md](schemas/README.md) for:
- How to update schemas
- SAIDification process
- Schema server setup
- Troubleshooting

### Schema Server

The schema server serves schemas at `/oobi/{SAID}` endpoints (required for credential issuance):

```bash
# Start schema server (required before issuing credentials)
cd infrastructure/scripts
python3 schema-server.py --port 7723
```

## Bootstrap Scripts

Located in `infrastructure/scripts/`:

| Script | Purpose |
|--------|---------|
| `bootstrap-keria.py` | Create Organization AID in KERIA |
| `issue-credentials.py` | Issue ACDC credentials to users |
| `schema-server.py` | Serve schemas for OOBI resolution |

### Issue Credentials

After admin creates their identity in the frontend:

```bash
# 1. Start schema server (if not running)
python3 infrastructure/scripts/schema-server.py &

# 2. Issue credential
python3 infrastructure/scripts/issue-credentials.py \
  --recipient <ADMIN_AID> \
  --role "Operations Steward" \
  --acdc
```

## Troubleshooting

### KERI Not Running

```bash
cd infrastructure/keri && make up && make health
```

### any-sync Not Running

```bash
cd infrastructure/any-sync && make start && ./scripts/health-check.sh
```

### Missing Bootstrap Config

```bash
python3 infrastructure/scripts/bootstrap-keria.py
```

### Container Crashed

```bash
docker ps -a  # Check status
cd infrastructure/keri && make restart
```

## References

- [MVP Implementation Plan](../Keri-AnySync-Research/MVP-IMPLEMENTATION-PLAN-V2.md)
- [Credential Issuance Guide](../infrastructure/scripts/CREDENTIAL-ISSUANCE-GUIDE.md)
- [KERI Documentation](https://github.com/weboftrust/keri)
- [any-sync Documentation](https://github.com/anyproto/any-sync)
- [anytype-heart](https://github.com/anyproto/anytype-heart)
