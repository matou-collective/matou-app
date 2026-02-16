# Matou App

Frontend and backend for the Matou Indigenous Identity Protocol.

## Prerequisites

- **Go 1.21+** (backend)
- **Node.js 18+** and **pnpm** (frontend)
- **matou-infrastructure** repo cloned as a sibling directory (for local infrastructure)

## Repository Structure

```
matou-app/
├── frontend/          # Quasar/Vue.js + Electron app
├── backend/           # Go API server
└── README.md
```

## Quick Start

### 1. Clone repos side by side

```bash
git clone <matou-infrastructure-url> matou-infrastructure
git clone <matou-app-url> matou-app
```

### 2. Start infrastructure

```bash
cd matou-infrastructure
make up
make health
```

### 3. Run the backend

```bash
cd matou-app/backend
cp config/client-host.yml config/client.yml   # Copy any-sync client config
go build ./cmd/server
./bin/server
```

The backend reads `config/client.yml` for any-sync connection settings by default. Override with the `MATOU_ANYSYNC_CONFIG` env var to point elsewhere.

### 4. Run the frontend

```bash
cd matou-app/frontend
pnpm install
pnpm dev           # Web dev server
# or
pnpm dev:electron  # Electron dev mode
```

## Testing

### Unit tests (no external dependencies)

```bash
cd backend
make test
```

### Integration tests (requires infrastructure)

Integration tests need the infrastructure running. Set the env vars pointing to your `matou-infrastructure` clone:

```bash
export MATOU_ANYSYNC_INFRA_DIR=../../matou-infrastructure/any-sync
export MATOU_KERI_INFRA_DIR=../../matou-infrastructure/keri

cd backend
make test-integration
```

Or use the Makefile testnet targets (defaults to sibling `matou-infrastructure` dir):

```bash
cd backend
make testnet-up          # Start test network
make test-integration    # Run integration tests
make testnet-down        # Stop test network
```

Override the infrastructure location:

```bash
make testnet-up ANYSYNC_INFRA_DIR=/path/to/matou-infrastructure/any-sync
```

### Frontend E2E tests

```bash
cd frontend
pnpm test:e2e
```

## Remote Infrastructure

The backend and frontend connect to infrastructure entirely over the network. To use a remote infrastructure server:

1. **Backend**: Edit `backend/config/client.yml` to replace `127.0.0.1` addresses with the remote server's address
2. **Frontend**: Set `VITE_KERIA_ADMIN_URL`, `VITE_KERIA_BOOT_URL`, `VITE_KERIA_CESR_URL` in `frontend/.env` to point to the remote server

## Deployment

See [docs/deployment.md](docs/deployment.md) for instructions on building and releasing the desktop app for Linux, macOS, and Windows.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MATOU_ANYSYNC_CONFIG` | Path to any-sync client config | `config/client.yml` |
| `MATOU_ANYSYNC_INFRA_DIR` | Path to any-sync infrastructure (for integration tests) | - |
| `MATOU_KERI_INFRA_DIR` | Path to KERI infrastructure (for integration tests) | - |
| `MATOU_ENV` | Environment mode (`test` for isolated data) | - |
| `MATOU_SMTP_HOST` | SMTP relay host | `localhost` |
| `MATOU_SMTP_PORT` | SMTP relay port | `2525` |
