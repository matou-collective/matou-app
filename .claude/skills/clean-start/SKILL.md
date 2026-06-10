---
name: clean-start
description: Clean data, generate configs, and start services for Matou dev/test environments. Knows all infrastructure commands, environment differences, and common gotchas.
argument-hint: "[environment] [scope]  e.g. 'dev all', 'test keri', 'dev frontend'"
allowed-tools: Bash, Read, Grep, Glob
---

# Clean-Start: Matou Infrastructure Management

You are an infrastructure expert for the Matou project. When invoked, determine what the user needs based on their arguments and execute the appropriate commands. Always confirm the target environment (dev or test) if ambiguous.

## Arguments

Parse `$ARGUMENTS` to determine:
- **Environment**: `dev` (default) or `test`
- **Scope**: `all` (default), `app`, `infra` (keri+any-sync), `frontend`, `backend`, `keri`, `any-sync`
- **Action**: `clean` (default), `start`, `restart`, `health`, `status`

Scope definitions:
- `all` = app + infra (cleans/starts everything)
- `app` = frontend + backend only (scripts/clean.sh, dev sessions)
- `infra` = keri + any-sync only (Docker infrastructure)
- `frontend`, `backend`, `keri`, `any-sync` = individual components

Examples: `/clean-start`, `/clean-start test`, `/clean-start dev app`, `/clean-start dev infra`, `/clean-start dev keri start`, `/clean-start health`, `/clean-start test all restart`

## Directory Layout

```
matou-app/                    # Main project root
  backend/                    # Go API server
  frontend/                   # Quasar/Vue frontend
  scripts/
    clean.sh                  # Dev data clean (auto-stops dev sessions)
    clean-test.sh             # Test data + artifact clean (kills stale test backend)
    dev-sessions.sh           # Multi-backend dev session manager

matou-infrastructure/         # Sibling directory (../matou-infrastructure from matou-app)
  keri/                       # KERI Docker infrastructure
    Makefile                  # up/down/health/clean + -test variants
  any-sync/                   # any-sync Docker infrastructure
    Makefile                  # up/down/health/clean/generate-config + -test variants
  keria-patches/              # KERIA patches (used during keri build)
```

## Environment Matrix

| Component       | Dev                          | Test                          |
|-----------------|------------------------------|-------------------------------|
| Backend port    | 8080                         | 9080 (MATOU_ENV=test)         |
| Frontend port   | 9000                         | 9003                          |
| Dev sessions    | 4000/5100, 4001/5101, ...    | N/A (test uses 9080 directly) |
| KERI ports      | 3901-3904, 5642-5647, 7723   | 4901-4904, 6642-6647, 8723    |
| any-sync ports  | 1001-1006                    | 2001-2006                     |
| KERI Makefile   | `make up` / `make health`    | `make up-test` / `make health-test` |
| any-sync Make   | `make up` / `make health`    | `make up-test` / `make health-test` |
| any-sync env    | `.env` / `etc/`              | `.env.test` / `etc-test/`     |
| any-sync config | `etc/client.yml`             | `etc-test/client.yml`         |
| Backend config  | config server (dynamic)      | config server (dynamic)       |

## Commands Reference

### Frontend + Backend (matou-app)

```bash
# Clean dev data (auto-stops dev sessions)
./scripts/clean.sh              # Dev runtime data + browser storage
./scripts/clean.sh --dry        # Preview what would be removed

# Clean test data + artifacts
./scripts/clean-test.sh         # Test data, playwright reports, coverage
./scripts/clean-test.sh --dry   # Preview what would be removed

# Dev sessions (from frontend/)
npm run dev:sessions            # 1 session (port 4000/5100)
npm run dev:sessions:3          # 3 sessions (ports 4000-4002/5100-5102)
npm run dev:sessions:stop       # Stop all sessions
npm run dev:sessions:status     # Show running sessions

# Backend standalone
cd backend && make build        # Build binary
cd backend && make run          # Build + run (dev)
cd backend && make run-test     # Run in test mode (port 9080)
cd backend && make clean        # Remove binaries + test cache

# Frontend standalone
cd frontend && npm run dev      # Quasar dev server (port 9000)
cd frontend && npm run test:serve  # Test frontend (port 9003)

# Health checks
cd frontend && npm run health       # Check dev services
cd frontend && npm run health:test  # Check test services
```

### KERI Infrastructure (matou-infrastructure/keri)

```bash
# Dev
make up                  # Build patched KERIA + start containers
make down                # Stop containers
make health              # Health check all services
make clean               # Stop + remove containers AND volumes
make restart             # down + up
make logs                # Tail logs

# Test (ports +1000)
make up-test             # Start test network
make down-test
make health-test
make clean-test          # IMPORTANT: clears KERIA notifications + agent state
make restart-test
```

### any-sync Infrastructure (matou-infrastructure/any-sync)

```bash
# Dev
make generate-config     # Generate network config (first time only)
make setup               # generate-config + start + wait (first time)
make up                  # Start services (requires config)
make down
make health
make clean               # Stop + remove containers
make clean-config        # Remove generated configs (etc/, storage/)
make clean-all           # clean + clean-config + clean-docker

# Test
make generate-config-test  # Generate test network config
make setup-test            # generate-config-test + start + wait + auto-copy config to etc/ (Fixes 1+2)
make up-test               # Start test services (auto-copies client-test.yml to etc/ in test mode)
make down-test
make health-test
make clean-test            # Stop + remove test containers
```

## Standard Procedures

### Scope: `all` — Full Clean Start (dev)
Includes BOTH app and infra. This is the default scope.

CRITICAL: Always stop dev sessions FIRST, before touching infra. Backends hold
persistent connections to any-sync. If infra is cleaned/regenerated while backends
are still running, they keep stale connections to the old network and all space
operations fail with "unable to connect".

```bash
# 1. Stop dev sessions explicitly (backends must die before infra changes)
cd matou-app/frontend && npm run dev:sessions:stop

# 1b. Force-kill any orphaned processes on dev session ports
#     dev:sessions:stop may miss processes not started by the script
for port in 4000 4001 4002 5100 5101 5102; do
  lsof -ti :$port 2>/dev/null | xargs -r kill -9 2>/dev/null
done

# 2. Clean app data
cd matou-app && ./scripts/clean.sh

# 3. Clean infrastructure
cd matou-infrastructure/keri && make clean
cd matou-infrastructure/any-sync && make clean

# 4. Start infrastructure
#    IMPORTANT: any-sync `make clean` deletes etc/ and storage/, so config is gone.
#    Must use `make setup` (generate-config + start + wait) instead of `make up`.
cd matou-infrastructure/keri && make up           # builds + starts
cd matou-infrastructure/any-sync && make setup    # regenerates config + starts

# 5. Wait for health
cd matou-infrastructure/keri && make health
cd matou-infrastructure/any-sync && make health

# 6. Start dev sessions (fresh backends connect to new network)
cd matou-app/frontend && npm run dev:sessions:3
```

### Scope: `all` — Full Clean Start (test)

Test environment uses separate ports from dev (9080 vs 4000-4002, 4901-4904 vs 3901-3904,
2001-2006 vs 1001-1006). Do NOT stop or start dev sessions — they are independent.

```bash
# 1. Clean test data (kills stale test backend on port 9080 automatically)
cd matou-app && ./scripts/clean-test.sh

# 2. Clean test infrastructure
cd matou-infrastructure/keri && make clean-test
cd matou-infrastructure/any-sync && make clean-test

# 3. Start test infrastructure
#    clean-test removes test config, so it must be regenerated. With the any-sync
#    Makefile fixes in place, `make setup-test` does this correctly on its own:
#    it runs generate-config-test (Fix 2) and auto-copies the client config into
#    etc/ for the config server mount (Fix 1). No manual generate/copy needed.
cd matou-infrastructure/keri && make up-test
cd matou-infrastructure/any-sync && make setup-test

# 4. Verify NetworkId is consistent across all three sources (drift check — gotcha #2).
#    All three MUST match. If etc/ is stale, the Makefile Fix 1 is missing from your
#    checkout — fall back to the manual copy, then restart the config server:
#      cp matou-infrastructure/any-sync/etc-test/client-test.yml matou-infrastructure/any-sync/etc/client-test.yml
cd matou-infrastructure/any-sync
grep -i networkId etc/client-test.yml etc-test/client-test.yml etc-test/any-sync-consensusnode/config.yml
cd -

# 5. Verify health
cd matou-infrastructure/keri && make health-test
cd matou-infrastructure/any-sync && make health-test

# 6. Start backend in test mode (background, logs to /tmp/matou-test-backend.log)
cd matou-app/backend && MATOU_ENV=test MATOU_SMTP_PORT=3525 go run ./cmd/server > /tmp/matou-test-backend.log 2>&1 &
# Wait and verify
sleep 5 && curl -s http://localhost:9080/health
```

### Scope: `app` — App Only (dev)
Cleans frontend/backend data and restarts dev sessions. Does NOT touch infrastructure.

```bash
cd matou-app/frontend && npm run dev:sessions:stop

# Force-kill any orphaned processes on dev session ports
for port in 4000 4001 4002 5100 5101 5102; do
  lsof -ti :$port 2>/dev/null | xargs -r kill -9 2>/dev/null
done

cd matou-app && ./scripts/clean.sh
cd matou-app/frontend && npm run dev:sessions:3
```

### Scope: `infra` — Infrastructure Only (dev)
Cleans and restarts KERI + any-sync Docker containers. Does NOT touch app data.
MUST stop and restart dev sessions — backends hold persistent connections to the
old any-sync network and will fail with "unable to connect" if not restarted.

```bash
# 1. Stop dev sessions (backends must reconnect to new network)
cd matou-app/frontend && npm run dev:sessions:stop

# 1b. Force-kill any orphaned processes on dev session ports
for port in 4000 4001 4002 5100 5101 5102; do
  lsof -ti :$port 2>/dev/null | xargs -r kill -9 2>/dev/null
done

# 2. Clean and restart infrastructure
cd matou-infrastructure/keri && make clean
cd matou-infrastructure/any-sync && make clean
cd matou-infrastructure/keri && make up
cd matou-infrastructure/any-sync && make setup    # clean deletes config, must regenerate
cd matou-infrastructure/keri && make health
cd matou-infrastructure/any-sync && make health

# 3. Restart dev sessions
cd matou-app/frontend && npm run dev:sessions:3
```

### First-Time Setup (any-sync config doesn't exist)

```bash
# Dev
cd matou-infrastructure/any-sync && make setup   # generate-config + start + wait

# Test
cd matou-infrastructure/any-sync && make setup-test
```

### Infrastructure Only Restart (keep data)

```bash
# Dev
cd matou-infrastructure/keri && make restart
cd matou-infrastructure/any-sync && make restart

# Test
cd matou-infrastructure/keri && make restart-test
cd matou-infrastructure/any-sync && make restart-test
```

## Gotchas and Troubleshooting

### 1. any-sync config not generated
**Symptom**: `make up` fails with "Network configuration not found"
**Fix**: Run `make generate-config` (dev) or `make generate-config-test` (test) first, or use `make setup` / `make setup-test` for first-time setup.

### 2. any-sync client config not in config server volume (config drift → consensus `forbidden`)
**Symptom**: Backend can't connect to any-sync / config server returns empty config. WORSE failure mode after a network regen: `etc/client-test.yml` still points at the OLD (dead) NetworkId, so the backend authenticates to the freshly-rebuilt network with dead credentials → the consensus node rejects every write with `forbidden` and `failed to push ACL to consensus node ... code: 504`. Symptoms: registration member→member sync fails, org-setup times out.
**Cause**: KERI docker-compose mounts `../any-sync/etc:/etc/anysync:ro` but the generator writes test configs to `etc-test/`. Nothing kept the two in sync, so a regenerated network left `etc/client-test.yml` stale.
**Fix**: The any-sync Makefile `start` recipe now auto-copies `etc-test/client-test.yml → etc/client-test.yml` in test mode (Fix 1), so `make up-test`/`make setup-test` keep them aligned. If your checkout predates that fix, copy manually: `cp matou-infrastructure/any-sync/etc-test/client-test.yml matou-infrastructure/any-sync/etc/client-test.yml`
**Always verify** after any network regen that the NetworkId matches across `etc/client-test.yml`, `etc-test/client-test.yml`, and `etc-test/any-sync-consensusnode/config.yml`.
**Note**: This only affects test env. Dev uses `etc/` directly which matches the mount.

### 3. Stale KERIA notifications after re-registration
**Symptom**: E2E tests see phantom registrations from previous runs, admin dashboard shows old registration cards.
**Fix**: `cd matou-infrastructure/keri && make clean-test` (wipes KERIA agent state + notifications). Must do this between full E2E test runs.

### 4. Port conflicts (dev sessions still running)
**Symptom**: New dev sessions fail because ports 4000/5100-5102 are in use.
**Fix**: `clean.sh` auto-stops dev sessions. If still stuck: `npm run dev:sessions:stop` or kill manually with `lsof -ti :5100 | xargs kill -9`.

### 5. Stale backend process on port 9080 (test)
**Symptom**: Test backend won't start, port 9080 already in use.
**Fix**: `lsof -ti :9080 | xargs kill -9`

### 6. any-sync config is dynamic (no local yml files needed)
**Important**: The config server provides any-sync config dynamically. You do NOT need `client-dev.yml` or `client-test.yml` in `backend/config/`. The backend fetches config from the config server at startup. Don't copy yml files from infrastructure after a clean.

### 7. Backend FileManager stale pool after SDK reinit
**Symptom**: File uploads fail after identity is set (during onboarding flows).
**Cause**: `SDKClient.Reinitialize()` closes the old app (killing the pool) but FileManager still held the dead pool reference.
**Status**: FIXED - `RefreshFileManager()` is called after each Reinitialize.

### 8. Tree "missing current read key" errors
**Symptom**: Writing to community spaces fails with "missing current read key" after SDK reinit.
**Cause**: Space reopened from storage after reinit, but ACL state not fully available.
**Fix**: Usually resolves after a full clean-start. If persistent, check that the peer key matches the space owner.

### 9. "tree already exists" warnings in logs
**Symptom**: Backend logs show `TreeSyncer missingWorker: FAILED to get tree ... tree already exists`.
**Status**: Harmless race condition - multiple sync workers try to build the same tree. The tree is already stored locally; the duplicate attempt is dropped.

### 10. Backends hold stale connections after infra clean
**Symptom**: `POST /api/v1/spaces/community/invite` returns 500 "failed to create invite: adding invite record: unable to connect". All space operations fail.
**Cause**: Dev session backends hold persistent connections to the any-sync network. If infra is cleaned/regenerated while backends are still running, they keep connections to the old (now dead) network. The new network has a different NetworkId, different peer keys, etc.
**Fix**: ALWAYS stop dev sessions (`npm run dev:sessions:stop`) BEFORE cleaning infra. Then restart sessions AFTER infra is healthy. This is critical for both `all` and `infra` scopes.

### 11. Orphaned processes survive dev:sessions:stop
**Symptom**: After `clean-start dev all`, one or more dev session backends show as "STOPPED (stale PID file)" but a `server` process is still listening on the port (e.g., port 4001). The frontend on the corresponding port (e.g., 5101) gets CORS errors with "Status code: (null)" because the orphaned backend can't connect to the new any-sync network.
**Cause**: `npm run dev:sessions:stop` only kills processes it started (tracked by PID file). Orphaned processes from previous runs or manual starts survive the stop command and block the port.
**Fix**: Force-kill all processes on dev session ports after stopping sessions:
```bash
for port in 4000 4001 4002 5100 5101 5102; do
  lsof -ti :$port 2>/dev/null | xargs -r kill -9 2>/dev/null
done
```
**Note**: This is now included in all dev clean-start procedures (all, app, infra scopes).

### 12. Docker volumes persist across clean
**Symptom**: After `make clean`, old data still appears.
**Cause**: `make down` doesn't remove volumes; `make clean` does (`down -v`).
**Fix**: Use `make clean` (not `make down`) when you want a fresh start.

### 13. any-sync-tools image version mismatch (`up-test` fails to pull)
**Symptom**: `make up-test` fails: `failed to resolve reference ghcr.io/anyproto/any-sync-tools:0.6.1: not found`.
**Cause**: `config.env`/`.env.test` pinned `ANY_SYNC_TOOLS_VERSION=0.6.1`, but the published image tag is `v0.6.1` (every other any-sync version uses the `v` prefix). Dev uses `latest` so it's unaffected.
**Fix**: Set `ANY_SYNC_TOOLS_VERSION=v0.6.1` in `config.env` (source) and `.env.test` (generated).

### 14. `make setup-test` generated the DEV network (historical bug — now fixed)
**Symptom**: `make setup-test` printed `Mode: dev`, found/created the dev network identity, then failed `check-config` because `storage-test/`/`etc-test/` were empty.
**Cause**: `setup-test` chained into the dev `setup` target, which runs `generate-config` in dev mode.
**Fix**: `setup-test` now depends on `generate-config-test` and runs `start wait ENV_FILE=.env.test` (Fix 2). If your checkout predates the fix, run `make generate-config-test` then `make up-test` manually.

### 15. E2E consensus `forbidden`/504 storm = host CPU starvation, NOT a code bug
**Symptom**: During E2E, backend logs a continuous `consensus stream read error: forbidden` and `failed to push ACL to consensus node ... 504` storm (persists past onboarding, even after the test process dies). Member→member sync misses its timeout; org-setup can stall.
**Cause**: This host has **2 CPU cores**. The E2E suite (Playwright browsers + per-user `go run` backends + ~14 infra containers) drives load average to ~20+, which starves Docker's embedded DNS resolver (127.0.0.11). The any-sync **coordinator** then can't resolve `mongo-1`/`any-sync-consensusnode` (`lookup ... on 127.0.0.11:53: i/o timeout`) → ACL writes can't be validated → consensus returns `forbidden`/504. It is intermittent/load-sensitive — a single uncontended run on an aligned network passes (reached 32/32 green).
**How to tell it apart from gotcha #2 drift**: container-to-container DNS timeouts in coordinator logs = starvation; a NetworkId mismatch across the three config files = drift. Check both.
**Fix/avoid**: Before suspecting code, run `uptime` (load avg) and `nproc`. **NEVER run two E2E flows concurrently** on this host (e.g. overlapping subagents) — that's what tips it over. (Playwright already runs serially — `workers: 1`, `fullyParallel: false` — so a single invocation is fine; the danger is overlapping invocations.) Mitigations: pre-`go build` the backend binary so per-user backends skip `go run` recompiles (the biggest CPU sink); stop unneeded background Docker stacks; use a host with more cores.

### 16. Booking E2E fails: no SMTP server on port 3525
**Symptom**: `registration › user books a Whakawhānaunga session` returns 500: `booking.go: FAILED to send email ... dial tcp [::1]:3525: connect: connection refused`.
**Cause**: The clean-start backend runs with `MATOU_SMTP_PORT=3525` but nothing listens there. The booking endpoint's only job is sending the confirmation email, so the 500 is correct behavior (unlike the invitation flow, which tolerates SMTP-absent). This is a test-infra gap, not a product bug.
**Fix**: Run a mock SMTP server on 3525 for the test env (mailpit/smtp4dev, or a raw-socket SMTP sink), or relax the booking test to tolerate SMTP-absent.

## Execution

When running commands:
1. Always check health AFTER starting services - don't assume they're ready immediately
2. For KERI, `make up` includes `build` (rebuilds patched KERIA image) - this takes ~30s
3. For any-sync, `make up` requires config to exist - use `make setup` for first time
4. Run infrastructure services BEFORE dev sessions (backends need KERI + any-sync)
5. Use `2>&1` on make commands to capture both stdout and stderr
6. Report health check results to the user