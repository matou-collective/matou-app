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

---

## macOS desktop signing fails on CI (`SecKeychainUnlock`)

**Symptoms:**
- The `Matou App Build` workflow (`build.yml`, `v*` tags) fails the mac-arm64 /
  mac-x64 desktop jobs during electron-builder's certificate import:
  ```
  Error: /usr/bin/security process failed 1
  /usr/bin/security set-key-partition-list -S apple-tool:,apple: -s -k *** <tmp>.keychain
  security: SecKeychainUnlock: The user name or passphrase you entered is not correct.
  ```
- Started when `macos-latest` began resolving to macOS 26 runners.

**Root cause:**
electron-builder 26.x (`app-builder-lib` `macCodeSign.js`) creates a temp
keychain with a random password but then runs
`security set-key-partition-list ... -k <password>` using the **.p12** password
(`CSC_KEY_PASSWORD`) in place of the **keychain** password. That only works when
macOS doesn't enforce the keychain password; macOS 26 enforces it, so the
import fails.

**Fix:**
We manage the signing keychain ourselves in
`.github/actions/build-desktop/action.yml` ("Set up macOS signing"), the same
way the iOS job does: create a throwaway keychain with a known password, import
the Developer ID `.p12`, run `set-key-partition-list` with the *keychain*
password, then hand electron-builder `CSC_KEYCHAIN` + `CSC_NAME` and clear
`CSC_LINK`/`CSC_KEY_PASSWORD` so it never runs its own import. The keychain is
deleted in an `if: always()` teardown step. See #811.

