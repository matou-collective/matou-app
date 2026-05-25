# KERI & KERIA — Matou Deep Dive

## Part 1 — KERI Concepts

### What is KERI?

**KERI** (Key Event Receipt Infrastructure) is a decentralised identity protocol invented by Samuel Smith in 2019. Its core idea: a controller (person, organisation, device) can prove who they are using cryptographic keys that _they_ control — without any shared blockchain, registry, or identity provider.

A KERI identity is called an **AID** (Autonomic Identifier). Every AID has a **KEL** (Key Event Log) — an append-only, cryptographically chained log of key events. The KEL is the ground truth for an AID's key state. It is signed by the controller and receipted by witnesses.

---

### The Seven Hard Problems KERI Solves

| Problem | What it means | KERI solution |
|---|---|---|
| **Rotation** | Change signing keys without breaking past signatures | Pre-rotation: next keys are committed in advance |
| **Recovery** | Recover from key loss without reissuing everything | Pre-rotation keys act as recovery path |
| **Detectability** | Know if your keys were stolen and used | Witnesses + Watchers — the "oil light" |
| **Discovery** | Find the current key state of any AID | OOBIs (Out-of-Band Introductions) |
| **Delegability** | Let a sub-entity sign on your behalf | Delegated AIDs |
| **Revocability** | Revoke credentials without central authority | Anchored issuances in KEL |
| **Multi-signature** | Weighted m-of-n threshold signing | Group AIDs |

---

### The Protocol Actors

```mermaid
graph TD
    subgraph Controller["🔑 Controller (Matou member / org)"]
        KEYS["Private keys<br>— never leave device —"]
        KEL["Key Event Log<br>append-only · chained · signed"]
    end

    subgraph Witnesses["👁 Witnesses — independent receipt servers"]
        W1["Witness A<br>receipts events<br>stores KEL copy"]
        W2["Witness B<br>receipts events<br>stores KEL copy"]
        W3["Witness C<br>receipts events<br>stores KEL copy"]
    end

    subgraph Verifiers["✅ Verifiers / Watchers"]
        VER["Verifiers<br>check key state<br>detect forks"]
        WAT["Watchers<br>independent monitors<br>prevent single-oracle problem"]
    end

    KEYS -->|"signs key events"| KEL
    KEL -->|"① push event to all witnesses"| W1
    KEL -->|"① push event to all witnesses"| W2
    KEL -->|"① push event to all witnesses"| W3
    W1 -->|"② signed receipt back"| KEL
    W2 -->|"② signed receipt back"| KEL
    W3 -->|"② signed receipt back"| KEL
    W1 -->|"③ serve key state via OOBI"| VER
    W2 -->|"③ serve key state via OOBI"| VER
    W3 -->|"③ serve key state via OOBI"| VER
    VER --- WAT

    style Controller fill:#f0fdf4,stroke:#16a34a
    style Witnesses fill:#eff6ff,stroke:#3b82f6
    style Verifiers fill:#fdf4ff,stroke:#a855f7
    style KEYS fill:#d1fae5,stroke:#059669,color:#064e3b
    style KEL fill:#d1fae5,stroke:#059669,color:#064e3b
    style W1 fill:#dbeafe,stroke:#3b82f6,color:#1e3a5f
    style W2 fill:#dbeafe,stroke:#3b82f6,color:#1e3a5f
    style W3 fill:#dbeafe,stroke:#3b82f6,color:#1e3a5f
    style VER fill:#ede9fe,stroke:#7c3aed,color:#3b0764
    style WAT fill:#ede9fe,stroke:#7c3aed,color:#3b0764
```

**Key insight**: to compromise a KERI identifier, every one of its witnesses must also be compromised simultaneously. The witnesses don't need to trust each other — they independently verify and receipt events.

---

### Pre-Rotation

```mermaid
graph LR
    ICP["🌱 Inception event<br>current keys: K0<br>next keys hash: H(K1) ← committed now"]
    ROT1["🔄 Rotation 1<br>reveal K1 — matches H(K1) ✓<br>next keys hash: H(K2) ← committed now"]
    ROT2["🔄 Rotation 2<br>reveal K2 — matches H(K2) ✓<br>next keys hash: H(K3)"]

    ICP -->|"key event"| ROT1 -->|"key event"| ROT2

    style ICP fill:#d1fae5,stroke:#059669,color:#064e3b
    style ROT1 fill:#dbeafe,stroke:#3b82f6,color:#1e3a5f
    style ROT2 fill:#dbeafe,stroke:#3b82f6,color:#1e3a5f
```

At inception, you commit to the _hash_ of your next keys. An attacker who steals your current signing key **cannot rotate your identity** because they don't have the pre-rotation keys. Pre-rotation is KERI's greatest innovation and is what makes witness-backed detectability meaningful.

---

### OOBIs — How Parties Discover Each Other

An **OOBI** (Out-of-Band Introduction) is a URL that lets one party discover another's key state:

```
http://<keria-host>:3902/oobi/<AID>/agent/<agentAID>
```

```mermaid
sequenceDiagram
    participant A as Alice (Matou member)
    participant KERIA as KERIA (cloud agent)
    participant B as Bob

    Note over A: Wants to contact Bob
    B-->>A: shares OOBI URL (e.g. via invite, QR code, config)

    A->>KERIA: resolveOOBI(bobsURL)
    KERIA->>KERIA: fetch Bob's key state from URL
    KERIA->>KERIA: verify KEL chain + witness receipts
    KERIA-->>A: ✓ Bob's AID is known, key state cached

    Note over A,B: Now Alice can send EXN messages to Bob
    A->>KERIA: sendEXN(route, payload, recipient=Bob's AID)
    KERIA->>B: route message via Bob's agent endpoint
```

No central address book. No directory. Just URLs and cryptographic verification.

---

### ACDC Credentials

**ACDC** (Authentic Chained Data Containers) is the KERI-native credential format. Delivered via **IPEX** (Issuance and Presentation Exchange):

```mermaid
graph LR
    ISS["🏛 Issuer AID<br>(Matou org)"]
    REG["Credential Registry<br>anchored in issuer KEL"]
    ACDC["📜 ACDC Credential<br>schema SAID · issuer AID<br>recipient AID · attributes"]
    GRANT["IPEX Grant<br>send credential offer<br>to recipient's inbox"]
    ADMIT["IPEX Admit<br>recipient accepts<br>credential stored"]

    ISS -->|"issue()"| REG
    REG -->|"credential SAID"| ACDC
    ACDC -->|"grant()"| GRANT
    GRANT -->|"admit()"| ADMIT

    style ISS fill:#fff7ed,stroke:#f97316,color:#7c2d12
    style REG fill:#fef3c7,stroke:#d97706,color:#78350f
    style ACDC fill:#d1fae5,stroke:#059669,color:#064e3b
    style GRANT fill:#dbeafe,stroke:#3b82f6,color:#1e3a5f
    style ADMIT fill:#d1fae5,stroke:#059669,color:#064e3b
```

Credentials are **anchored in the issuer's KEL** — if keys are stolen, any fraudulent issuances can be detected because they won't appear in the legitimate KEL.

---

## Part 2 — KERIA: the Cloud Agent

### The Signify / KERIA Split

This is the most important thing to understand. **Keys never leave the device.**

```mermaid
graph LR
    subgraph Edge["📱 Edge — Matou App (signify-ts)"]
        BRAN["Passcode (bran)<br>21-char base64<br>derives all keys"]
        KEYS["Private keys<br>generated from bran<br>stay in-process"]
        SIGN["Signs every<br>API request<br>(KRAM headers)"]
    end

    subgraph Cloud["☁️ Cloud — KERIA server"]
        AGENT["Managed Agent<br>per-user isolated keystore<br>no private keys"]
        KEL["KEL storage<br>key events · receipts"]
        INBOX["Message inbox<br>EXN messages<br>IPEX grants · notifications"]
        WIT["Witness coordinator<br>routes events to witnesses<br>collects receipts"]
    end

    BRAN -->|"derives"| KEYS
    KEYS -->|"signs requests"| SIGN
    SIGN -->|"① signed API call<br>Admin :3901"| AGENT
    AGENT --- KEL
    AGENT --- INBOX
    AGENT --- WIT

    style Edge fill:#f0fdf4,stroke:#16a34a
    style Cloud fill:#eff6ff,stroke:#3b82f6
    style BRAN fill:#d1fae5,stroke:#059669,color:#064e3b
    style KEYS fill:#d1fae5,stroke:#059669,color:#064e3b
    style SIGN fill:#d1fae5,stroke:#059669,color:#064e3b
    style AGENT fill:#dbeafe,stroke:#3b82f6,color:#1e3a5f
    style KEL fill:#dbeafe,stroke:#3b82f6,color:#1e3a5f
    style INBOX fill:#dbeafe,stroke:#3b82f6,color:#1e3a5f
    style WIT fill:#dbeafe,stroke:#3b82f6,color:#1e3a5f
```

KERIA knows _what_ happened (your KEL, credentials, messages) but cannot act on your behalf without your signed instructions. One KERIA instance hosts thousands of independent, isolated agents.

---

### KERIA's Three APIs

```mermaid
graph LR
    subgraph Signify["signify-ts (app)"]
        SC["SignifyClient"]
    end

    subgraph KERIA["KERIA server"]
        ADMIN["Admin API<br>:3901<br>create AID · issue credential<br>list notifications · rotate keys"]
        CESR["CESR / Message Router<br>:3902<br>external KERI protocol<br>OOBI endpoints<br>multisig coordination"]
        BOOT["Boot API<br>:3903<br>provision new agent<br>⚠ restrict in production"]
    end

    SC -->|"all app operations"| ADMIN
    SC -->|"first-time setup"| BOOT
    EXTERNAL["External KERI clients<br>other members' agents"]-->|"incoming messages"| CESR

    style Signify fill:#f0fdf4,stroke:#16a34a
    style KERIA fill:#eff6ff,stroke:#3b82f6
    style ADMIN fill:#dbeafe,stroke:#3b82f6,color:#1e3a5f
    style CESR fill:#dbeafe,stroke:#3b82f6,color:#1e3a5f
    style BOOT fill:#fef3c7,stroke:#d97706,color:#78350f
    style SC fill:#d1fae5,stroke:#059669,color:#064e3b
    style EXTERNAL fill:#ede9fe,stroke:#7c3aed,color:#3b0764
```

---

## Part 3 — How Matou Uses KERI

### Full Stack Architecture

```mermaid
graph TD
    subgraph App["Matou App — Electron + Vue"]
        FE["frontend/src/lib/keri/client.ts<br>KERIClient (signify-ts wrapper)<br>AID · OOBI · credentials · messages · notifications"]
        BOOT2["boot/keri.ts<br>startup: load config · restore session"]
        STORE["stores/wallet.ts<br>credential display · token balances"]
    end

    subgraph Infra["matou-infrastructure/keri — Docker Compose"]
        KERIA2["KERIA :3901/:3902/:3903<br>weboftrust/keria:0.2.0-rc1<br>+ registration escrow patch"]
        WITDEMO["witness-demo :5642–5647<br>6 witnesses in 1 container<br>wan · wil · wes · wit · wub · wyz"]
        SCHEMA["schema-server :7723<br>ACDC schema OOBIs"]
        CONFIG["config-server :3904<br>client config · org config · admin list"]
    end

    subgraph Backend["Go backend"]
        GOKERI["backend/internal/keri/client.go<br>config-only — NO network calls to KERIA<br>validates credentials · defines roles"]
    end

    FE -->|"Admin API"| KERIA2
    BOOT2 -->|"fetch config"| CONFIG
    KERIA2 -->|"OOBI resolution"| WITDEMO
    KERIA2 -->|"schema resolution"| SCHEMA
    FE -.->|"credential sync<br>/api/v1/sync/credentials"| GOKERI

    style App fill:#f0fdf4,stroke:#16a34a
    style Infra fill:#eff6ff,stroke:#3b82f6
    style Backend fill:#fff7ed,stroke:#f97316
    style FE fill:#d1fae5,stroke:#059669,color:#064e3b
    style BOOT2 fill:#d1fae5,stroke:#059669,color:#064e3b
    style STORE fill:#d1fae5,stroke:#059669,color:#064e3b
    style KERIA2 fill:#dbeafe,stroke:#3b82f6,color:#1e3a5f
    style WITDEMO fill:#dbeafe,stroke:#3b82f6,color:#1e3a5f
    style SCHEMA fill:#fef3c7,stroke:#d97706,color:#78350f
    style CONFIG fill:#fef3c7,stroke:#d97706,color:#78350f
    style GOKERI fill:#fed7aa,stroke:#f97316,color:#7c2d12
```

**Key design principle**: the Go backend never talks directly to KERIA. All cryptographic operations happen in the frontend via signify-ts. The backend is purely a validation and storage layer.

---

### App Startup Sequence

```mermaid
sequenceDiagram
    participant App as Matou App
    participant Config as config-server :3904
    participant KERIA as KERIA :3901
    participant Witnesses as witness-demo :5642–5647

    App->>Config: ① fetch client config (KERIA URLs, witness OOBIs, anysync config)
    Config-->>App: keria.admin_url, boot_url, cesr_url, org AID, admin list

    App->>Config: ② load org config (admin AIDs, schema SAIDs)
    Config-->>App: org config

    Note over App: ③ check secure storage for saved passcode (bran)

    App->>KERIA: ④ connect(bran) — try existing agent
    alt agent exists
        KERIA-->>App: ✓ connected
    else new user
        App->>KERIA: boot(bran) — create new agent
        KERIA-->>App: ✓ agent created
        App->>KERIA: connect(bran)
        KERIA-->>App: ✓ connected
    end

    App->>KERIA: ⑤ config().get() — fetch witness OOBIs
    loop for each witness OOBI
        App->>KERIA: oobis().resolve(witnessURL)
        KERIA->>Witnesses: fetch key state
        Witnesses-->>KERIA: ✓ witness key state cached
    end

    Note over App: ✅ session restored — ready
```

---

### Registration Flow (new member applying)

```mermaid
sequenceDiagram
    participant User as New User
    participant KERIA as KERIA (patched)
    participant Admin as Admin

    User->>KERIA: createAID("my-name", witnesses)
    KERIA-->>User: ✓ AID created + witnessed

    User->>KERIA: resolveOOBI(org OOBI)
    KERIA-->>User: ✓ org AID known

    User->>KERIA: sendEXN(/matou/registration/apply, payload+senderOOBI)
    Note over KERIA: sender AID not known yet — message escrowed
    Note over KERIA: 🔧 PATCH: create /pending notification<br/>includes sender's OOBI in payload

    KERIA-->>Admin: notification: /exn/matou/registration/apply/pending

    Admin->>KERIA: resolveOOBI(senderOOBI from notification)
    KERIA-->>Admin: ✓ user AID now known

    Note over KERIA: escrow processor retries — sender now known
    Note over KERIA: 🔧 PATCH: no timeout — message persists until resolved

    KERIA-->>Admin: notification: /exn/matou/registration/apply (verified ✓)

    Admin->>KERIA: issueCredential(membershipSchema, recipientAID)
    KERIA->>KERIA: IPEX grant → user's inbox

    User->>KERIA: admitCredential(grantSAID)
    KERIA-->>User: ✓ credential in wallet
```

---

### Claim Identity Flow (invited member)

```mermaid
sequenceDiagram
    participant Admin as Admin
    participant KERIA as KERIA
    participant Invitee as Invitee

    Note over Admin: Creates agent + AID for invitee
    Admin->>KERIA: createEphemeralClient(bran)
    KERIA-->>Admin: ✓ ephemeral agent connected

    Admin->>KERIA: createAID("invitee-name", witnesses)
    KERIA-->>Admin: ✓ AID at seq=0

    Admin->>KERIA: issueCredential(role, recipientAID)
    KERIA-->>Admin: ✓ IPEX grant in invitee's inbox

    Note over Admin: encode mnemonic → 22-char invite code
    Admin-->>Invitee: share invite code (email / link)

    Note over Invitee: decode invite code → mnemonic → bran
    Invitee->>KERIA: initialize(bran) — connect to pre-created agent
    KERIA-->>Invitee: ✓ connected (seq=0, one existing AID)

    Invitee->>KERIA: admitCredential(grantSAID) — accept membership
    KERIA-->>Invitee: ✓ credential stored

    Invitee->>KERIA: rotateKeys("invitee-name") — take cryptographic ownership
    KERIA-->>Invitee: ✓ seq=1, new keys active — admin's keys no longer valid

    Note over Invitee: ✅ identity is now fully theirs
```

---

### The KERIA Registration Patch

Standard KERIA drops messages from unknown senders after 10 seconds. Matou monkey-patches three methods of keripy's `Exchanger` class at startup:

```mermaid
graph TD
    subgraph Standard["❌ Standard KERIA — broken for registration"]
        S1["User sends registration"]
        S2["Sender AID unknown<br>→ message escrowed"]
        S3["10 second timeout<br>→ message DROPPED"]
        S4["Admin never sees it"]
        S1 --> S2 --> S3 --> S4
    end

    subgraph Patched["✅ Patched KERIA — registration works"]
        P1["User sends registration<br>(includes senderOOBI in payload)"]
        P2["Sender AID unknown<br>→ message escrowed"]
        P3["PATCH ①<br>create /pending notification<br>with senderOOBI embedded"]
        P4["Admin sees pending registration<br>resolves sender's OOBI"]
        P5["PATCH ②<br>no timeout — message persists<br>escrow retries periodically"]
        P6["Sender now known<br>message processes"]
        P7["PATCH ③<br>create verified notification<br>for known-sender routes"]
        P1 --> P2 --> P3 --> P4 --> P5 --> P6 --> P7
    end

    style Standard fill:#fff1f2,stroke:#ef4444
    style Patched fill:#f0fdf4,stroke:#16a34a
    style S1 fill:#fca5a5,stroke:#ef4444,color:#7f1d1d
    style S2 fill:#fca5a5,stroke:#ef4444,color:#7f1d1d
    style S3 fill:#fca5a5,stroke:#ef4444,color:#7f1d1d
    style S4 fill:#fca5a5,stroke:#ef4444,color:#7f1d1d
    style P1 fill:#d1fae5,stroke:#059669,color:#064e3b
    style P2 fill:#fef3c7,stroke:#d97706,color:#78350f
    style P3 fill:#d1fae5,stroke:#059669,color:#064e3b
    style P4 fill:#dbeafe,stroke:#3b82f6,color:#1e3a5f
    style P5 fill:#d1fae5,stroke:#059669,color:#064e3b
    style P6 fill:#d1fae5,stroke:#059669,color:#064e3b
    style P7 fill:#d1fae5,stroke:#059669,color:#064e3b
```

---

## Part 4 — Current Witness Setup

### What You Actually Have Today

```mermaid
graph TD
    subgraph Server["Single server — everything on one machine"]
        subgraph Container["Single Docker container: witness-demo:1.1.0"]
            WAN["wan :5642"]
            WIL["wil :5643"]
            WES["wes :5644"]
            WIT2["wit :5645"]
            WUB["wub :5646"]
            WYZ["wyz :5647"]
        end
        KERIA3["KERIA<br>:3901–3903<br>+ keria-patches"]
        VOL[("witness-data volume<br>all 6 witness KELs<br>on same disk")]
    end

    AID["AID creation<br>— only uses wan —<br>toad=1 of 1"]

    AID -->|"1 witness, toad=1"| WAN
    WAN -.->|"same process"| WIL
    WAN -.->|"same process"| WES

    style Server fill:#fff1f2,stroke:#ef4444
    style Container fill:#fca5a5,stroke:#ef4444,color:#7f1d1d
    style KERIA3 fill:#fca5a5,stroke:#ef4444,color:#7f1d1d
    style VOL fill:#fca5a5,stroke:#ef4444,color:#7f1d1d
    style WAN fill:#fca5a5,stroke:#ef4444,color:#7f1d1d
    style WIL fill:#fca5a5,stroke:#ef4444,color:#7f1d1d
    style WES fill:#fca5a5,stroke:#ef4444,color:#7f1d1d
    style WIT2 fill:#fca5a5,stroke:#ef4444,color:#7f1d1d
    style WUB fill:#fca5a5,stroke:#ef4444,color:#7f1d1d
    style WYZ fill:#fca5a5,stroke:#ef4444,color:#7f1d1d
```

**If this server goes down**: KERIA goes down (no one can sign events or receive messages), and all 6 witnesses go down together (no key events can be anchored). This is **zero resilience** — it's a development setup.

---

## Part 5 — KERI Distributed Deployment

### Witnesses vs KERIA — Two Separate Resilience Concerns

```mermaid
graph LR
    subgraph KERIALayer["KERIA resilience — app usability"]
        K1["KERIA down<br>→ app can't connect<br>→ no new messages/events"]
        K2["KERIA data lost<br>→ message history lost<br>→ BUT identity safe in witnesses<br>→ restore from snapshot"]
    end

    subgraph WitnessLayer["Witness resilience — identity integrity"]
        W4["< toad witnesses up<br>→ can't anchor new events<br>→ identity frozen (not lost)"]
        W5["≥ toad witnesses up<br>→ full operation continues<br>→ downed witness catches up on return"]
        W6["All witnesses down<br>→ identity unverifiable<br>→ recoverable when back"]
    end

    style KERIALayer fill:#fff7ed,stroke:#f97316
    style WitnessLayer fill:#eff6ff,stroke:#3b82f6
    style K1 fill:#fca5a5,stroke:#ef4444,color:#7f1d1d
    style K2 fill:#fef3c7,stroke:#d97706,color:#78350f
    style W4 fill:#fca5a5,stroke:#ef4444,color:#7f1d1d
    style W5 fill:#d1fae5,stroke:#059669,color:#064e3b
    style W6 fill:#fef3c7,stroke:#d97706,color:#78350f
```

**The key insight**: if KERIA's database is lost but witnesses are alive, identities can be fully reconstructed. Users re-initialize with their mnemonic, KERIA re-fetches witness receipts. Only message history and notifications are lost, not identities.

---

### How Witness Replication Actually Works

Unlike any-sync where nodes actively replicate to each other, KERI witnesses receive events **pushed from the controller** at the time of signing. There is no background gossip between witnesses.

```mermaid
sequenceDiagram
    participant C as Controller (app)
    participant W1 as Witness A (cloud)
    participant W2 as Witness B (Ben's server)
    participant W3 as Witness C (Cherese's server)

    Note over C: Creates or rotates an AID (toad=2, n=3)

    C->>W1: push key event (signed)
    C->>W2: push key event (signed)
    C->>W3: push key event (signed)

    W1-->>C: ✓ receipt (W1 signature over event)
    W2-->>C: ✓ receipt (W2 signature over event)
    W3-->>C: ✓ receipt (W3 signature over event)

    Note over C: collected 3 receipts ≥ toad=2 ✅
    Note over C: key event is now "established"

    Note over W2: W2 goes offline next day

    C->>W1: push next key event
    C->>W3: push next key event
    W2--xC: (offline — no receipt)

    W1-->>C: ✓ receipt
    W3-->>C: ✓ receipt

    Note over C: collected 2 receipts = toad=2 ✅ still works

    Note over W2: W2 comes back online
    C->>W2: push missed events (controller retries)
    W2-->>C: ✓ caught up
```

---

### Recommended Production Topology

```mermaid
graph TD
    subgraph Users["Matou members (app)"]
        APP1["User Device A<br>signify-ts"]
        APP2["User Device B<br>signify-ts"]
    end

    subgraph KERIAServer["☁️ Cloud Server — Hetzner / DigitalOcean"]
        KERIA4["KERIA<br>:3901–3903 (TLS via Traefik)<br>+ registration patch"]
        SCHEMA2["schema-server :7723"]
        CONFIG2["config-server :3904"]
        SNAP[("💾 daily volume snapshot<br>keria-data backup")]
        KERIA4 --- SNAP
    end

    subgraph Wit1["Witness A — Cloud VPS (~€5/mo)"]
        WA["keripy witness<br>:5642 public HTTPS<br>wan"]
    end

    subgraph Wit2["Witness B — Ben's home server"]
        WB["keripy witness<br>:5643 public HTTPS<br>wil"]
    end

    subgraph Wit3["Witness C — Cherese's home server"]
        WC["keripy witness<br>:5644 public HTTPS<br>wes"]
    end

    APP1 -->|"Admin API (TLS)"| KERIA4
    APP2 -->|"Admin API (TLS)"| KERIA4
    KERIA4 -->|"push events"| WA
    KERIA4 -->|"push events"| WB
    KERIA4 -->|"push events"| WC
    WA -.->|"toad=2 of 3<br>2 receipts needed"| KERIA4
    WB -.->|"receipt"| KERIA4
    WC -.->|"receipt"| KERIA4

    style Users fill:#f0fdf4,stroke:#16a34a
    style KERIAServer fill:#eff6ff,stroke:#3b82f6
    style Wit1 fill:#f0fdf4,stroke:#16a34a
    style Wit2 fill:#f0fdf4,stroke:#16a34a
    style Wit3 fill:#f0fdf4,stroke:#16a34a
    style KERIA4 fill:#dbeafe,stroke:#3b82f6,color:#1e3a5f
    style SCHEMA2 fill:#fef3c7,stroke:#d97706,color:#78350f
    style CONFIG2 fill:#fef3c7,stroke:#d97706,color:#78350f
    style SNAP fill:#ede9fe,stroke:#7c3aed,color:#3b0764
    style WA fill:#d1fae5,stroke:#059669,color:#064e3b
    style WB fill:#d1fae5,stroke:#059669,color:#064e3b
    style WC fill:#d1fae5,stroke:#059669,color:#064e3b
    style APP1 fill:#d1fae5,stroke:#059669,color:#064e3b
    style APP2 fill:#d1fae5,stroke:#059669,color:#064e3b
```

---

### One Witness Goes Down — Still Works

```mermaid
graph TD
    KERIA5["KERIA<br>✓ online"]
    WA2["Witness A<br>✓ online"]
    WB2["Witness B<br>✗ OFFLINE"]
    WC2["Witness C<br>✓ online"]

    KERIA5 -->|"push events"| WA2
    KERIA5 -.->|"push fails"| WB2
    KERIA5 -->|"push events"| WC2
    WA2 -->|"✓ receipt 1 of 2"| KERIA5
    WC2 -->|"✓ receipt 2 of 2 — toad met ✅"| KERIA5

    Note["toad=2 of 3<br>2 receipts collected<br>events continue anchoring normally<br>Witness B catches up when it returns"]

    style KERIA5 fill:#dbeafe,stroke:#3b82f6,color:#1e3a5f
    style WA2 fill:#d1fae5,stroke:#059669,color:#064e3b
    style WB2 fill:#fca5a5,stroke:#ef4444,color:#7f1d1d
    style WC2 fill:#d1fae5,stroke:#059669,color:#064e3b
    style Note fill:#fef3c7,stroke:#d97706,color:#78350f
```

**Impact on users:** None. ✅ They don't even know a witness is down.

---

### KERIA Goes Down (Witness Resilience Holds)

```mermaid
graph TD
    KERIA6["KERIA<br>✗ OFFLINE"]
    WA3["Witness A<br>✓ online — KEL intact"]
    WB3["Witness B<br>✓ online — KEL intact"]
    WC3["Witness C<br>✓ online — KEL intact"]
    USERS["Users<br>✗ can't connect<br>app shows error"]
    RESTORE["Restore KERIA from snapshot<br>~10–30 min RTO<br>identities fully intact in witnesses"]

    USERS -.->|"connection refused"| KERIA6
    KERIA6 -.->|"can't reach"| WA3
    WA3 --- WB3
    WB3 --- WC3
    KERIA6 -->|"restore"| RESTORE
    RESTORE -->|"re-connects to"| WA3

    style KERIA6 fill:#fca5a5,stroke:#ef4444,color:#7f1d1d
    style USERS fill:#fca5a5,stroke:#ef4444,color:#7f1d1d
    style WA3 fill:#d1fae5,stroke:#059669,color:#064e3b
    style WB3 fill:#d1fae5,stroke:#059669,color:#064e3b
    style WC3 fill:#d1fae5,stroke:#059669,color:#064e3b
    style RESTORE fill:#fef3c7,stroke:#d97706,color:#78350f
```

**Impact on users:** Can't use the app until KERIA is restored. Identities (KELs) are safe. Message history may be partially lost if snapshot was >24h old.

---

### Deployment Option Comparison

| Option | Resilience | Cost/mo | What fails |
|---|---|---|---|
| **Current** (dev) | ❌ None | $0 | Everything if server down |
| **Starter** (1 server + snapshot) | 🟡 Low | ~$15 | ~30min RTO on server loss |
| **Recommended** (1 KERIA + 3 witnesses) | 🟢 Good | ~$30–50 | 1 witness can fail; KERIA single point |
| **Robust** (+ cold standby KERIA) | 🟢 High | ~$60–100 | 2 witnesses can fail; KERIA ~10min RTO |
| **Full HA** (load-balanced KERIA + 5 witnesses) | 🟢 Very high | ~$200+ | Requires shared storage / KERIA clustering |

---

## Part 6 — Quick Reference

### Service Ports

| Service | Port | Purpose |
|---|---|---|
| KERIA Admin | 3901 | All Signify client calls |
| KERIA CESR | 3902 | External KERI protocol / OOBI endpoints |
| KERIA Boot | 3903 | Agent provisioning (restrict in production) |
| Config Server | 3904 | Client + org config |
| Witness wan | 5642 | HTTP OOBI |
| Witness wil | 5643 | HTTP OOBI |
| Witness wes | 5644 | HTTP OOBI |
| Witness wit | 5645 | HTTP OOBI |
| Witness wub | 5646 | HTTP OOBI |
| Witness wyz | 5647 | HTTP OOBI |
| Schema Server | 7723 | ACDC schema OOBI endpoints |

### Key Files

| File | What it is |
|---|---|
| `keri/keria-config.json` | KERIA bootstrap: CESR URL + witness OOBIs to pre-resolve |
| `keri/witness-config/wan.json` | Witness `wan` config: its own curl + peer iurls |
| `keri/docker-compose.yml` | Dev stack |
| `keri/docker-compose.prod.yml` | Production Traefik TLS overrides |
| `keria-patches/exchanger_patch.py` | Registration escrow patch (3 monkey-patches) |
| `keria-patches/start_keria.py` | Patched entrypoint — applies patches before starting KERIA |
| `frontend/src/lib/keri/client.ts` | All frontend KERI operations (signify-ts wrapper, ~1400 lines) |
| `frontend/src/boot/keri.ts` | App startup: config load, session restore |
| `backend/internal/keri/client.go` | Backend: credential validation + role definitions (no KERIA calls) |

### Terminology

| Term | Plain English |
|---|---|
| AID | Your decentralised identity (like a DID) |
| KEL | Tamper-proof history of your identity's key events |
| KERIA | Cloud agent: your identity's always-on server (holds KEL, inbox, message routing) |
| signify-ts | Edge wallet: runs in the app, holds private keys, signs everything |
| Witness | Independent server that receipts key events — the replication layer |
| TOAD | Minimum number of witness receipts needed to anchor a key event |
| OOBI | URL to discover another party's key state |
| ACDC | KERI-native credential format |
| IPEX | Protocol for issuing and accepting credentials |
| EXN | Exchange message — arbitrary peer-to-peer message between AIDs |
| bran | The 21-char passcode that derives all agent keys |
| mnemonic | 12-word BIP39 recovery phrase (derives the bran) |
| TOAD=2 of 3 | Any 2 of 3 witnesses must receipt an event — tolerates 1 failure |
