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
│  managed here   │                       │  14 services    │
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

- **Organization AID**: Created via frontend `/setup` flow, keys stored in KERIA
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
│   │   └── config_test.go
│   ├── anysync/
│   │   ├── sdk_client.go           # any-sync SDK client wrapper
│   │   ├── acl.go                  # ACL management (invite/join)
│   │   ├── credential_tree.go      # Encrypted credential trees
│   │   ├── object_tree.go          # Object tree management
│   │   ├── file_manager.go         # File upload/download via filenode
│   │   ├── file_blockstore.go      # Block-level file storage
│   │   ├── spaces.go               # Space type management
│   │   ├── keys.go                 # Key generation and management
│   │   ├── peer.go                 # Peer key management
│   │   ├── interface.go            # AnySyncClient interface
│   │   ├── integration_test.go     # Integration tests
│   │   ├── testing/                # Test helpers
│   │   └── testnet/                # Test network management
│   ├── anystore/
│   │   ├── client.go               # Local storage layer (anytype-heart based)
│   │   ├── space_adapter.go        # Space storage adapter
│   │   └── client_test.go
│   ├── keri/
│   │   ├── client.go               # KERI config & credential validation (no KERIA connection)
│   │   ├── client_test.go
│   │   └── testnet/                # KERI test helpers
│   ├── api/
│   │   ├── credentials.go          # Credential HTTP endpoints
│   │   ├── sync.go                 # Sync endpoints (credentials, KEL)
│   │   ├── trust.go                # Trust graph endpoints
│   │   ├── health.go               # Health check endpoints
│   │   ├── identity.go             # User identity management
│   │   ├── spaces.go               # Space creation, invite, join
│   │   ├── profiles.go             # Profile CRUD and types
│   │   ├── files.go                # File upload/download
│   │   ├── events.go               # SSE event stream
│   │   ├── invites.go              # Email invitations
│   │   ├── org.go                  # Org config endpoints (replaces config server)
│   │   ├── middleware.go           # CORS, logging middleware
│   │   └── *_test.go              # Tests for each handler
│   ├── email/
│   │   ├── email.go                # Email sending
│   │   ├── template.go             # Email templates
│   │   └── integration_test.go
│   ├── identity/
│   │   └── identity.go             # User identity management
│   ├── sync/
│   │   └── worker.go               # Background sync worker
│   ├── trust/
│   │   ├── builder.go              # Trust graph builder
│   │   ├── score.go                # Trust score calculator
│   │   └── types.go                # Trust graph types
│   └── types/
│       ├── definition.go           # Type definitions
│       ├── profiles.go             # Profile type system
│       ├── registry.go             # Type registry
│       └── validate.go             # Validation
├── config/
│   ├── bootstrap.yaml              # Bootstrap config (gitignored, created during setup)
│   ├── bootstrap.yaml.example      # Bootstrap config template
│   ├── bootstrap-test.yaml         # Test mode bootstrap config
│   ├── client-dev.yml              # any-sync client config for dev network (ports 1001-1006)
│   ├── client-test.yml             # any-sync client config for test network (ports 2001-2006)
│   ├── client-production.yml.example # Production any-sync config template
│   ├── .org-passcode               # Org passcode (gitignored)
│   └── .keria-config.json          # KERIA config (gitignored)
├── docs/
│   └── API.md                      # API reference documentation
├── schemas/
│   ├── matou-membership-schema.json    # Membership ACDC schema
│   ├── operations-steward-schema.json  # Steward role schema
│   └── README.md                       # Schema management guide
├── Makefile                        # Build and development targets
├── go.mod                          # Go module definition
└── go.sum                          # Go dependency checksums
```

## Quick Start

### Prerequisites

- Go 1.21+ installed
- Docker and Docker Compose
- KERI infrastructure running (matou-infrastructure repo)
- any-sync infrastructure running (matou-infrastructure repo)

### 1. Initial Configuration Setup

Copy the example config files:

```bash
cd backend

# Bootstrap config (required - will be populated during org setup)
cp config/bootstrap.yaml.example config/bootstrap.yaml

# any-sync client configs are already committed for dev/test
# For production, copy and customize:
cp config/client-production.yml.example config/client-production.yml
```

### 2. Start Infrastructure

```bash
# Start KERI infrastructure
cd ../matou-infrastructure/keri && make up && make health

# Start any-sync (dev network)
cd ../matou-infrastructure/any-sync && make up && make health
```

### 3. Build & Run

```bash
cd backend
go build -o bin/server ./cmd/server
./bin/server
```

### 4. Verify

```bash
curl http://localhost:8080/health
curl http://localhost:8080/info
```

## Running Different Environments

The backend supports three environments: **dev**, **test**, and **production**.

### Development (default)

```bash
# Start dev infrastructure
cd ../matou-infrastructure/keri && make up
cd ../matou-infrastructure/any-sync && make up

# Run backend
cd backend
go run ./cmd/server

# Or with make
make run
```

| Setting | Value |
|---------|-------|
| Port | 8080 |
| Data directory | `./data` |
| any-sync config | `config/client-dev.yml` |
| any-sync ports | 1001-1006 |
| KERIA ports | 3901-3904 |
| Bootstrap | `config/bootstrap.yaml` |

### Test Mode

Isolated environment for automated testing. Uses separate ports and data directories.

```bash
# Start test infrastructure
cd ../matou-infrastructure/keri && make up-test
cd ../matou-infrastructure/any-sync && make up-test

# Run backend in test mode
cd backend
MATOU_ENV=test go run ./cmd/server

# Or with make
make run-test
```

| Setting | Value |
|---------|-------|
| Port | 9080 |
| Data directory | `./data-test` |
| any-sync config | `config/client-test.yml` |
| any-sync ports | 2001-2006 |
| KERIA ports | 4901-4904 |
| Bootstrap | `config/bootstrap-test.yaml` |

### Production Mode

For packaged Electron apps or production deployments.

```bash
# Configure production any-sync (copy from your production infrastructure)
cp /path/to/production/client.yml config/client-production.yml

# Run in production mode
MATOU_ENV=production go run ./cmd/server
```

| Setting | Value |
|---------|-------|
| Port | Dynamic (set via `MATOU_SERVER_PORT`) |
| Data directory | Set via `MATOU_DATA_DIR` |
| any-sync config | `config/client-production.yml` |
| any-sync ports | Remote (configured in yml) |
| KERIA ports | Remote |
| Bootstrap | `config/bootstrap.yaml` |

**Note:** In Electron, production mode is automatically enabled when the app is packaged (`app.isPackaged`). The backend receives `MATOU_ENV=production` from the Electron main process.

## Environment Variables

The backend reads configuration primarily from the YAML bootstrap file. The following environment variables provide overrides:

```bash
# Runtime Environment
MATOU_ENV=test                    # "test" for test mode, "production" for production
MATOU_SERVER_PORT=8080            # Override server port
MATOU_DATA_DIR=./data             # Override data directory

# any-sync (optional - defaults based on MATOU_ENV)
MATOU_ANYSYNC_CONFIG=config/client-dev.yml  # Override any-sync config path

# Email (SMTP)
MATOU_SMTP_HOST=localhost         # SMTP relay host
MATOU_SMTP_PORT=2525              # SMTP relay port

# CORS
MATOU_CORS_MODE=permissive        # CORS mode setting
```

## any-sync Configuration

The backend connects to the any-sync P2P network using client config files that contain network identity (IDs, peer IDs, addresses). These configs are generated by the `matou-infrastructure` repo.

### Config Files

| File | Network | Ports | Used When |
|------|---------|-------|-----------|
| `config/client-dev.yml` | Dev | 1001-1006 | `go run ./cmd/server` |
| `config/client-test.yml` | Test | 2001-2006 | `MATOU_ENV=test go run ./cmd/server` |
| `config/client-production.yml` | Production | Remote | `MATOU_ENV=production go run ./cmd/server` |

**Example files** (`.example` suffix) are provided as templates:

| Example File | Copy To | Purpose |
|--------------|---------|---------|
| `bootstrap.yaml.example` | `bootstrap.yaml` | Org identity config (populated during setup) |
| `client-production.yml.example` | `client-production.yml` | Production any-sync network config |

### Updating After Infrastructure Changes

When you regenerate the any-sync infrastructure (e.g., `make clean && make up`), the network IDs and peer IDs change. Update the backend configs:

```bash
# For dev network
cp ../matou-infrastructure/any-sync/etc/client.yml config/client-dev.yml

# For test network
cp ../matou-infrastructure/any-sync/etc-test/client.yml config/client-test.yml
```

## anystore - Local Storage Layer

The `anystore` package provides a local storage layer based on anytype-heart's storage patterns:

```go
import "github.com/matou-dao/backend/internal/anystore"

// Initialize store
store, err := anystore.NewLocalStore(anystore.DefaultConfig("./data"))

// Store credentials
err = store.StoreCredential(ctx, &anystore.CachedCredential{ID: "cred-id", ...})

// Build trust graph
err = store.StoreTrustNode(ctx, &anystore.TrustGraphNode{AID: "node-id", ...})

// User preferences
err = store.SetPreference(ctx, "key", value)
```

### Collections

| Collection | Purpose |
|------------|---------|
| `CredentialsCache` | ACDC credentials storage |
| `TrustGraphCache` | Trust graph nodes and edges |
| `UserPreferences` | User settings and preferences |
| `KELCache` | Key Event Logs cache |
| `SyncIndex` | any-sync synchronization state |
| `Spaces` | Space registry (maps user AIDs to any-sync space IDs) |

## Testing

### Unit Tests

```bash
cd backend

# Run all unit tests
go test ./... -v

# Test specific packages
go test ./internal/config/... -v
go test ./internal/anystore/... -v
go test ./internal/anysync/... -v

# With coverage
go test ./... -cover
```

### Integration Tests (any-sync network)

Integration tests run the full SDK client against a real any-sync test network
(ports 2001-2006). They require Docker.

```bash
cd backend

# Start the test network (if not already running)
cd ../infrastructure/any-sync && make start-and-wait-test && cd -

# Run integration tests
KEEP_TEST_NETWORK=1 go test -tags=integration -v -timeout 120s ./internal/anysync/...
```

`KEEP_TEST_NETWORK=1` keeps the network running between test runs so you don't
wait for Docker startup each time. Without it, the test harness starts and stops
the network automatically.

#### Managing the test network manually

```bash
cd infrastructure/any-sync

make start-and-wait-test   # Start and wait for readiness
make -s is-running-test    # Check if running
make down-test             # Stop
make clean-test            # Stop and remove all data
```

#### Test network ports

| Service      | Port(s)   |
|--------------|-----------|
| Sync nodes   | 2001-2003 |
| Coordinator  | 2004      |
| File node    | 2005      |
| Consensus    | 2006      |
| MongoDB      | 28017     |
| Redis        | 7379      |

## API Endpoints

See [docs/API.md](docs/API.md) for the complete API reference.

### System

- `GET /health` - Health check with org AID
- `GET /info` - System information

### Organization

- `GET /api/v1/org` - Get organization info (AID, roles, schema) for frontend
- `GET /api/v1/org/config` - Get org configuration (replaces config server)
- `POST /api/v1/org/config` - Save org configuration
- `GET /api/v1/org/health` - Config service health check

### Identity

- `POST /api/v1/identity/set` - Set user identity (AID + mnemonic)
- `GET /api/v1/identity` - Get current identity status
- `DELETE /api/v1/identity` - Clear identity (logout/reset)

### Credentials

- `GET /api/v1/credentials` - List stored credentials
- `POST /api/v1/credentials` - Store a credential from frontend
- `GET /api/v1/credentials/{said}` - Get credential by SAID
- `POST /api/v1/credentials/validate` - Validate credential structure
- `GET /api/v1/credentials/roles` - List available roles and permissions

### Sync

- `POST /api/v1/sync/credentials` - Sync credentials to backend storage
- `POST /api/v1/sync/kel` - Sync Key Event Log events

### Community

- `GET /api/v1/community/members` - List community members
- `GET /api/v1/community/credentials` - List community credentials

### Trust Graph

- `GET /api/v1/trust/graph` - Get computed trust graph
- `GET /api/v1/trust/score/{aid}` - Get trust score for an AID
- `GET /api/v1/trust/scores` - Get top N trust scores
- `GET /api/v1/trust/summary` - Trust graph statistics

### Spaces

- `POST /api/v1/spaces/community` - Create community space
- `GET /api/v1/spaces/community` - Get community space info
- `POST /api/v1/spaces/private` - Create private space
- `POST /api/v1/spaces/community/invite` - Generate invite for community space
- `POST /api/v1/spaces/community/join` - Join community space with invite key
- `GET /api/v1/spaces/community/verify-access` - Verify community space access
- `POST /api/v1/spaces/community-readonly/invite` - Generate reader invite
- `GET /api/v1/spaces/user` - Get all spaces for current user
- `GET /api/v1/spaces/sync-status` - Check space sync readiness

### Profiles & Types

- `GET /api/v1/types` - List all type definitions
- `GET /api/v1/types/{name}` - Get specific type definition
- `POST /api/v1/profiles` - Create/update a profile object
- `GET /api/v1/profiles/{type}` - List profiles of a type
- `GET /api/v1/profiles/{type}/{id}` - Get a specific profile
- `GET /api/v1/profiles/me` - Get current user's profiles
- `POST /api/v1/profiles/init-member` - Initialize member profiles (admin)

### Files

- `POST /api/v1/files/upload` - Upload file (images only, max 5MB)
- `GET /api/v1/files/{ref}` - Download file by CID ref

### Events

- `GET /api/v1/events` - SSE event stream for real-time updates

### Invitations

- `POST /api/v1/invites/send-email` - Email invite code to a user

## ACDC Schemas

ACDC (Authentic Chained Data Containers) schemas define the structure of verifiable credentials. Schemas are located in `backend/schemas/`.

**Important:** Schemas use SAIDs (Self-Addressing IDentifiers) - cryptographic hashes of the schema content. If you modify a schema, you must re-SAIDify it.

See [schemas/README.md](schemas/README.md) for:
- How to update schemas
- SAIDification process
- Schema server setup
- Troubleshooting

### Schema Server

The schema server runs as part of the KERI infrastructure (Docker container on port 7723), serving schemas at `/oobi/{SAID}` endpoints required for credential issuance.

## Infrastructure Scripts

Located in `infrastructure/scripts/`:

| Script | Purpose |
|--------|---------|
| `schema-server.py` | Serve ACDC schemas for OOBI resolution |

Located in `infrastructure/keri/scripts/`:

| Script | Purpose |
|--------|---------|
| `config-server.py` | Store and serve org configuration |
| `health-check.sh` | Health check for KERI infrastructure |

### Organization Setup

Organization setup is done via the frontend. This process populates `config/bootstrap.yaml` and the org config stored by the backend.

**Prerequisites:**
- Backend running (dev or test mode)
- KERI infrastructure running
- any-sync infrastructure running
- Frontend running

**Steps:**

1. Ensure infrastructure is running:
   ```bash
   cd ../matou-infrastructure/keri && make up && make health
   cd ../matou-infrastructure/any-sync && make up && make health
   ```

2. Start backend:
   ```bash
   cd backend && make run
   ```

3. Start frontend:
   ```bash
   cd frontend && npm run dev
   ```

4. Open http://localhost:9000 - you'll be redirected to `/setup` if no org exists

5. Complete the setup wizard:
   - Enter organization name
   - Enter admin name
   - The frontend creates: org AID, admin AID, registry, credentials, and community spaces

6. The frontend saves org config to:
   - Backend: `{dataDir}/org-config.yaml` (via `POST /api/v1/org/config`)
   - Config server: For backward compatibility (if running)

## Troubleshooting

### KERI Not Running

```bash
cd infrastructure/keri && make up && make health
```

### any-sync Not Running

```bash
cd infrastructure/any-sync && make up && make health
```

### Container Crashed

```bash
docker ps -a  # Check status
cd infrastructure/keri && make restart
```

## References

- [KERI Documentation](https://github.com/weboftrust/keri)
- [any-sync Documentation](https://github.com/anyproto/any-sync)
- [anytype-heart](https://github.com/anyproto/anytype-heart)
