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
│   │   └── client.go               # KERIA API client (WIP)
│   └── api/
│       └── grpc/                   # gRPC API server (planned)
├── config/
│   ├── bootstrap.yaml              # Bootstrap config (gitignored)
│   ├── .org-passcode               # Org passcode (gitignored)
│   └── .keria-config.json          # KERIA config (gitignored)
├── schemas/
│   ├── matou-membership-schema.json    # Membership ACDC schema
│   └── operations-steward-schema.json  # Steward role schema
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

### Current

- `GET /health` - Health check with org AID
- `GET /info` - System information

### Planned

- `POST /identity/create` - Create new AID via KERIA
- `POST /credential/issue` - Issue ACDC credential
- `POST /credential/verify` - Verify ACDC credential

## Bootstrap Scripts

Located in `infrastructure/scripts/`:

| Script | Purpose |
|--------|---------|
| `bootstrap-keria.py` | Create Organization AID in KERIA |
| `issue-credentials.py` | Issue credentials to users |
| `CREDENTIAL-ISSUANCE-GUIDE.md` | Guide for credential management |

### Issue Credentials

After admin creates their identity in the frontend:

```bash
python3 infrastructure/scripts/issue-credentials.py \
  --recipient <ADMIN_AID> \
  --role "Operations Steward"
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
