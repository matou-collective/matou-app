# Any-Sync Troubleshooting Guide

## Architecture Overview

```
Config Server (:3904)          any-sync network
  /api/client-config     ┌─────────────────────────┐
        │                │  tree-1  (:1001)         │
        ▼                │  tree-2  (:1002)         │
  client-dev.yml ──────► │  tree-3  (:1003)         │
    networkId            │  coordinator (:1004)     │
    peerIds              │  filenode (:1005)        │
    addresses            │  consensus (:1006)       │
        │                └─────────────────────────┘
        ▼                          ▲
  Go Backend (SDKClient)           │
    peer.key ──── dRPC connections─┘
```

The backend connects to 6 any-sync nodes using a `client.yml` config file. The config contains the **network ID**, **peer IDs**, and **addresses** of all nodes. If any of these are wrong, nothing works.

---

## Quick Health Check

```bash
# 1. Is the backend running and connected?
curl -s http://localhost:8080/health | jq .

# 2. What network ID is the backend using?
#    (printed at startup in backend logs)
#    Look for: "Network ID: N7qz1p..."

# 3. What network ID is the config server serving?
curl -s http://localhost:3904/api/client-config | jq '.anysync.networkId'

# 4. What's in the backend config file?
grep networkId backend/config/client-dev.yml

# 5. What's in the infrastructure source of truth?
grep networkId ../matou-infrastructure/any-sync/etc/client.yml

# 6. Run the full debug script
./scripts/debug-anysync.sh dev
```

All four network IDs (steps 3-5, plus backend startup log) must match exactly.

---

## Connection Flow & What Can Go Wrong

### Step 1: Config File Resolution

The backend selects a config file based on `MATOU_ENV`:

| MATOU_ENV     | Config file                       | Fallback config server |
|---------------|-----------------------------------|------------------------|
| (unset)       | `config/client-dev.yml`           | `localhost:3904`       |
| `test`        | `config/client-test.yml`          | `localhost:4904`       |
| `production`  | `config/client-production.yml`    | (none, fatal error)    |

Override with: `MATOU_ANYSYNC_CONFIG=/path/to/client.yml`

If the config file doesn't exist, the backend fetches it from the config server automatically and saves it to disk.

**Failure: "Failed to fetch any-sync config from config server"**
- Config server not running
- Wrong config server URL
- Fix: Start config server, or manually copy `../matou-infrastructure/any-sync/etc/client.yml` to `backend/config/client-dev.yml`

**Failure: Config file exists but is stale**
- The any-sync network was regenerated (`make clean && make up`), which creates new network IDs and peer IDs
- The config file on disk still has old values
- Fix: Delete the config file and restart the backend (it will re-fetch), or manually copy the new one

### Step 2: Peer Key Initialization

The backend generates or loads an Ed25519 keypair from `{dataDir}/peer.key`. This is the backend's identity on the network.

If a user identity has been set (via `/api/v1/identity/set`), the peer key is derived from their BIP39 mnemonic instead.

**Failure: "creating peer key manager"**
- Can't write to data directory
- Corrupt `peer.key` file
- Fix: Check permissions on `./data/` directory, delete corrupt `peer.key`

### Step 3: SDK Initialization

The SDK boots ~20 components in dependency order: crypto, transports, connection pool, coordinator client, consensus client, space service.

**Failure: "starting app" / timeout during startup**
- A component failed to connect (usually coordinator)
- Port blocked by firewall
- Fix: Verify all 6 ports are reachable (see TCP check below)

### Step 4: Coordinator Ping

After SDK init, the backend calls `Ping()` which sends a `StatusCheck` to the coordinator.

**Failure: "Cannot connect to any-sync network"**
- Coordinator address in config doesn't match running coordinator
- Coordinator not running
- Network ID mismatch (coordinator rejects connections from wrong network)
- Fix: See "Network ID Mismatch" section below

---

## Common Problems

### Network ID Mismatch

**Symptom:** Backend fails to connect, or gets "forbidden" errors from consensus node.

**Cause:** The any-sync network was regenerated (new IDs), but the backend config file still has old values.

**Diagnosis:**
```bash
# Compare all three sources
echo "Backend config:"
grep networkId backend/config/client-dev.yml

echo "Config server:"
curl -s http://localhost:3904/api/client-config | jq -r '.anysync.networkId'

echo "Infrastructure:"
grep networkId ../matou-infrastructure/any-sync/etc/client.yml
```

**Fix:**
```bash
# Option A: Delete and let backend re-fetch
rm backend/config/client-dev.yml
# Then restart backend

# Option B: Copy from infrastructure (update addresses to localhost)
cp ../matou-infrastructure/any-sync/etc/client.yml backend/config/client-dev.yml
# Edit addresses: change container hostnames to localhost
```

### Peer ID Mismatch

**Symptom:** Same as network ID mismatch. Network was regenerated, peer IDs changed.

**Diagnosis:**
```bash
diff <(grep peerId backend/config/client-dev.yml | sort) \
     <(grep peerId ../matou-infrastructure/any-sync/etc/client.yml | sort)
```

**Fix:** Same as network ID mismatch fix.

### Nodes Not Running

**Symptom:** Timeout during SDK init or "coordinator unreachable".

**Diagnosis:**
```bash
# Check TCP connectivity to all nodes
for port in 1001 1002 1003 1004 1005 1006; do
  timeout 2 bash -c "echo > /dev/tcp/localhost/$port" 2>/dev/null \
    && echo "Port $port: OK" \
    || echo "Port $port: UNREACHABLE"
done

# Check Docker containers
cd ../matou-infrastructure/any-sync && docker compose ps
```

**Fix:**
```bash
cd ../matou-infrastructure/any-sync && make up
```

### "Forbidden" from Consensus Node

**Symptom:** Space creation succeeds on coordinator, but ACL operations (invite/join) fail with "forbidden".

**Causes:**
1. Network ID mismatch (see above)
2. Space not marked as shareable (must call `MakeSpaceShareable` before invites)
3. Different backend instance with a different peer key trying to write to a space it doesn't own

**Diagnosis:**
```bash
# Check consensus node logs
cd ../matou-infrastructure/any-sync
docker compose logs any-sync-consensusnode --tail=50 | grep -i "error\|forbidden\|denied"
```

### Space Creation Fails

**Symptom:** `POST /api/v1/spaces/private` or `/spaces/community` returns error.

**Possible causes & fixes:**

| Error | Cause | Fix |
|-------|-------|-----|
| "client not initialized" | SDK didn't start | Check backend startup logs |
| "coordinator not found in client config" | Malformed client.yml | Verify config has a node with `types: [coordinator]` |
| "creating space" | Coordinator rejected space | Check coordinator logs |
| "identity must be configured" | No identity set | Call `POST /api/v1/identity/set` first |
| "invalid mnemonic" | Bad BIP39 mnemonic | Verify 24-word mnemonic is correct |
| "failed to persist space keys" | Disk write error | Check disk space and permissions on data dir |

### Invite/Join Fails with "No Such Invite"

**Symptom:** `JoinWithInvite` returns "no such invite" error.

**Cause:** The invite record hasn't propagated yet. Flow:
```
Creator creates invite
  → consensus node accepts it
    → tree nodes receive it via sync
      → joiner's HeadSync pulls from tree nodes
        → joiner's local ACL state updated
          → NOW join can find the invite
```

This typically takes 1-6 seconds.

**Fix:** The API already retries with backoff. If it persistently fails:
1. Check consensus node is healthy
2. Check tree nodes are healthy
3. Verify the invite key matches (base64-encoded Ed25519 private key)

### Objects Not Syncing Between Clients

**Symptom:** Client A creates a credential, Client B can't see it.

**Cause:** HeadSync hasn't propagated the ObjectTree yet.

**Diagnosis:**
```bash
# Check tree node logs for sync activity
cd ../matou-infrastructure/any-sync
docker compose logs any-sync-node-1 --tail=30
```

**Fix:**
- Wait longer (HeadSync runs every ~5 seconds)
- Restart the backend to force reconnection
- Check that both clients have the same space ID

---

## Nuclear Option: Full Reset

When nothing else works, reset everything and start fresh:

```bash
# 1. Stop backend
# 2. Reset any-sync infrastructure
cd ../matou-infrastructure/any-sync
make clean    # Destroys all data, generates new network
make up       # Start fresh network

# 3. Delete backend data and stale config
rm -rf backend/data/*
rm -f backend/config/client-dev.yml

# 4. Restart backend (will auto-fetch new config)
cd backend && go run ./cmd/server

# 5. Re-run org setup from frontend
```

For test environment, use `make clean-test && make up-test` and `rm -rf backend/data-test/*`.

---

## Environment Variables Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `MATOU_ENV` | (unset = dev) | `test` or `production` |
| `MATOU_DATA_DIR` | `./data` | Backend data directory |
| `MATOU_ANYSYNC_CONFIG` | auto-selected | Override config file path |
| `MATOU_CONFIG_SERVER_URL` | `localhost:3904` | Config server URL for auto-fetch |
| `MATOU_SERVER_PORT` | `8080` | Backend HTTP port |
| `MATOU_SMTP_HOST` | `localhost` | SMTP relay host |
| `MATOU_SMTP_PORT` | `2525` | SMTP relay port |

## Key Files

| File | Purpose |
|------|---------|
| `backend/config/client-dev.yml` | Network topology for dev (networkId, peerIds, addresses) |
| `backend/config/client-test.yml` | Network topology for test |
| `backend/config/client-production.yml` | Network topology for production |
| `backend/data/peer.key` | Backend's Ed25519 peer identity |
| `backend/data/spaces/{spaceID}/data.db` | Space's local ObjectTree storage (SQLite) |
| `backend/data/keys/{spaceID}.keys` | Space's cryptographic keys (signing, read, master, metadata) |
| `../matou-infrastructure/any-sync/etc/client.yml` | Infrastructure source of truth for dev network |
| `../matou-infrastructure/any-sync/etc-test/client.yml` | Infrastructure source of truth for test network |
| `scripts/debug-anysync.sh` | Automated debug script |
