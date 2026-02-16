# AI Priming Document

Follow the instructions below to understand the context of this project.

## Project Overview

Matou App - Frontend and backend for the Matou Indigenous Identity Protocol.
- **Frontend**: Quasar/Vue.js + Electron app
- **Backend**: Go API server with KERI identity and any-sync data synchronization

## Project Structure

Run the following command to see the project structure:

```bash
eza . --tree --git-ignore --level=3
```

## Recent Commits

Run the following command to see recent commits:

```bash
git log --oneline -15
```

## Important Files to Read

```
README.md                          # Project overview and quick start
backend/README.md                  # Backend architecture and API reference
backend/Makefile                   # Backend build and test commands
backend/docs/API.md                # API documentation
frontend/package.json              # Frontend dependencies and scripts
frontend/quasar.config.ts          # Quasar/Electron configuration
frontend/src/stores/               # Pinia stores (state management)
frontend/src/api/                  # API client code
backend/internal/api/              # API handlers
backend/internal/anysync/          # any-sync SDK integration
backend/internal/keri/             # KERI identity integration
```

## Common Commands

### Backend

```bash
cd backend

# Build and run
make build                    # Build server binary
make run                      # Build and run server
make run-test                 # Run in test mode (isolated data)

# Testing
make test                     # Run unit tests
make test-integration         # Run integration tests (auto-starts network)
make test-all                 # Run all tests
make test-coverage            # Run tests with coverage report

# Code quality
make lint                     # Run linter
make fmt                      # Format code

# Test network management
make testnet-up               # Start test network
make testnet-down             # Stop test network
make testnet-health           # Check test network health
```

### Frontend

```bash
cd frontend

# Development
npm install                   # Install dependencies
npm run dev                   # Run web dev server (Quasar)

# Testing
npm run test                  # Run E2E tests (Playwright)
npm run test:ui               # Run tests with UI
npm run test:headed           # Run tests in headed mode
npm run test:script           # Run unit tests (Vitest)

# Build
npm run build                 # Build for production

# Code quality
npm run lint                  # Run ESLint
npm run format                # Format with Prettier
```

### Infrastructure

```bash
# Start KERI infrastructure
cd ../matou-infrastructure/keri && make up && make health

# Start any-sync infrastructure
cd ../matou-infrastructure/any-sync && make up && make health
```

## Health Checks

```bash
cd frontend

# Check all services (frontend, backend, KERIA, config server)
npm run health            # Check dev services
npm run health:test       # Check test services
```

### Manual checks

```bash
# Backend (port 8080 dev, 9080 test)
curl http://localhost:8080/health

# Frontend (port 9000 dev, 9003 test)
curl -s http://localhost:9000 > /dev/null && echo "Running" || echo "Not running"
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `MATOU_ENV=test` | Enable test mode (port 9080, isolated data) |
| `MATOU_ENV=production` | Enable production mode (uses client-production.yml) |
| `MATOU_ANYSYNC_CONFIG` | Path to any-sync client config (optional) |
| `MATOU_ANYSYNC_INFRA_DIR` | Path to any-sync infrastructure |
| `MATOU_KERI_INFRA_DIR` | Path to KERI infrastructure |

## Environment Matrix

| Environment | Backend Port | any-sync Config | KERIA Ports | Org Config |
|-------------|--------------|-----------------|-------------|------------|
| dev | 8080 | client-dev.yml (1001-1006) | 3901-3904 | ./data/org-config.yaml |
| test | 9080 | client-test.yml (2001-2006) | 4901-4904 | ./data-test/org-config.yaml |
| production | dynamic | client-production.yml (remote) | remote | {dataDir}/org-config.yaml |

## any-sync Configuration

Backend uses `config/client-dev.yml` (dev), `config/client-test.yml` (test), or `config/client-production.yml` (production) for any-sync network config. After regenerating infrastructure, update these:

```bash
# After: cd ../matou-infrastructure/any-sync && make clean && make up
cp ../matou-infrastructure/any-sync/etc/client.yml backend/config/client-dev.yml

# After: cd ../matou-infrastructure/any-sync && make clean-test && make up-test
cp ../matou-infrastructure/any-sync/etc-test/client.yml backend/config/client-test.yml
```

## Example Config Files

Example config files are provided with `.example` suffix:

```
frontend/.env.example                        # Dev environment variables
frontend/.env.production.example             # Production environment variables
backend/config/client-production.yml.example # Production any-sync config template
```

Copy and customize these for your deployment.

**Note:** Organization config (`org-config.yaml`) is created automatically during frontend setup via `POST /api/v1/org/config`. No manual setup required.
