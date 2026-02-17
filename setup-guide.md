# Development & Test Environment Setup Guide

This guide covers setting up the Matou application for local development and running Playwright E2E tests. Both environments exercise real KERI identity management and any-sync P2P data synchronization.

---

## Development Environment

### Overview

The `dev:sessions` script starts paired frontend + backend instances for local development. Each session gets its own ports and data directory, so you can run multiple users simultaneously in separate browser windows to test multi-user features (registration approval, credential issuance, P2P data sync, etc.).

```
 KERI Dev Network (Docker)          AnySync Dev Network (Docker)
 +--------------------------+       +----------------------------+
 | KERIA      :3901-3903    |       | Coordinator                |
 | Witnesses  :5642-5647    |       | Sync Nodes                 |
 | Config Server  :3904     |       | MongoDB, Redis             |
 | Schema Server  :7723     |       +----------------------------+
 +--------------------------+
            |                                   |
            v                                   v
     +----------------------------------------------+
     | Session 1: Backend :4000  (data: ./data)      |
     | Session 2: Backend :4001  (data: ./data2)     |
     | Session 3: Backend :4002  (data: ./data3)     |
     +----------------------------------------------+
            |
            v
     +----------------------------------------------+
     | Session 1: Frontend :5100                     |
     | Session 2: Frontend :5101                     |
     | Session 3: Frontend :5102                     |
     +----------------------------------------------+
```

Each frontend is compiled with `VITE_BACKEND_URL` pointing to its paired backend, so the sessions are fully isolated at the application layer while sharing the same KERI and any-sync networks for P2P synchronization.

### Prerequisites

- **Docker** and **Docker Compose** (for KERI and any-sync networks)
- **Go 1.22+** (for the backend)
- **Node.js 20+** and **npm** (for the frontend)
- **matou-infrastructure** repo cloned as a sibling directory:
  ```
  ~/projects/
    matou-app/              # this repo
    matou-infrastructure/   # KERI + any-sync Docker configs
  ```

### Step 1: Start the KERI Dev Network

```bash
cd ../matou-infrastructure/keri
make start-and-wait
```

This starts KERIA, witnesses, config server, and schema server on **dev ports** (3901-3904, 5642-5647, 7723). These are the default ports — no offset applied.

**Verify:**
```bash
make ready
curl http://localhost:3904/api/health
```

### Step 2: Start the AnySync Dev Network

```bash
cd ../matou-infrastructure/any-sync
make start-and-wait
```

### Step 3: Start Dev Sessions

From the `frontend/` directory:

```bash
# Start 1 session (admin user)
npm run dev:sessions

# Start 2 sessions (admin + member)
npm run dev:sessions:2

# Start 3 sessions
npm run dev:sessions:3
```

This runs `scripts/dev-sessions.sh` which, for each session:
1. Starts a **backend** (`go run ./cmd/server`) with `MATOU_SERVER_PORT` and `MATOU_DATA_DIR` set per session
2. Waits for the backend health check to pass (up to 30s, longer on first run due to Go compilation)
3. Starts a **frontend** (`quasar dev`) with `VITE_BACKEND_URL` pointing to the paired backend

The script runs everything in the background with logs written to `/tmp/matou-dev/`.

### Session Management

```bash
# Check which sessions are running
npm run dev:sessions:status

# View logs for session 1
npm run dev:sessions:logs -- 1

# View only backend logs for session 2
npm run dev:sessions:logs -- 2 backend

# Stop all sessions
npm run dev:sessions:stop
```

### Session Port Mapping

| Session | Frontend | Backend | Data Directory |
|---------|----------|---------|----------------|
| 1 | http://localhost:5100 | http://localhost:4000 | `backend/data` |
| 2 | http://localhost:5101 | http://localhost:4001 | `backend/data2` |
| 3 | http://localhost:5102 | http://localhost:4002 | `backend/data3` |

### Typical Multi-User Dev Workflow

1. Start the KERI and any-sync Docker networks
2. Run `npm run dev:sessions:2` to start an admin session and a member session
3. Open http://localhost:5100 — go through org setup, create the admin account
4. Open http://localhost:5101 — register as a new member
5. Back in session 1, approve the member's registration
6. Both sessions now share the same community spaces via any-sync P2P sync
7. Both users can now interact — test features like chat, shared data, and P2P sync

### Environment Configuration

The frontend reads environment variables at build time via Vite:

| Variable | Dev Default | Description |
|----------|-------------|-------------|
| `VITE_ENV` | `dev` | Environment mode (`dev`, `test`, `prod`) |
| `VITE_BACKEND_URL` | `http://localhost:4000` | Backend API base URL |
| `VITE_DEV_CONFIG_URL` | `http://localhost:3904` | KERI config server (dev network) |
| `VITE_TEST_CONFIG_URL` | `http://localhost:4904` | KERI config server (test network) |

Copy `.env.example` to `.env` for customization. The `dev:sessions` script overrides `VITE_BACKEND_URL` per session automatically.

### Running Without dev:sessions

You can also start things manually if you prefer:

```bash
# Terminal 1: Backend
cd backend
go run ./cmd/server

# Terminal 2: Frontend
cd frontend
npm run dev
```

This starts a single session with the backend on port 8080 (default) and the frontend on the Quasar default port (typically 9000 or 9002). Make sure your `.env` file has `VITE_BACKEND_URL=http://localhost:8080` to match.

### Credentials, Config, and Data Management

Understanding where state lives is essential for debugging and for knowing what to clean when things go wrong.

#### Where State Lives

State is spread across four layers. Each session (1, 2, 3) has its own backend data directory, but all sessions share the same KERI and any-sync Docker networks.

```
Layer               What's stored                        Location
─────────────────── ──────────────────────────────────── ─────────────────────────────
KERI Agent (Docker) Agent keystore, key event logs        Inside KERIA Docker container
                    Witness key state                     Inside witness Docker containers

Backend (Go)        identity.json (AID + mnemonic)        backend/data/         (session 1)
                    org-config.yaml (org identity)        backend/data2/        (session 2)
                    keys/{spaceID}.keys (space keys)      backend/dataN/        (session N)
                    peer.key (P2P identity)
                    matou.db (SQLite — any-store)
                    spaces/ (any-sync tree data)

Frontend (Browser)  matou_passcode (KERIA auth token)     localStorage (dev)
                    matou_mnemonic (12 words)              Electron safeStorage (prod)
                    matou_org_config (cached org config)
                    matou_client_config (KERIA URLs)
                    matou_admin_aid, matou_org_aid

Config Server       org config (shared across backends)   Inside config-server Docker container
(Docker)
```

#### Backend Data Directory Contents

Each session's data directory (e.g. `backend/data/` for session 1, `backend/data2/` for session 2) contains:

| File | Description | Sensitive |
|------|-------------|-----------|
| `identity.json` | User's AID, BIP39 mnemonic, space IDs | Yes |
| `org-config.yaml` | Organization name, AID, admin list, space IDs | No |
| `peer.key` | Ed25519 key derived from mnemonic for P2P networking | Yes |
| `keys/{spaceID}.keys` | Space encryption keys (Ed25519 signing + AES-256 read key) | Yes |
| `matou.db` | SQLite database — credentials, profiles, application data (via any-store) | Yes |
| `spaces/{spaceID}/` | Any-sync object tree data (CRDT history) | Yes |

All sensitive files are written with `0600` permissions (owner read/write only).

#### Frontend Storage Keys

The frontend stores identity state in the browser (localStorage in dev, Electron safeStorage in production):

| Key | Set During | Contains |
|-----|-----------|----------|
| `matou_passcode` | Login / org setup | 21-char base64 string derived from mnemonic (KERIA auth) |
| `matou_mnemonic` | Registration / org setup | 12 BIP39 words (space separated) |
| `matou_org_aid` | Org setup | Organization AID string |
| `matou_admin_aid` | Org setup | Admin's AID string |
| `matou_org_config` | Boot / login | Cached org config JSON (fallback when backend unreachable) |
| `matou_client_config` | Boot | Cached KERIA/witness URLs from config server |

#### Inspecting State

**Check backend identity:**
```bash
# Session 1
curl -s http://localhost:4000/api/v1/identity | python3 -m json.tool

# Session 2
curl -s http://localhost:4001/api/v1/identity | python3 -m json.tool
```

Response when configured:
```json
{
  "configured": true,
  "aid": "EMhP2Nwxa7...",
  "peerId": "12D3KooW...",
  "communitySpaceId": "bafyrei..."
}
```

Response when not configured:
```json
{ "configured": false }
```

**Check org config:**
```bash
curl -s http://localhost:4000/api/v1/org/config | python3 -m json.tool
```

**Check what's on disk:**
```bash
# List data directory contents
ls -la backend/data/

# View identity (contains mnemonic — be careful in shared environments)
cat backend/data/identity.json | python3 -m json.tool

# View org config
cat backend/data/org-config.yaml

# List space keys
ls backend/data/keys/
```

**Check frontend storage (in browser DevTools):**
1. Open DevTools (F12) → Application → Local Storage
2. Look for keys prefixed with `matou_`
3. `matou_passcode` and `matou_mnemonic` are the critical identity credentials

**Check KERI agent health:**
```bash
# Dev network KERIA
curl -s http://localhost:3901/
# Returns 401 if running (requires auth)

# List agents via boot endpoint
curl -s http://localhost:3903/
```

#### Resetting Individual Components

**Clear backend identity only** (keeps org config and spaces):
```bash
curl -X DELETE http://localhost:4000/api/v1/identity
```
The backend will restart in "unconfigured" mode. The frontend will redirect to the splash screen on next load.

**Clear org config only** (keeps identity):
```bash
curl -X DELETE http://localhost:4000/api/v1/org/config
```
The backend keeps its identity but forgets the organization. The frontend will redirect to the setup page.

**Clear config server** (affects all sessions):
```bash
# Dev network config server
curl -X DELETE http://localhost:3904/api/config
```
All backends will lose their shared org config on next fetch. Each session's local `org-config.yaml` is unaffected until the backend restarts.

**Clear frontend storage** (per browser tab):
- Open DevTools → Application → Local Storage → Clear All
- Or run in the console:
  ```javascript
  localStorage.clear();
  location.reload();
  ```
  The app will return to the splash screen. If the backend still has identity configured, the boot sequence will attempt to restore the session.

#### Starting Completely Fresh

When things get into an inconsistent state (mismatched identities between frontend and backend, stale KERI agents, corrupted any-sync trees), the cleanest fix is a full reset.

**Step 1: Stop sessions and clean backend data**
```bash
# Stop all running dev sessions
npm run dev:sessions:stop

# Wipe all session data (identity, org config, space keys, peer keys, SQLite, any-sync trees)
cd backend && make clean-data
```

`make clean-data` removes `data/`, `data2/`, `data3/`, etc. — all dev session directories. Other clean targets:

| Target | What it removes |
|--------|----------------|
| `make clean` | Build artifacts only (`bin/`, coverage files, test cache) |
| `make clean-data` | All dev session data (`data/`, `data2/`, ...) |
| `make clean-data-test` | Test mode data only (`data-test/`) |
| `make clean-all` | Everything above combined |

**Step 2: Reset the config server**
```bash
curl -X DELETE http://localhost:3904/api/config
```

**Step 3: Reset KERI agent state (optional — only if agent is corrupted)**

KERI agent state lives inside the KERIA Docker container. Recreating it wipes all agents, AIDs, and credentials:
```bash
cd ../matou-infrastructure/keri
make down
make start-and-wait
```

This is the nuclear option — you'll need to create a new admin identity from scratch since all key event logs are lost.

**Step 4: Reset any-sync network data (optional — only if trees are corrupted)**
```bash
cd ../matou-infrastructure/any-sync
make down
make start-and-wait
```

This wipes all spaces, channels, messages, and sync state. Combined with step 3, this is a complete infrastructure reset.

**Step 5: Clear browser storage**

Open each browser tab that was used for dev sessions and run in the console:
```javascript
localStorage.clear();
```

Or use DevTools → Application → Local Storage → Clear All.

**Step 6: Restart sessions and set up from scratch**
```bash
npm run dev:sessions:2
```

Open http://localhost:5100 and go through the org setup flow again. The app will detect no org config and redirect to the setup page.

#### Partial Reset (Keep KERI, Reset App Data)

If KERI agents are healthy but app data is stale (e.g. after changing code that affects data formats):

```bash
# Stop sessions
npm run dev:sessions:stop

# Wipe all session data
cd backend && make clean-data

# Clear config server
curl -X DELETE http://localhost:3904/api/config

# Restart
cd ../frontend && npm run dev:sessions:2
```

The existing KERI agent will be reused when you go through org setup again (the agent is identified by the passcode derived from mnemonic). The backend will re-derive peer keys and space keys from the mnemonic during identity setup.

#### Mismatch Troubleshooting

**"Not connected to KERIA" after restart** — The frontend has a stale `matou_passcode` in localStorage that doesn't match any KERI agent. Clear localStorage and log in again via mnemonic recovery.

**Backend says "configured" but frontend shows splash screen** — The frontend's cached `matou_org_config` in localStorage is stale or missing. Clear localStorage; the boot sequence will re-fetch from the backend.

**"community space not configured" errors from API** — The backend identity is set but community spaces haven't been created yet. This happens after a partial reset. Complete the org setup flow in the frontend, which creates community spaces via `POST /api/v1/spaces/community`.

**Two sessions have different org configs** — Each session backend reads its own `org-config.yaml`. If you ran org setup only in session 1, session 2 won't have it. The config server (port 3904) is the shared source of truth — run org setup through the frontend so it publishes to the config server, then restart session 2's backend to pick it up.

**"identity.json: permission denied"** — The data directory was created by a different user or process. Fix with `chmod -R u+rw backend/data/` or delete and recreate.

### Dev Environment Troubleshooting

**"Backend session N failed to start"** — Check the log file at `/tmp/matou-dev/backend-N.log`. Common causes:
- Port conflict: another process is using port 4000+N. Run `npm run dev:sessions:stop` to clean up orphans.
- Missing Go dependencies: run `cd backend && go mod download` first.
- KERI/any-sync network not running: the backend will log connection errors on startup.

**Frontend compiles but shows blank page** — Check that the backend is healthy (`curl http://localhost:4000/health`). The frontend boot sequence fetches org config from the backend; if the backend is unreachable, the app may hang on the splash screen.

**Sessions won't stop cleanly** — The stop command kills by PID and also sweeps ports 4000-4009 and 5100-5109. If processes linger:
```bash
npm run dev:sessions:stop
# If that doesn't work, kill by port:
lsof -ti:4000 | xargs kill -9
lsof -ti:5100 | xargs kill -9
```

---

## E2E Test Environment

### Overview

The E2E test environment uses **separate port ranges** from the dev environment so both can run simultaneously. Tests use Playwright with a real browser against the full stack.

### Architecture

The E2E test environment consists of four services that must be running simultaneously:

```
 KERI Test Network (Docker)         AnySync Test Network (Docker)
 +--------------------------+       +----------------------------+
 | KERIA      :4901-4903    |       | Coordinator    :9104       |
 | Witnesses  :5642-5647    |       | Sync Nodes     :9181       |
 | Config Server  :4904     |       | MongoDB, Redis             |
 | Schema Server  :8723     |       +----------------------------+
 +--------------------------+
            |                                   |
            v                                   v
     +----------------------------------------------+
     | Backend (Go)         :9080                    |
     | MATOU_ENV=test go run ./cmd/server            |
     +----------------------------------------------+
            |
            v
     +----------------------------------------------+
     | Frontend Dev Server   :9003                   |
     | npm run test:serve                            |
     +----------------------------------------------+
            |
            v
     +----------------------------------------------+
     | Playwright (Chromium)                         |
     | npx playwright test --project=<name>          |
     +----------------------------------------------+
```

### Prerequisites

Same as the dev environment (see above), plus:
- **Playwright** browsers: `cd frontend && npx playwright install chromium`
- `MATOU_KERI_INFRA_DIR` can be set to override the infrastructure directory path

### Step-by-Step Setup

#### 1. Start the KERI Test Network

```bash
cd ../matou-infrastructure/keri
make start-and-wait-test
```

This starts KERIA (identity agent), witness nodes, config server, and schema server using test-network port offsets (+1000). Wait until the command reports all services are healthy.

**Verify:**
```bash
make ready-test    # Should print "ready"
curl http://localhost:4904/api/health  # Config server health check
```

#### 2. Start the AnySync Test Network

```bash
cd ../matou-infrastructure/any-sync
make start-and-wait-test
```

This starts the any-sync coordinator, sync nodes, MongoDB, and Redis containers needed for P2P CRDT synchronization.

**Verify:**
```bash
curl http://127.0.0.1:9104/  # Coordinator metrics endpoint
```

#### 3. Start the Backend

```bash
cd backend
make run-test
```

This runs `MATOU_ENV=test MATOU_SMTP_PORT=3525 go run ./cmd/server` which:
- Loads test configuration
- Connects to the KERI and any-sync test networks
- Listens on port **9080**

**Important:** The backend must be started from the `backend/` directory. Running `go run ./cmd/server` from the project root will fail because the Go module and `cmd/server` package are relative to `backend/`.

**Verify:**
```bash
curl http://localhost:9080/health
curl http://localhost:9080/api/v1/identity
```

#### 4. Start the Frontend Test Server

```bash
cd frontend
npm run test:serve
```

This starts a Quasar dev server on port **9003** (separate from the regular dev server on 9002) with test environment variables:
- `VITE_ENV=test`
- `VITE_TEST_CONFIG_URL=http://localhost:4904`
- `VITE_BACKEND_URL=http://localhost:9080`

**Note:** The Playwright config has `reuseExistingServer: true`, so if the test server is already running, Playwright will use it. If not running, Playwright will auto-start it via the `webServer` config, but manual startup is recommended for faster iteration.

#### 5. Install Playwright Browsers (first time only)

```bash
cd frontend
npx playwright install chromium
```

## Running Tests

### Test Projects

Tests are organized as Playwright projects that must be run in order:

| Project | Command | Description | Depends On |
|---------|---------|-------------|------------|
| `org-setup` | `npx playwright test --project=org-setup` | Creates admin account, organization, and spaces | All infrastructure |
| `registration` | `npx playwright test --project=registration` | User registration flow | `org-setup` |
| `chat` | `npx playwright test --project=chat` | Chat: create/edit channels, send messages | `org-setup` |
| `account-recovery` | `npx playwright test --project=account-recovery` | Mnemonic recovery flow | `org-setup` |

### First Run: Organization Setup

Before any other tests, run `org-setup` once. This:
1. Creates the admin identity via KERIA (AID creation with witness-backed key events)
2. Configures the organization on the config server
3. Creates community and admin spaces in any-sync
4. Saves admin credentials to `tests/e2e/test-accounts.json`

```bash
cd frontend
npx playwright test --project=org-setup
```

The `test-accounts.json` file is reused by subsequent test projects. You only need to re-run `org-setup` if you reset the KERI network or clear the backend data.

### Running a Specific Test Project

```bash
cd frontend

# Run a single project
npx playwright test --project=registration

# Run multiple projects in sequence
npx playwright test --project=org-setup --project=chat
```

Each project uses real KERI identity operations and any-sync P2P writes, so tests interact with the full infrastructure stack.

### Debugging Options

```bash
# Run with visible browser (default in our config)
npx playwright test --project=registration --headed

# Run with Playwright Inspector for step-through debugging
npx playwright test --project=registration --debug

# View last test report
npx playwright show-report
```

Test artifacts (screenshots, traces, videos) are saved to `frontend/tests/e2e/results/`.

## Common Issues and Troubleshooting

### "org-setup must be run first: test-accounts.json not found"

Tests that depend on an existing admin account require `test-accounts.json` to be present. This file is created by the `org-setup` project.

**Fix:** Run `npx playwright test --project=org-setup` first.

### Backend Fails to Start ("port already in use" or wrong directory)

The backend must be started from the `backend/` directory:

```bash
# WRONG - will fail, ./cmd/server doesn't exist at project root
go run ./cmd/server

# CORRECT
cd backend && make run-test
```

If port 9080 is already in use from a previous run:
```bash
lsof -ti:9080 | xargs kill -9
```

### Edits Not Reflected in List Endpoints (Any-Sync Object Versioning)

**Symptom:** After editing an object (e.g. channel name, profile), the list endpoint still returns the old data.

**Root cause:** `ReadObjectsByType` returns all versions of each object. List handlers must deduplicate by keeping the **latest version** (highest `obj.Version`), not the first-seen:

```go
// CORRECT: keep latest version
latestByID := make(map[string]*entry)
for _, obj := range objects {
    if existing, ok := latestByID[obj.ID]; !ok || obj.Version > existing.obj.Version {
        latestByID[obj.ID] = &entry{obj: obj, data: data}
    }
}
```

Single-object reads (`ReadLatestByID`) already return the latest version and are unaffected.

### Admin-Only UI Elements Not Visible

**Symptom:** Admin users don't see admin-only buttons or actions.

**Root cause:** Components that use `useAdminAccess().isSteward` must call `checkAdminStatus()` during `onMounted`. Without this call, the reactive state is never populated and stays `false`. Additionally, if the admin check falls through to Method 2 (org config lookup), ensure it sets `adminCredential` with a `role` value so the `isSteward` computed property resolves correctly.

### Strict Mode Violations in Playwright (Multiple Elements Match)

**Symptom:** `page.getByRole('button', { name: /some text/i })` fails with "strict mode violation" because it matches multiple elements (e.g. a sidebar button and a modal button with the same label).

**Fix:** Use more specific selectors that scope to a particular container:

```typescript
// WRONG - matches multiple buttons with same text
await page.getByRole('button', { name: /create/i }).click();

// CORRECT - scoped to specific container
await page.locator('.modal-content .btn-primary').click();
```

### KERI Connection Errors in Console

Lines like `PUT http://localhost:4901/agent/...?type=ixn` appear as failed requests in test output. These are typically non-fatal KERI agent interaction events (key event log updates) that fail during test execution but don't block the test flow. The KERI client retries these operations internally.

### Tests Timeout During Identity Recovery

KERI operations (AID creation, witness OOBI resolution, credential checks) can take 10-30 seconds each. The Playwright config sets a global timeout of 120 seconds. Individual wait assertions use:
- 10s for quick UI operations
- 15s for channel/message sync
- 30s for KERI credential operations
- 90s for full AID creation with witnesses

If tests timeout, check that all 6 witness nodes are responsive:
```bash
for port in 5642 5643 5644 5645 5646 5647; do
  curl -s -o /dev/null -w "witness :$port -> %{http_code}\n" http://localhost:$port/
done
```

### Stale test-accounts.json After Network Reset

If you tear down and recreate the KERI or any-sync networks, the admin AID in `test-accounts.json` becomes invalid (the KERIA agent no longer has the key state). Delete the file and re-run org-setup:

```bash
rm frontend/tests/e2e/test-accounts.json
cd frontend && npx playwright test --project=org-setup
```

## Port Reference

### Dev Environment

| Service | Port | Notes |
|---------|------|-------|
| Frontend (session 1-3) | 5100-5102 | Via `dev:sessions` script |
| Backend (session 1-3) | 4000-4002 | Via `dev:sessions` script |
| Backend (standalone) | 8080 | Default `go run ./cmd/server` |
| KERIA Admin API | 3901 | Dev network |
| KERIA CESR/OOBI | 3902 | Dev network |
| KERIA Boot | 3903 | Dev network |
| Config Server | 3904 | Dev network |
| Schema Server | 7723 | Dev network |
| Witnesses | 5642-5647 | Shared between dev and test |

### Test Environment

| Service | Port | Notes |
|---------|------|-------|
| Frontend test server | 9003 | `npm run test:serve` |
| Backend (test mode) | 9080 | `MATOU_ENV=test` |
| KERIA Admin API | 4901 | Test network (+1000 offset from dev) |
| KERIA CESR/OOBI | 4902 | Test network |
| KERIA Boot | 4903 | Test network |
| Config Server | 4904 | Test network |
| Schema Server | 8723 | Test network |
| Witnesses | 5642-5647 | Shared between dev and test |
| AnySync Coordinator | 9104 | Test network |
| AnySync Node 1 | 9181 | Test network |
