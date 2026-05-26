# KERI Distributed Deployment

This document answers the practical questions for running Matou's KERI infrastructure across multiple servers — Ben and Cherese's machines, cloud VPSes, or a mix. It assumes you've already read [keri-overview.md](./keri-overview.md) and won't repeat the protocol fundamentals covered there.

---

## Can Ben and Cherese host the Matou KERI deployment?

**Yes.** KERIA is a Python web service in Docker. Witnesses are also Python services in Docker. Both are designed to be self-hosted — the WebOfTrust team publish official Docker images for both and that's exactly how production deployments are expected to work.

What you need per server:
- Docker 24+ with Compose v2
- Stable public domain name (OOBIs are URLs — if the domain changes, existing OOBIs break for all users)
- Open ports: 3901–3903 for KERIA, 5642+ per witness
- TLS termination (Traefik is already configured in `docker-compose.prod.yml` with Let's Encrypt)

The practical split for Ben + Cherese:

```mermaid
graph TD
    subgraph Cloud["☁️ Cloud VPS — always on (recommended: Cherese)"]
        KERIA["KERIA :3901–3903<br>— patched, TLS via Traefik —<br>manages all user agents<br>holds KELs + inbox"]
        SCHEMA["schema-server :7723"]
        CONFIG["config-server :3904"]
        WIT_C["Witness A<br>keripy :5642"]
        SNAP[("💾 daily snapshot<br>keria-data backup")]
        KERIA --- SNAP
    end

    subgraph Ben["🏠 Ben's server (home or VPS)"]
        WIT_B["Witness B<br>keripy :5642"]
    end

    subgraph Cherese2["🏠 Cherese's local machine (second location)"]
        WIT_Ch["Witness C<br>keripy :5642"]
    end

    USERS["Matou members<br>(app)"]
    USERS -->|"Admin API (TLS)"| KERIA
    KERIA -->|"push key events"| WIT_C
    KERIA -->|"push key events"| WIT_B
    KERIA -->|"push key events"| WIT_Ch

    style Cloud fill:#eff6ff,stroke:#3b82f6
    style Ben fill:#f0fdf4,stroke:#16a34a
    style Cherese2 fill:#fdf4ff,stroke:#a855f7
    style KERIA fill:#dbeafe,stroke:#3b82f6,color:#1e3a5f
    style SCHEMA fill:#fef3c7,stroke:#d97706,color:#78350f
    style CONFIG fill:#fef3c7,stroke:#d97706,color:#78350f
    style WIT_C fill:#d1fae5,stroke:#059669,color:#064e3b
    style WIT_B fill:#d1fae5,stroke:#059669,color:#064e3b
    style WIT_Ch fill:#d1fae5,stroke:#059669,color:#064e3b
    style SNAP fill:#ede9fe,stroke:#7c3aed,color:#3b0764
    style USERS fill:#d1fae5,stroke:#059669,color:#064e3b
```

KERIA stays on the cloud VPS because it needs to be always-on (it's the user's online mailbox and message router). Witnesses are lightweight and can run anywhere with a public IP — a home connection with a stable domain name or DDNS works fine.

---

## Understanding agents and witnesses — what they each do

Before planning deployment it's important to be clear about what KERIA and witnesses actually are, because they have completely different roles and different resilience implications.

```mermaid
graph LR
    subgraph KERIA_box["KERIA — the online agent"]
        K1["✓ online mailbox<br>receives messages when you're offline"]
        K2["✓ KEL storage<br>holds your key event log + receipts"]
        K3["✓ message routing<br>delivers EXN messages between members"]
        K4["✓ witness coordinator<br>pushes events to witnesses, collects receipts"]
        K5["✗ no private keys<br>cannot act without your signed instruction"]
    end

    subgraph Witness_box["Witnesses — the replication layer"]
        W1["✓ independent receipt servers<br>each one separately verifies + signs events"]
        W2["✓ KEL copies<br>each holds its own copy of every receipted event"]
        W3["✓ detectability<br>if keys are stolen + misused, witnesses catch the fork"]
        W4["✗ not a message router<br>witnesses don't route messages between users"]
    end

    style KERIA_box fill:#eff6ff,stroke:#3b82f6
    style Witness_box fill:#f0fdf4,stroke:#16a34a
    style K1 fill:#dbeafe,stroke:#3b82f6,color:#1e3a5f
    style K2 fill:#dbeafe,stroke:#3b82f6,color:#1e3a5f
    style K3 fill:#dbeafe,stroke:#3b82f6,color:#1e3a5f
    style K4 fill:#dbeafe,stroke:#3b82f6,color:#1e3a5f
    style K5 fill:#fca5a5,stroke:#ef4444,color:#7f1d1d
    style W1 fill:#d1fae5,stroke:#059669,color:#064e3b
    style W2 fill:#d1fae5,stroke:#059669,color:#064e3b
    style W3 fill:#d1fae5,stroke:#059669,color:#064e3b
    style W4 fill:#fca5a5,stroke:#ef4444,color:#7f1d1d
```

**The crucial difference from AnySync:** In AnySync, sync nodes replicate data _to each other_ in the background. In KERI, witnesses receive events _pushed from the controller_ at the time of signing — there is no background gossip between witnesses. Replication happens when a key event is created, not continuously.

**Your instinct was right:** KERIA is the online mailbox/inbox. It manages agents (one per user), holds KELs, and routes messages. Signing happens locally in the app via signify-ts — credentials are signed on your device and delivered to KERIA, not the other way around.

---

## How to add a device to extend resilience

"Adding a device" means deploying a new **witness** on that device. KERIA itself does not replicate across instances — resilience for the identity layer comes entirely from distributing witnesses.

### Adding a new witness

Each witness is a separate `keripy` process. Steps:

**1. Deploy the witness on the new server:**
```bash
# On the new server — create witness config
mkdir -p /opt/matou-witness/config
cat > /opt/matou-witness/config/witness.json << 'EOF'
{
    "dt": "2026-01-01T00:00:00.000000+00:00",
    "wan": {
        "dt": "2026-01-01T00:00:00.000000+00:00",
        "curls": ["http://your-server.example.com:5642/"]
    },
    "iurls": []
}
EOF

# Run the witness
docker run -d \
  --name matou-witness \
  -p 5642:5642 \
  -v /opt/matou-witness/config:/keripy/scripts/keri/cf/main \
  -v /opt/matou-witness/data:/usr/local/var/keri \
  weboftrust/keri:latest \
  witness start --name wan --loglevel INFO
```

**2. Update `keria-config.json` with the new witness OOBI:**
```json
{
    "iurls": [
        "http://cloud-witness.example.com:5642/oobi/<witnessAID>/controller",
        "http://ben-witness.example.com:5642/oobi/<witnessAID>/controller",
        "http://cherese-witness.example.com:5642/oobi/<witnessAID>/controller"
    ]
}
```

**3. Update AID creation in `frontend/src/lib/keri/client.ts`** to use the new witnesses and a higher toad:
```typescript
// Currently (dev — only 1 witness):
result = await this.client.identifiers().create(name, {
    wits: ['BBilc4-L3tFUnfM_wJr4S4OJanAv_VmF_dJNN6vkf2Ha'],
    toad: 1,
});

// Production (3 witnesses, toad=2):
result = await this.client.identifiers().create(name, {
    wits: [WITNESS_A_AID, WITNESS_B_AID, WITNESS_C_AID],
    toad: 2,  // need 2 of 3 receipts — tolerates 1 witness failure
});
```

**4. Restart KERIA** so it re-resolves the updated witness OOBIs.

> ⚠️ **Existing AIDs are not automatically migrated.** AIDs created with the old single-witness setup keep their `wits: [wan]` and `toad: 1`. New AIDs will use the updated config. To migrate existing AIDs, each user would need to rotate their keys with the new witness list — this can be done gradually.

---

## How do we know whether all agents have been successfully replicated?

In KERI "replication" means witnesses have receipted the key event. Here's how to check at each level:

### At event creation time (automatic)

The signify-ts `operations().wait()` call blocks until KERIA has confirmed that `toad` witnesses have receipted the event:

```typescript
const op = await result.op();
await client.operations().wait(op, { signal: AbortSignal.timeout(180000) });
// If this resolves without error → toad witnesses have receipted ✓
// If this times out → fewer than toad witnesses responded
```

If `wait()` times out (currently 3 minutes for witness-backed AIDs), the event either wasn't receipted by enough witnesses or KERIA couldn't reach them. Check witness health.

### Manually verifying a witness has the KEL

Query each witness's OOBI endpoint directly:
```bash
# Replace with actual witness AID and AID to check
curl http://witness-a.example.com:5642/oobi/<aidToCheck>

# A successful response includes the key state (sequence number, current keys)
# All witnesses should return the same sequence number for a fully-replicated AID
```

If all witnesses return the same `s` (sequence number), the KEL is fully replicated.

### Health check for witnesses

```bash
# Check each witness OOBI endpoint is responding
curl -f http://witness-a.example.com:5642/oobi  # HTTP 405 = healthy
curl -f http://witness-b.example.com:5642/oobi
curl -f http://witness-c.example.com:5642/oobi

# Or use the existing health check script (update with real witness URLs):
./scripts/health-check.sh
```

---

## Can we be confident there's enough resilience to go fully distributed?

**Not with the current setup.** The `witness-demo` image was not designed for production — it bundles all 6 witnesses into a single container for use in automated tests. Here's what the current and target states look like:

```mermaid
graph TD
    subgraph Current["❌ Current — zero resilience"]
        subgraph OneBox["Single server"]
            subgraph OneContainer["Single Docker container"]
                W_WAN["wan"] --- W_WIL["wil"] --- W_WES["wes"]
                W_WIT["wit"] --- W_WUB["wub"] --- W_WYZ["wyz"]
            end
            KERIA_NOW["KERIA<br>(same server)"]
        end
        NOTE1["If this server goes down:<br>KERIA offline + all 6 witnesses offline<br>No one can anchor events or receive messages"]
    end

    subgraph Target["✅ Target — genuine resilience"]
        KERIA_T["KERIA<br>cloud VPS"]
        WA_T["Witness A<br>cloud VPS"]
        WB_T["Witness B<br>Ben's server"]
        WC_T["Witness C<br>Cherese's server"]
        NOTE2["If any one server goes down:<br>KERIA or 1 witness — system keeps running<br>toad=2 of 3 means 1 witness failure is fine"]
    end

    style Current fill:#fff1f2,stroke:#ef4444
    style OneBox fill:#fca5a5,stroke:#ef4444,color:#7f1d1d
    style OneContainer fill:#fca5a5,stroke:#ef4444,color:#7f1d1d
    style KERIA_NOW fill:#fca5a5,stroke:#ef4444,color:#7f1d1d
    style W_WAN fill:#fca5a5,stroke:#ef4444,color:#7f1d1d
    style W_WIL fill:#fca5a5,stroke:#ef4444,color:#7f1d1d
    style W_WES fill:#fca5a5,stroke:#ef4444,color:#7f1d1d
    style W_WIT fill:#fca5a5,stroke:#ef4444,color:#7f1d1d
    style W_WUB fill:#fca5a5,stroke:#ef4444,color:#7f1d1d
    style W_WYZ fill:#fca5a5,stroke:#ef4444,color:#7f1d1d
    style NOTE1 fill:#fca5a5,stroke:#ef4444,color:#7f1d1d
    style Target fill:#f0fdf4,stroke:#16a34a
    style KERIA_T fill:#dbeafe,stroke:#3b82f6,color:#1e3a5f
    style WA_T fill:#d1fae5,stroke:#059669,color:#064e3b
    style WB_T fill:#d1fae5,stroke:#059669,color:#064e3b
    style WC_T fill:#d1fae5,stroke:#059669,color:#064e3b
    style NOTE2 fill:#d1fae5,stroke:#059669,color:#064e3b
```

### If one server goes down — what happens?

**One witness goes down (toad=2 of 3):**

```mermaid
graph TD
    KERIA_F["KERIA ✓"]
    WA_F["Witness A ✓"]
    WB_F["Witness B ✗ OFFLINE"]
    WC_F["Witness C ✓"]

    KERIA_F -->|"push event"| WA_F
    KERIA_F -.->|"push fails"| WB_F
    KERIA_F -->|"push event"| WC_F
    WA_F -->|"receipt 1 of 2"| KERIA_F
    WC_F -->|"receipt 2 of 2 — toad met ✅"| KERIA_F

    style KERIA_F fill:#dbeafe,stroke:#3b82f6,color:#1e3a5f
    style WA_F fill:#d1fae5,stroke:#059669,color:#064e3b
    style WB_F fill:#fca5a5,stroke:#ef4444,color:#7f1d1d
    style WC_F fill:#d1fae5,stroke:#059669,color:#064e3b
```

Users see no impact. When Witness B comes back, KERIA pushes any missed events and it catches up.

**KERIA goes down (witnesses still up):**

```mermaid
graph TD
    KERIA_D["KERIA ✗ OFFLINE"]
    WA_D["Witness A ✓<br>KEL intact"]
    WB_D["Witness B ✓<br>KEL intact"]
    WC_D["Witness C ✓<br>KEL intact"]
    USERS_D["Users<br>✗ app can't connect"]
    RESTORE["Restore KERIA from snapshot<br>~10–30 min downtime<br>identities fully safe in witnesses"]

    USERS_D -.->|"connection refused"| KERIA_D
    KERIA_D -.->|"can't reach"| WA_D
    WA_D --- WB_D --- WC_D
    KERIA_D -->|"restore"| RESTORE

    style KERIA_D fill:#fca5a5,stroke:#ef4444,color:#7f1d1d
    style USERS_D fill:#fca5a5,stroke:#ef4444,color:#7f1d1d
    style WA_D fill:#d1fae5,stroke:#059669,color:#064e3b
    style WB_D fill:#d1fae5,stroke:#059669,color:#064e3b
    style WC_D fill:#d1fae5,stroke:#059669,color:#064e3b
    style RESTORE fill:#fef3c7,stroke:#d97706,color:#78350f
```

Users can't use the app until KERIA is restored. Their identities are completely safe in witnesses. If KERIA's database is fully lost (not just restarted), users can re-initialize with their mnemonic and KERIA re-builds from the witnesses — only message history and notifications would be gone.

**Does it pull a file from somewhere else if a server goes down?**

For witnesses: yes, effectively — if you had `toad=2` and one witness goes down, the other two still hold the complete KEL and any verifier can get the key state from them. No manual action needed.

For KERIA: no automatic failover. KERIA has a single database and doesn't cluster natively. Recovery requires restoring from a snapshot (manual, ~10–30 minutes).

---

## Does running multiple sync-nodes on the same server help?

For KERI witnesses: **No.** Three witnesses on the same server have the same failure profile as one witness. If the server goes down, all three go with it. Geographic separation is what gives resilience, not process count.

For KERIA: running two KERIA instances on the same server would cause conflicts (both trying to write the same database). It doesn't make sense.

The only scenario where multiple witnesses on one server is useful is for testing or for load-testing during development — not for production resilience.

---

## Minimum 3× replication across a mix of cloud and distributed servers

3× replication in KERI means **3 witnesses that have independently receipted every key event**. For this to be meaningful, those 3 witnesses must be on genuinely independent infrastructure.

**What "independent" means:**
- Different physical machines (obviously)
- Different network providers (so one ISP outage doesn't kill multiple witnesses)
- Ideally different geographic regions

```mermaid
graph TD
    subgraph Good["✅ Genuine 3× replication"]
        GA["Witness A<br>Hetzner VPS — Frankfurt"]
        GB["Witness B<br>Ben's home — NZ Spark"]
        GC["Witness C<br>Cherese's home — NZ One NZ"]
    end

    subgraph Bad["❌ Not genuine 3× replication"]
        BA["'Witness A'<br>AWS eu-west-1"]
        BB["'Witness B'<br>AWS eu-west-1"]
        BC["'Witness C'<br>AWS eu-west-1"]
        BNOTE["All three in same AWS region<br>AWS outage = all three down simultaneously"]
    end

    style Good fill:#f0fdf4,stroke:#16a34a
    style GA fill:#d1fae5,stroke:#059669,color:#064e3b
    style GB fill:#d1fae5,stroke:#059669,color:#064e3b
    style GC fill:#d1fae5,stroke:#059669,color:#064e3b
    style Bad fill:#fff1f2,stroke:#ef4444
    style BA fill:#fca5a5,stroke:#ef4444,color:#7f1d1d
    style BB fill:#fca5a5,stroke:#ef4444,color:#7f1d1d
    style BC fill:#fca5a5,stroke:#ef4444,color:#7f1d1d
    style BNOTE fill:#fca5a5,stroke:#ef4444,color:#7f1d1d
```

**Cloud servers have built-in backup and deploy — does that change the calculation?**

Cloud providers offer automatic snapshots, health checks, and fast re-deploys. This helps **KERIA** significantly — a crashed KERIA instance can be restarted in minutes from a snapshot, and managed volumes survive server failures. This is why KERIA is best hosted on a cloud VPS.

For **witnesses**, cloud HA is less helpful. Witnesses are stateless and lightweight — they recover fast anyway. The real risk is a cloud provider outage or account issue taking down multiple witnesses if they're all on the same provider. Mix at least one home server into the witness set.

**Recommended mix for Ben + Cherese:**

| Service | Where | Why |
|---|---|---|
| KERIA | Cloud VPS (Hetzner, DO) | Needs stable uptime + daily snapshots + TLS |
| Witness A | Same cloud VPS (or second small VPS) | Always online, fast |
| Witness B | Ben's home server | Different network, different ISP |
| Witness C | Cherese's home server | Different network, different location |

---

## Recommended minimum deployments

### Option 1 — Getting started (current + hardening, ~$15/month)

Keep the existing `witness-demo` container for now. Add daily snapshots for `keria-data`. This buys you recovery from accidental deletion but not from server failure.

```mermaid
graph TD
    subgraph Server["Single server (existing setup)"]
        KERIA_S1["KERIA<br>:3901–3903"]
        WITDEMO["witness-demo container<br>6 witnesses in 1 container<br>:5642–5647"]
        SCHEMA_S1["schema-server<br>:7723"]
        CONFIG_S1["config-server<br>:3904"]
        SNAP_S1[("💾 daily snapshot<br>add this now")]
    end

    style Server fill:#eff6ff,stroke:#3b82f6
    style KERIA_S1 fill:#dbeafe,stroke:#3b82f6,color:#1e3a5f
    style WITDEMO fill:#fef3c7,stroke:#d97706,color:#78350f
    style SNAP_S1 fill:#d1fae5,stroke:#059669,color:#064e3b
```

**What you get:** Recovery from data loss in ~30 minutes. Server failure still takes everything down.

**Cost:** ~$0 additional if you already have a server. Add cloud provider snapshot billing (~$1–2/month).

**Use when:** You're not yet ready to set up distributed witnesses and can tolerate downtime.

---

### Option 2 — Recommended (1 KERIA + 3 witnesses, ~$30–50/month)

Replace `witness-demo` with 3 independent witness processes across 3 separate machines. Set `toad=2`. This is the minimum for genuine resilience.

```mermaid
graph TD
    subgraph CloudVPS["☁️ Cloud VPS (~$10–20/month)"]
        KERIA_S2["KERIA<br>:3901–3903<br>TLS via Traefik"]
        WIT_CLOUD["Witness A<br>:5642"]
        SCHEMA_S2["schema-server :7723"]
        CONFIG_S2["config-server :3904"]
        SNAP_S2[("💾 daily snapshot")]
    end

    subgraph BenS["🏠 Ben's server ($0 — existing hardware)"]
        WIT_BEN["Witness B<br>:5642"]
    end

    subgraph ChereseS["🏠 Cherese's server ($0 — existing hardware)"]
        WIT_CH["Witness C<br>:5642"]
    end

    KERIA_S2 -->|"push events<br>toad=2 of 3"| WIT_CLOUD
    KERIA_S2 -->|"push events"| WIT_BEN
    KERIA_S2 -->|"push events"| WIT_CH

    style CloudVPS fill:#eff6ff,stroke:#3b82f6
    style BenS fill:#f0fdf4,stroke:#16a34a
    style ChereseS fill:#fdf4ff,stroke:#a855f7
    style KERIA_S2 fill:#dbeafe,stroke:#3b82f6,color:#1e3a5f
    style WIT_CLOUD fill:#d1fae5,stroke:#059669,color:#064e3b
    style WIT_BEN fill:#d1fae5,stroke:#059669,color:#064e3b
    style WIT_CH fill:#d1fae5,stroke:#059669,color:#064e3b
    style SNAP_S2 fill:#ede9fe,stroke:#7c3aed,color:#3b0764
```

**What you get:**
- Any 1 witness can go offline — members keep anchoring events, no impact
- KERIA failure: ~10–30 min RTO from snapshot, identities safe in witnesses
- Ben or Cherese's home server going down: no impact to other users

**What you don't get:** Zero-downtime KERIA failover (KERIA is still a single point for app connectivity).

**Cost:** ~$10–20/month for cloud VPS + $0 for home servers.

---

### Option 3 — Robust (+ cold standby KERIA, ~$60–100/month)

Add a second cloud server as a KERIA cold standby. Kept in sync via daily volume replication. On failure, promote standby in ~5 minutes.

```mermaid
graph TD
    subgraph Primary["☁️ Primary VPS — active"]
        KERIA_P["KERIA (active)<br>:3901–3903"]
        WA_P["Witness A"]
    end

    subgraph Standby["☁️ Standby VPS — passive"]
        KERIA_SB["KERIA (standby)<br>idle — starts on failover<br>volume replicated daily"]
    end

    subgraph Homes["🏠 Home servers"]
        WB_P["Witness B<br>Ben's"]
        WC_P["Witness C<br>Cherese's"]
    end

    KERIA_P -.->|"daily volume sync"| KERIA_SB

    style Primary fill:#eff6ff,stroke:#3b82f6
    style Standby fill:#fdf4ff,stroke:#a855f7
    style Homes fill:#f0fdf4,stroke:#16a34a
    style KERIA_P fill:#dbeafe,stroke:#3b82f6,color:#1e3a5f
    style KERIA_SB fill:#ede9fe,stroke:#7c3aed,color:#3b0764
    style WA_P fill:#d1fae5,stroke:#059669,color:#064e3b
    style WB_P fill:#d1fae5,stroke:#059669,color:#064e3b
    style WC_P fill:#d1fae5,stroke:#059669,color:#064e3b
```

**What you get:** KERIA RTO drops to ~5 minutes. Three genuinely independent witnesses. Byzantine fault tolerance (2 of 3 must be compromised simultaneously to forge an identity).

**Cost:** ~$30–50/month for two VPS + home servers.

---

## Setting up Matou Nextcloud

### Can Ben and Cherese host Matou Nextcloud?

**Yes.** Nextcloud is fully self-hosted, Docker-deployable, and well-documented. It's the right tool for shared file storage, document collaboration, and calendar/contact sync.

### Deployment plan

**Cloud server (always-on):**
```yaml
services:
  nextcloud:
    image: nextcloud:latest
    ports: ["80:80"]
    volumes:
      - nextcloud-data:/var/www/html
      - nextcloud-files:/var/www/html/data
    environment:
      NEXTCLOUD_ADMIN_USER: admin
      MYSQL_HOST: db
      MYSQL_DATABASE: nextcloud
      MYSQL_USER: nextcloud
      MYSQL_PASSWORD: ...
  db:
    image: mariadb:10.6
    volumes:
      - db-data:/var/lib/mysql
```

**Local replica — Ben's machine:** Install Nextcloud Desktop Client → configure to sync from cloud server. Files available locally even when server is offline.

**Local replica — Cherese's machine:** Same. Second independent local copy.

**Test: does cloud stay live if one device goes offline?** Yes — by design. Nextcloud clients are independent of server availability. A client going offline doesn't affect other clients or the server. The server only goes offline if the cloud VPS goes down.

```mermaid
graph TD
    NC["Nextcloud<br>cloud VPS"]
    BEN_NC["Ben's desktop client<br>local sync copy"]
    CH_NC["Cherese's desktop client<br>local sync copy"]
    OTHER["Other team members"]

    NC <-->|"sync"| BEN_NC
    NC <-->|"sync"| CH_NC
    NC <-->|"sync"| OTHER

    BEN_NC -.->|"goes offline<br>no impact to server or others"| OFFLINE["✓ server + Cherese<br>keep running normally"]

    style NC fill:#dbeafe,stroke:#3b82f6,color:#1e3a5f
    style BEN_NC fill:#d1fae5,stroke:#059669,color:#064e3b
    style CH_NC fill:#d1fae5,stroke:#059669,color:#064e3b
    style OTHER fill:#d1fae5,stroke:#059669,color:#064e3b
    style OFFLINE fill:#d1fae5,stroke:#059669,color:#064e3b
```

**Deploying a second local backup:** Run Nextcloud on a Raspberry Pi or spare machine at a second location, configured as an additional sync client. It holds a third copy of all files with no extra cloud cost.

**Better alternative?** Nextcloud is the right choice for self-hosted file sync. If you only need file sync (not calendars/contacts/collaboration), **Syncthing** is simpler — pure peer-to-peer, no server required, but then you need one always-on device acting as a hub. Nextcloud is more featureful and better supported.

---

## Summary

| Question | Answer |
|---|---|
| Can Ben and Cherese host it? | Yes — KERIA and witnesses are Docker services on any internet-accessible server |
| What does KERIA do? | Online mailbox, KEL storage, message routing — never holds private keys |
| What do witnesses do? | The replication layer — independently receipt and store key events |
| How to add a device? | Deploy a keripy witness process, update `keria-config.json` iurls, raise toad in client.ts |
| How do we know agents are replicated? | `operations().wait()` confirms toad receipts; query `/oobi/<aid>` on each witness to verify manually |
| Is current setup resilient? | No — witness-demo is a dev tool; all 6 witnesses in one container on one server |
| Does multiple witnesses on same server help? | No — geographic/network separation is what gives resilience |
| If one server goes down, does it pull from elsewhere? | Witnesses: yes (toad=2 of 3 means 1 failure is fine). KERIA: no auto-failover, manual restore needed |
| Cloud vs mix for witnesses? | Mix is better — cloud VPS for KERIA, home servers for witnesses gives real independence |
| Minimum to get started? | Current setup + daily snapshot (~$15/month) |
| Minimum for genuine 3× resilience? | 1 cloud VPS (KERIA + Witness A) + Ben's server (Witness B) + Cherese's server (Witness C), toad=2 (~$30–50/month) |
