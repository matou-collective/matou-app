# MATOU DAO Backend

Go backend service for the MATOU DAO MVP, providing integration with KERI (identity) and any-sync (data synchronization).

## Project Structure

```
backend/
├── cmd/
│   └── server/
│       └── main.go              # Main server entry point
├── internal/
│   ├── config/
│   │   ├── config.go            # Configuration management
│   │   └── config_test.go       # Configuration tests
│   ├── anysync/
│   │   ├── client.go            # any-sync client wrapper
│   │   └── client_test.go       # any-sync client tests
│   ├── keri/
│   │   └── client.go            # KERIA API client (Week 2 Day 3-4)
│   ├── api/
│   │   └── grpc/                # gRPC API server (Week 2+)
│   └── storage/
│       └── spaces.go            # Space management (Week 2+)
├── config/
│   ├── bootstrap.yaml           # Bootstrap configuration (from Week 1)
│   └── .org-passcode            # Organization passcode (secured)
├── schemas/
│   ├── matou-membership-schema.json      # Membership ACDC schema
│   └── operations-steward-schema.json    # Steward role schema
├── bin/
│   └── matou-server             # Compiled server binary
├── go.mod                       # Go module definition
└── go.sum                       # Go dependency checksums
```

## Quick Start

### Prerequisites

- Go 1.21+ installed
- KERI infrastructure running (Week 1 Day 1-2)
- any-sync infrastructure running (Week 1 Day 3-4)
- Bootstrap configuration complete (Week 1 Day 5)

### Build

```bash
cd backend
go build -o bin/matou-server ./cmd/server
```

### Run

```bash
cd backend
./bin/matou-server
```

Expected output:
```
🚀 MATOU DAO Backend Server
============================

Loading configuration...
✅ Configuration loaded
   Organization: MATOU
   Org AID: ENzuA7sM70NzL2cWO1wb1lHc2T4BxnFfo6hzdGYU6Nfr
   Admin AID: ECgSobqv2kBC9XmnP6f-nS6AMDe5Et2h2vbyDgl38duN

Initializing any-sync client...
✅ any-sync client initialized
   Network ID: N9CJPCprktBPv5SKfhw7XRft73XSCtio7aokSKqPie4dwS6j
   Coordinator: http://127.0.0.1:1004

🌐 Starting HTTP server on localhost:8080
```

### Test

```bash
# Health check
curl http://localhost:8080/health

# System info
curl http://localhost:8080/info
```

## Configuration

### Bootstrap Configuration

Located at `config/bootstrap.yaml`, generated during Week 1 Day 5:

```yaml
organization:
  name: MATOU
  aid: "ENzuA7sM70NzL2cWO1wb1lHc2T4BxnFfo6hzdGYU6Nfr"
  alias: "matou"
  witnesses:
    - http://localhost:5643
    - http://localhost:5645
    - http://localhost:5647
  witnessThreshold: 2

admin:
  aid: "ECgSobqv2kBC9XmnP6f-nS6AMDe5Et2h2vbyDgl38duN"
  alias: "admin"
  delegatedBy: "ENzuA7sM70NzL2cWO1wb1lHc2T4BxnFfo6hzdGYU6Nfr"
  credentials:
    membership: "E30ef70c862997270a5fbf8e05e46f16cffb7e25a8fdd6dc8def509fd38529021"
    steward: "Ede9739b2a521f92bdaeff365010bf6ab9a938ba18c37ea791036d8582f7829d7"

orgSpace:
  spaceId: "69f89ebfc0c3b17dba10af06f1013fef86e099d48785ececde5f9d49aff4f161"
  accessControl:
    type: acdc_required
    schema: EMatouMembershipSchemaV1
    issuer: "ENzuA7sM70NzL2cWO1wb1lHc2T4BxnFfo6hzdGYU6Nfr"
```

### Server Configuration

Default values (can be overridden in `config/config.yaml`):

```yaml
server:
  host: localhost
  port: 8080

keri:
  adminUrl: http://localhost:3901
  bootUrl: http://localhost:3903
  cesrUrl: http://localhost:3902

anysync:
  clientConfigPath: ../infrastructure/any-sync/etc/client.yml
```

## Testing

### Run All Tests

```bash
cd backend
go test ./... -v
```

### Test Configuration

```bash
go test ./internal/config/... -v
```

### Test any-sync Client

```bash
go test ./internal/anysync/... -v
```

## API Endpoints

### Current (Week 2 Day 1-2)

- `GET /health` - Health check with org/admin AIDs
- `GET /info` - System information (organization, admin, any-sync)

### Planned (Week 2 Day 3-4+)

- `POST /identity/create` - Create new AID via KERIA
- `POST /credential/issue` - Issue ACDC credential
- `POST /credential/verify` - Verify ACDC credential
- `POST /space/create` - Create any-sync space
- `GET /space/{id}` - Get space information

## Development

### Add Dependencies

```bash
go get <package>
go mod tidy
```

### Format Code

```bash
go fmt ./...
```

### Run Tests with Coverage

```bash
go test ./... -cover
```

### Build for Production

```bash
CGO_ENABLED=0 GOOS=linux go build -o bin/matou-server ./cmd/server
```

## Integration

### KERI Integration

The backend integrates with KERIA for:
- AID creation and management
- ACDC credential issuance
- ACDC credential verification
- KEL storage and retrieval

**KERIA Endpoints**:
- Admin API: http://localhost:3901
- Boot API: http://localhost:3903
- CESR API: http://localhost:3902

### any-sync Integration

The backend integrates with any-sync for:
- Space creation and management
- KEL storage
- ACDC storage
- Access control enforcement

**any-sync Endpoints**:
- Coordinator: http://localhost:1004
- Consensus: http://localhost:1006
- Sync Nodes: http://localhost:1001-1003
- File Node: http://localhost:1005

## Week 2 Progress

### Day 1-2: ✅ COMPLETE

- [x] Go project initialized
- [x] Project structure created
- [x] Configuration management implemented
- [x] Bootstrap config loader working
- [x] any-sync client wrapper created
- [x] Client connectivity tested
- [x] Basic HTTP server running
- [x] Tests passing

### Day 3-4: ⏳ NEXT

- [ ] KERIA API client
- [ ] AID creation endpoint
- [ ] KEL storage in any-sync
- [ ] Integration tests

## Troubleshooting

### Configuration Errors

If bootstrap config is missing:
```bash
cd infrastructure && ./scripts/bootstrap-matou.sh
```

### KERI Not Accessible

Start KERI infrastructure:
```bash
cd infrastructure/keri && make up
```

### any-sync Not Accessible

Start any-sync infrastructure:
```bash
cd infrastructure/any-sync && make start
```

### Build Errors

```bash
go mod tidy  # Update dependencies
go clean     # Clean build cache
```

## References

- MVP Plan: `../Keri-AnySync-Research/MVP-IMPLEMENTATION-PLAN-V2.md`
- KERI Documentation: https://github.com/weboftrust/keri
- any-sync Documentation: https://github.com/anyproto/any-sync

## Version Info

- **Go Version**: 1.21+
- **Module**: github.com/matou-dao/backend
- **Dependencies**: See go.mod
- **Last Updated**: 2025-12-31
