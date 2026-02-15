# Troubleshooting Guide

Common issues encountered when developing and testing the Matou app.

## OOBI resolution failures (Docker hostname mapping)

**Notes:**
Check if this error is still happening across different environments

**Symptoms:**
- Registration submission hangs at "Submitting Registration..."
- KERIA fails to resolve OOBIs — timeout after 30s+
- Browser can reach KERIA but KERIA can't resolve OOBIs internally
- Console logs show: `Failed to resolve witness OOBI` or OOBI resolution timeout

**Root cause:**
KERIA runs inside Docker and advertises `http://keria:3902/` as its internal location. The browser accesses KERIA via `localhost:4902` (test) or `localhost:3902` (dev). When sending OOBIs to KERIA for resolution, localhost URLs must be converted back to Docker-internal hostnames — KERIA can't reach `localhost` from inside a container.

**Diagnosis:**
```bash
# Check if KERIA is reachable from host
curl http://localhost:4902/oobi

# Check KERIA's self-reported location (will show keria:3902)
curl http://localhost:4902/oobi/{AID} | jq .

# Verify Docker networking
docker exec -it keria curl http://keria:3902/
```

**Fix:**
`KERIClient.toInternalOobiUrl()` converts `localhost:{port}` URLs to `keria:3902` before sending to KERIA for resolution. This only applies when `cesrUrl` contains `localhost` (skipped in production where KERIA uses a real hostname).

Key code in `frontend/src/lib/keri/client.ts`:
```typescript
private readonly dockerCesrUrl = 'http://keria:3902';

private toInternalOobiUrl(oobi: string): string {
  if (this.dockerCesrUrl && this.cesrUrl && this.cesrUrl.includes('localhost')) {
    return oobi.replace(this.cesrUrl, this.dockerCesrUrl);
  }
  return oobi;
}
```

---

## Stale backend binary causing 404s

**Symptoms:**
- E2E tests get 404 from API endpoints that definitely exist in the code
- Endpoints work with `go run` but not when tests run automatically
- BackendManager logs show `(binary)` not `(go run)`

**Root cause:**
`BackendManager` prefers the pre-built binary at `backend/bin/server` over `go run`. When source code changes but the binary isn't rebuilt, tests run stale code.

**Diagnosis:**
```bash
# Check binary age vs source code
ls -la backend/bin/server
git log --oneline -1 -- backend/

# BackendManager selection logic (backend-manager.ts):
# If bin/server exists → uses binary
# If not → falls back to `go run ./cmd/server`
```

**Fix:**
Always rebuild after backend code changes:
```bash
cd backend && go build -o bin/server ./cmd/server
```

Or delete the binary to force `go run`:
```bash
rm backend/bin/server
```

---

## Port 9080 already in use

**Symptoms:**
- Backend fails to start: `listen tcp :9080: bind: address already in use`

**Root cause:**
A previous backend process is still running on port 9080.

**Fix:**
```bash
lsof -ti :9080 | xargs kill
```

---

## Test SMTP port configuration

**Symptoms:**
- Email sending fails in E2E tests with connection refused
- Works in dev but not in test mode

**Root cause:**
The test Postfix relay container runs on port 3525, not the default 2525.

**Fix:**
Ensure `MATOU_SMTP_PORT=3525` is set when running the backend in test mode. The BackendManager and Makefile `run-test` target both set this automatically.

