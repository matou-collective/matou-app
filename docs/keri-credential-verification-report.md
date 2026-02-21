# KERI/ACDC Credential Verification with Witnesses

## Overview

This report documents how credential verification works in the KERI/ACDC stack using KERIA (Python agent) and signify-ts (TypeScript client). It covers the full verification chain, the Admitter background task, witness integration, and how a verifier confirms both issuer authenticity and holder identity.

**Key finding**: There is no `verify(credential)` method in signify-ts. All cryptographic verification is performed server-side by KERIA's keripy engine. signify-ts is a thin client that constructs and submits messages.

---

## Table of Contents

1. [Credential Issuance and Grant Flow](#1-credential-issuance-and-grant-flow)
2. [The Admitter Background Task](#2-the-admitter-background-task)
3. [Cryptographic Verification Chain](#3-cryptographic-verification-chain)
4. [Verifying Issuer Authenticity](#4-verifying-issuer-authenticity)
5. [Verifying Holder Identity](#5-verifying-holder-identity)
6. [Witness Role in Verification](#6-witness-role-in-verification)
7. [IPEX Presentation Flow](#7-ipex-presentation-flow)
8. [Our Implementation](#8-our-implementation)
9. [signify-ts API Reference](#9-signify-ts-api-reference)
10. [Common Pitfalls](#10-common-pitfalls)

---

## 1. Credential Issuance and Grant Flow

When an issuer creates and delivers a credential, three artifacts are produced:

| Artifact | Type | Purpose |
|----------|------|---------|
| `acdc` | SerderACDC | The credential itself (schema, issuer AID, recipient AID, attributes) |
| `iss` | TEL event | Transaction Event Log entry recording the issuance |
| `anc` | KEL `ixn` event | Key Event Log interaction event anchoring the `iss` to the issuer's key state |

These three are bundled into an IPEX `/ipex/grant` exchange message and sent to the recipient.

**Source — signify-ts grant construction:**
[`signify-ts/src/keri/app/credentialing.ts` — `Ipex.grant()`](https://github.com/WebOfTrust/signify-ts/blob/main/src/keri/app/credentialing.ts)

```typescript
// The grant embeds all three artifacts
const embeds = {
    acdc: [args.acdc, acdcAtc],   // ACDC + SealSourceTriples attachment
    iss:  [args.iss, issAtc],     // TEL iss event + SealSourceCouples attachment
    anc:  [args.anc, atc],        // KEL ixn event + controller signatures
};
return this.client.exchanges()
    .createExchangeMessage(hab, '/ipex/grant', data, embeds, args.recipient, ...);
```

**Source — signify-ts grant submission:**
[`signify-ts/src/keri/app/credentialing.ts` — `Ipex.submitGrant()`](https://github.com/WebOfTrust/signify-ts/blob/main/src/keri/app/credentialing.ts)

```typescript
// POST /identifiers/{name}/ipex/grant
async submitGrant(name, exn, sigs, atc, recp) {
    const body = { exn: exn.sad, sigs, atc, rec: recp };
    return this.client.fetch(`/identifiers/${name}/ipex/grant`, 'POST', body);
}
```

---

## 2. The Admitter Background Task

Verification is triggered when the **recipient admits** a grant — not when the grant is created or received.

### 2.1 Admit Submission (KERIA endpoint)

When the client calls `submitAdmit()`, it hits KERIA's `/identifiers/{name}/ipex/admit` endpoint.

**Source:** [`keria/src/keria/app/ipexing.py` — `sendAdmit()`](https://github.com/WebOfTrust/keria/blob/main/src/keria/app/ipexing.py)

```python
@staticmethod
def sendAdmit(agent, hab, ked, sigs, rec):
    for recp in rec:
        if recp not in agent.hby.kevers:
            raise falcon.HTTPBadRequest(
                description=f"attempt to send to unknown AID={recp}"
            )

    serder = serdering.SerderKERI(sad=ked)
    sigers = [core.Siger(qb64=sig) for sig in sigs]

    kever = hab.kever
    seal = eventing.SealEvent(
        i=hab.pre, s="{:x}".format(kever.lastEst.s), d=kever.lastEst.d
    )
    ims = eventing.messagize(serder=serder, sigers=sigers, seal=seal)

    # Parse the admit EXN immediately (validates admit signature)
    agent.parser.parseOne(ims=bytearray(ims))

    # Queue for background processing
    agent.exchanges.append(
        dict(said=serder.said, pre=hab.pre, rec=rec, topic="credential")
    )
    agent.admits.append(dict(said=ked["d"], pre=hab.pre))

    return agent.monitor.submit(
        serder.said, longrunning.OpTypes.exchange, metadata=dict(said=serder.said)
    )
```

Two things happen:
1. The admit EXN message itself is parsed immediately (its signature is verified)
2. It's queued in two decks: `agent.exchanges` (for delivery back to grant sender) and `agent.admits` (for background credential processing)

### 2.2 Background Processing (Admitter Doer)

The `Admitter` is a `hio.Doer` coroutine that runs continuously in KERIA's event loop.

**Source:** [`keria/src/keria/app/agenting.py` — `class Admitter`](https://github.com/WebOfTrust/keria/blob/main/src/keria/app/agenting.py)

```python
class Admitter(doing.Doer):
    def __init__(self, hby, witq, psr, agentHab, exc, admits, tock=0.0):
        self.hby = hby
        self.agentHab = agentHab
        self.witq = witq        # Witness query interface
        self.psr = psr          # keripy parser
        self.exc = exc          # Exchange manager
        self.admits = admits    # Deque of pending admits

    def recur(self, tyme, tock=0.0, **opts):
        if self.admits:
            msg = self.admits.popleft()
            said = msg["said"]

            # 1. Wait until the exchange message is fully assembled
            if not self.exc.complete(said=said):
                self.admits.append(msg)  # re-queue
                return False

            # 2. Clone the admit, follow "p" (prior) to get the grant
            admit, _ = exchanging.cloneMessage(self.hby, said)
            grant, pathed = exchanging.cloneMessage(self.hby, admit.ked["p"])

            # 3. Extract embedded artifacts from the grant
            embeds = grant.ked["e"]
            acdc = embeds["acdc"]
            issr = acdc["i"]  # issuer AID

            # 4. Query witnesses for issuer's latest KEL and TEL
            self.witq.query(hab=self.agentHab, pre=issr)
            if "ri" in acdc:
                self.witq.telquery(
                    hab=self.agentHab, pre=issr, ri=acdc["ri"], i=acdc["d"]
                )

            # 5. Feed each artifact into the parser for verification
            for label in ("anc", "iss", "acdc"):
                ked = embeds[label]
                sadder = coring.Sadder(ked=ked)
                ims = bytearray(sadder.raw) + pathed[label]
                self.psr.parseOne(ims=ims)  # triggers actual verification
```

### 2.3 Processing Pipeline

```
submitAdmit() called by client
  |
  +-- parse admit EXN (verify admit signature immediately)
  +-- queue to agent.admits deck
       |
       +-- Admitter.recur() picks it up (background loop)
            |
            +-- wait for exchange completeness
            +-- clone grant, extract embeds (acdc, iss, anc)
            +-- witq.query(pre=issuer)         --> fetch issuer KEL from witnesses
            +-- witq.telquery(ri=registry)     --> fetch TEL from witnesses
            +-- parser.parseOne(anc)           --> kvy.processEvent()
            |     verify ixn signatures + witness receipts
            +-- parser.parseOne(iss)           --> tvy.processEvent()
            |     validate TEL issuance event
            +-- parser.parseOne(acdc)          --> vry.processCredential()
                  registry + revocation + schema + chain checks
                  |
                  +-- success: credential stored in wallet
                  +-- missing data: escrow (retried later)
```

---

## 3. Cryptographic Verification Chain

The keripy parser dispatches each artifact to a specialized handler:

### 3.1 KEL Anchor Verification (`anc` → `kvy.processEvent()`)

**Source:** [`keripy/src/keri/core/parsing.py`](https://github.com/WebOfTrust/keripy/blob/main/src/keri/core/parsing.py)

The `anc` artifact is a KEL interaction event (`ixn`) containing a seal that points to the `iss` TEL event. The parser:

- Verifies the controller's indexed signatures (`-A` CESR group) against the issuer's current public keys from their KEL
- Verifies witness indexed signatures (`-B` CESR group) — receipt signatures from the issuer's witness set
- Validates the event chains correctly to prior events in the issuer's KEL

### 3.2 TEL Issuance Verification (`iss` → `tvy.processEvent()`)

The `iss` artifact is a Transaction Event Log issuance event. The handler:

- Validates the TEL event structure
- Anchors it to the KEL seal (the `anc` event must reference this `iss` event)
- Records the issuance in the registry

### 3.3 ACDC Credential Verification (`acdc` → `vry.processCredential()`)

**Source:** [`keripy/src/keri/vdr/verifying.py` — `Verifier.processCredential()`](https://github.com/WebOfTrust/keripy/blob/main/src/keri/vdr/verifying.py)

This performs the highest-level checks:

| Check | Description |
|-------|-------------|
| **Registry exists** | Credential's registry SAID exists in `tevers` (TEL event verifiers) |
| **Issuance state** | TEL contains an `iss` event for this credential SAID |
| **Not revoked** | No `rev` event exists for the credential |
| **Not expired** | Timestamp within `CredentialExpiry` threshold |
| **Schema valid** | Schema resolved and `schemer.verify(creder.raw)` passes |
| **Chain valid** | Chained edge credentials validated recursively via `verifyChain()` |

### 3.4 Escrow Handling

If any dependency is missing, the credential is escrowed rather than rejected:

| Escrow | Trigger | Behavior |
|--------|---------|----------|
| **MRE** (Missing Registry) | Registry or TEL events not yet available | Retried when TEL data arrives |
| **MSE** (Missing Schema) | Schema OOBI not yet resolved | Retried when schema resolves |
| **MCE** (Missing Chain) | Edge credentials not yet verified | Retried when dependencies verify |

**Source:** [`keripy/src/keri/vdr/verifying.py` — escrow methods](https://github.com/WebOfTrust/keripy/blob/main/src/keri/vdr/verifying.py)

```python
def _processEscrow(self, db, timeout, etype: Type[Exception]):
    for (said,), dater in db.getItemIter():
        creder, prefixer, seqner, saider = self.reger.cloneCred(said)
        try:
            dtnow = helping.nowUTC()
            dte = helping.fromIso8601(dater.dts)
            if (dtnow - dte) > datetime.timedelta(seconds=timeout):
                raise kering.ValidationError("Stale event escrow")
            self.processCredential(creder, prefixer, seqner, saider)
        except etype:
            pass          # Expected — keep in escrow
        except Exception:
            db.rem(said)  # Unexpected error — remove
        else:
            db.rem(said)  # Success — remove from escrow
```

---

## 4. Verifying Issuer Authenticity

"Was this credential actually issued by AID X?"

Four interlocking proofs answer this:

### 4.1 SAID Integrity

The ACDC's `d` field is a cryptographic digest (BLAKE3/SHA3-256) of its entire canonicalized content, including the `i` (issuer) field. Changing any field breaks the SAID.

**Source:** [`signify-ts/src/keri/app/credentialing.ts` — `Credentials.issue()`](https://github.com/WebOfTrust/signify-ts/blob/main/src/keri/app/credentialing.ts)

```typescript
const [, acdc] = Saider.saidify({
    v: versify(Protocols.ACDC, ...),
    d: '',          // filled by saidify
    i: hab.prefix,  // issuer AID baked into the SAID
    ri: args.ri,    // registry ID
    s: args.s,      // schema SAID
    a: subject,     // attributes including a.i (recipient)
});
```

### 4.2 TEL Issuance Record

The `iss` TEL event records that this credential SAID was issued under this registry. A verifier checks the TEL to confirm genuine issuance and non-revocation.

### 4.3 KEL Anchor with Signatures

The `iss` event is sealed into an `ixn` (interaction event) in the issuer's KEL, **signed by the issuer's current private keys**. A verifier who has the issuer's KEL can verify the signature against the known public keys.

### 4.4 Witness Receipts

The `ixn` event is receipted by the issuer's witnesses. The `toad` (threshold of accountable duplicity) parameter determines how many witness receipts are required. This prevents the issuer from presenting different KEL histories to different parties.

### 4.5 CESR Proof Bundle

All of this can be packaged into a single CESR blob via `credentials().get(said, true)`:

**Source:** [`signify-ts/src/keri/app/credentialing.ts` — `Credentials.get()`](https://github.com/WebOfTrust/signify-ts/blob/main/src/keri/app/credentialing.ts)

```typescript
async get(said, includeCESR = false) {
    const headers = includeCESR
        ? new Headers({ Accept: 'application/json+cesr' })
        : new Headers({ Accept: 'application/json' });
    const res = await this.client.fetch(`/credentials/${said}`, 'GET', null, headers);
    return includeCESR ? await res.text() : await res.json();
}
```

The JSON response includes:

| Field | Contents |
|-------|----------|
| `sad` | The ACDC body |
| `atc` | CESR SealSourceTriples attachment on the ACDC |
| `iss` | The TEL issuance event |
| `issatc` | CESR SealSourceCouples attachment on the iss event |
| `anc` | The KEL anchoring event |
| `ancatc` | Controller signatures + witness receipts on the anc event |
| `status` | TEL state (issued/revoked) |
| `schema` | Resolved JSON schema |
| `chains` | Chained/edge credentials |

---

## 5. Verifying Holder Identity

"Is the person presenting this credential the actual recipient?"

### 5.1 ACDC `a.i` Field Check

The credential's `a.i` field is the issuee's AID prefix. Application code compares this against the presenter's known AID.

### 5.2 Proof of Key Control

Knowing an AID isn't enough — the presenter must prove they hold the private keys. Two mechanisms exist:

**Signed HTTP Requests:**

**Source:** [`signify-ts/src/keri/app/clienting.ts` — `createSignedRequest()`](https://github.com/WebOfTrust/signify-ts/blob/main/src/keri/app/clienting.ts)

```typescript
async createSignedRequest(aidName, url, req) {
    const hab = await this.identifiers().get(aidName);
    const keeper = this.manager.get(hab);
    const authenticator = new Authenticater(keeper.signers[0], keeper.signers[0].verfer);
    const headers = new Headers(req.headers);
    headers.set('Signify-Resource', hab['prefix']);  // AID prefix
    headers.set(HEADER_SIG_TIME, ...);
    const signed_headers = authenticator.sign(new Headers(headers), ...);
    req.headers = signed_headers;
    return new Request(url, req);
}
```

The verifier checks `Signify-Resource` (AID), `Signature-Input` (keyid + algorithm), and `Signature` against the presenter's KEL public keys.

**Challenge-Response:**

**Source:** [`signify-ts/src/keri/app/contacting.ts` — `Challenges`](https://github.com/WebOfTrust/signify-ts/blob/main/src/keri/app/contacting.ts)

```
Verifier:  Challenges.generate(strength)    → random word list
Holder:    Challenges.respond(name, recipient, words) → signed EXN
Verifier:  Challenges.verify(source, words)  → KERIA checks signature
```

---

## 6. Witness Role in Verification

Witnesses don't have a separate "credential verification API." They participate through the standard KERI infrastructure:

### 6.1 Initialization — OOBI Resolution

**Source:** [`frontend/src/lib/keri/client.ts` — `initialize()`](../frontend/src/lib/keri/client.ts)

```typescript
const config = await client.config().get();
for (const iurl of config.iurls) {
    // Strip /controller suffix — need full witness OOBI
    const witnessOobi = iurl.replace(/\/controller$/, '');
    const op = await client.oobis().resolve(witnessOobi, alias);
    await client.operations().wait(op, { signal: AbortSignal.timeout(30000) });
}
```

KERIA agent config contains `iurls` (witness OOBI URLs). These are resolved at startup so KERIA can communicate with witnesses.

### 6.2 AID Creation with Witnesses

**Source:** [`frontend/src/lib/keri/client.ts` — `createAID()`](../frontend/src/lib/keri/client.ts)

```typescript
const op = await client.identifiers().create(name, {
    wits: [WITNESS_AID],  // witness AIDs
    toad: 1,              // threshold of accountable duplicity
});
await client.operations().wait(op, { signal: AbortSignal.timeout(180000) });
```

### 6.3 Witness Queries During Admit

The Admitter queries witnesses for the issuer's latest state before parsing:

```python
# Fetch issuer's KEL from their witnesses
self.witq.query(hab=self.agentHab, pre=issr)

# Fetch TEL events for this credential from witnesses
self.witq.telquery(hab=self.agentHab, pre=issr, ri=acdc["ri"], i=acdc["d"])
```

This ensures KERIA has the issuer's current key state and credential registry state before attempting verification. Without this, artifacts would be escrowed waiting for data.

---

## 7. IPEX Presentation Flow

IPEX (Issuance and Presentation Exchange) uses the same `/ipex/grant` message for both initial delivery and subsequent presentations.

### 7.1 Full Protocol (Optional Negotiation)

```
Verifier → Holder:  /ipex/apply   (request credential of schema X)
Holder → Verifier:  /ipex/offer   (offer to present)
Verifier → Holder:  /ipex/agree   (agree to receive)
Holder → Verifier:  /ipex/grant   (present the credential)
Verifier:           admits the grant → KERIA verifies
```

The apply/offer/agree steps are optional. A holder can send a grant directly.

**Source:** [`keripy/src/keri/vc/protocoling.py`](https://github.com/WebOfTrust/keripy/blob/main/src/keri/vc/protocoling.py) — defines the IPEX state machine and `PreviousRoutes` dictionary.

### 7.2 Grant for Presentation

The `IpexGrantArgs` interface requires `acdc`, `iss`, and `anc` as `Serder` objects:

**Source:** [`signify-ts/src/keri/app/credentialing.ts` — `IpexGrantArgs`](https://github.com/WebOfTrust/signify-ts/blob/main/src/keri/app/credentialing.ts)

```typescript
interface IpexGrantArgs {
    senderName: string;        // holder's AID name
    recipient: string;         // verifier's AID prefix
    message?: string;
    agreeSaid?: string;        // links to prior /ipex/agree if negotiated
    acdc: Serder;
    acdcAttachment?: string;   // override with pre-built CESR
    iss: Serder;
    issAttachment?: string;
    anc: Serder;
    ancAttachment?: string;
}
```

For presenting an **existing** credential (not freshly issued), you would:
1. Get the credential with CESR: `credentials().get(said, true)` — returns full proof chain
2. Use the `acdcAttachment`, `issAttachment`, `ancAttachment` string overrides, OR
3. Use `exchanges().createExchangeMessage()` directly with the `/ipex/grant` route and embed the CESR data

### 7.3 Verification on the Verifier's Side

The verifier's KERIA runs the same Admitter pipeline:
1. Receives the grant notification (`/exn/ipex/grant`)
2. Verifier's app calls `submitAdmit()`
3. Admitter queries issuer's witnesses for KEL/TEL
4. Parser verifies signatures, TEL state, schema, chains
5. Credential appears in verifier's `credentials().list()`
6. App checks `sad.a.i === presenter_AID` and `sad.i === expected_issuer`

---

## 8. Our Implementation

### 8.1 Credential Polling

**Source:** [`frontend/src/composables/useCredentialPolling.ts`](../frontend/src/composables/useCredentialPolling.ts)

Our polling loop runs every 5 seconds:

```typescript
// Filter for grant notifications
const grants = notifications.notes?.filter(
    (n: IPEXNotification) => n.a?.r === '/exn/ipex/grant' && !n.r
);

for (const grant of grants) {
    // Peek at schema to route membership vs endorsement
    const grantExn = await client.exchanges().get(grant.a.d);
    const grantSchema = grantExn.exn?.e?.acdc?.s || '';

    if (grantSchema === ENDORSEMENT_SCHEMA_SAID) {
        await admitGrant(grant);
        // poll for endorsement credential...
    } else {
        // Membership grant
        await admitGrant(grant);
        // poll for membership credential...
    }
}
```

### 8.2 Grant Admission

**Source:** [`frontend/src/composables/useCredentialPolling.ts` — `admitGrant()`](../frontend/src/composables/useCredentialPolling.ts)

```typescript
async function admitGrant(grant: IPEXNotification): Promise<void> {
    const grantExn = await client.exchanges().get(grant.a.d);
    const grantSender = grantExn.exn.i;
    const hab = await client.identifiers().get(aidName);

    // NOTE: Uses exchanges().createExchangeMessage(), NOT ipex().admit()
    const [admit, sigs, atc] = await client.exchanges().createExchangeMessage(
        hab, '/ipex/admit', { m: '' }, {}, grantSender, undefined, grant.a.d
    );
    await client.ipex().submitAdmit(aidName, admit, sigs, atc, [grantSender]);
    await client.notifications().mark(grant.i);
}
```

### 8.3 Credential Retrieval and Validation

**Source:** [`frontend/src/composables/useCredentialPolling.ts` — `pollForCredential()`](../frontend/src/composables/useCredentialPolling.ts)

```typescript
// credentials().list() returns ALL credentials KERIA knows about
const creds = await client.credentials().list();

// MUST filter — KERIA includes chained edge credentials
const sad = cred.sad || cred;
const recipient = sad.a?.i || '';
const schema = sad.s;

if (schema === MEMBERSHIP_SCHEMA_SAID && recipient === myAid) {
    // This is our membership credential
}
```

### 8.4 Issuer Verification

```typescript
// Check credential was issued by our org
if (sad.i === orgAid) {
    // Issued by the expected organization
}
```

---

## 9. signify-ts API Reference

### Verified Method Signatures

All verified against `frontend/node_modules/signify-ts/dist/`:

| Method | HTTP | Returns |
|--------|------|---------|
| `credentials().list(kargs?)` | `POST /credentials/query` | `Credential[]` |
| `credentials().get(said, includeCESR?)` | `GET /credentials/{said}` | JSON or CESR string |
| `credentials().issue(name, args)` | `POST /identifiers/{name}/credentials` | `{ acdc, iss, anc, op }` |
| `ipex().grant(args)` | — (creates message only) | `[Serder, string[], string]` |
| `ipex().submitGrant(name, exn, sigs, atc, recp)` | `POST /identifiers/{name}/ipex/grant` | JSON |
| `ipex().admit(args)` | — (creates message only) | `[Serder, string[], string]` |
| `ipex().submitAdmit(name, exn, sigs, atc, recp)` | `POST /identifiers/{name}/ipex/admit` | JSON |
| `notifications().list(start?, end?)` | `GET /notifications` | `{ start, end, total, notes }` |
| `notifications().mark(said)` | `PUT /notifications/{said}` | — |
| `notifications().delete(said)` | `DELETE /notifications/{said}` | — |
| `exchanges().get(said)` | `GET /exchanges/{said}` | Exchange message |
| `exchanges().createExchangeMessage(sender, route, payload, embeds, recp, dt?, dig?)` | — | `[Serder, string[], string]` |
| `oobis().resolve(oobi, alias?)` | `POST /oobis` | Operation |
| `operations().wait(op, opts?)` | polling `GET /operations/{name}` | resolved result |
| `identifiers().create(name, args)` | `POST /identifiers` | Operation |
| `config().get()` | `GET /config` | `{ iurls: string[] }` |

---

## 10. Common Pitfalls

| Mistake | Reality |
|---------|---------|
| `ipex().admit()` submits the admit | **Wrong** — it only creates the message. Must call `submitAdmit()` separately. |
| `notifications().mark(exchangeSaid)` | **Wrong** — takes `notification.i` (notification row ID), not `notification.a.d`. |
| `credentials().list()` returns only your credentials | **Wrong** — returns ALL credentials KERIA knows about, including chained edges. Must filter by `sad.a.i === myAid`. |
| `operations().wait(op, timeoutMs)` with a bare number | **Wrong** — requires `{ signal: AbortSignal.timeout(ms) }`. |
| Credential is available immediately after `submitAdmit()` | **Wrong** — the Admitter runs async. Poll `credentials().list()` for up to 15 seconds. |
| signify-ts verifies credentials client-side | **Wrong** — all cryptographic verification is done by KERIA server-side. signify-ts has zero ACDC verification logic. |

---

## Source Code References

### KERIA (Python agent)
- [ipexing.py — IPEX endpoints and sendAdmit()](https://github.com/WebOfTrust/keria/blob/main/src/keria/app/ipexing.py)
- [agenting.py — Admitter background Doer](https://github.com/WebOfTrust/keria/blob/main/src/keria/app/agenting.py)

### keripy (KERI core library)
- [vdr/verifying.py — Verifier.processCredential() and escrow handling](https://github.com/WebOfTrust/keripy/blob/main/src/keri/vdr/verifying.py)
- [vdr/credentialing.py — Registry and TEL management](https://github.com/WebOfTrust/keripy/blob/main/src/keri/vdr/credentialing.py)
- [vc/protocoling.py — IPEX protocol state machine](https://github.com/WebOfTrust/keripy/blob/main/src/keri/vc/protocoling.py)
- [core/parsing.py — Message parser and dispatch](https://github.com/WebOfTrust/keripy/blob/main/src/keri/core/parsing.py)

### signify-ts (TypeScript client)
- [credentialing.ts — Credentials, Ipex classes](https://github.com/WebOfTrust/signify-ts/blob/main/src/keri/app/credentialing.ts)
- [clienting.ts — SignifyClient, createSignedRequest()](https://github.com/WebOfTrust/signify-ts/blob/main/src/keri/app/clienting.ts)
- [exchanging.ts — Exchanges class](https://github.com/WebOfTrust/signify-ts/blob/main/src/keri/app/exchanging.ts)
- [contacting.ts — Challenges class](https://github.com/WebOfTrust/signify-ts/blob/main/src/keri/app/contacting.ts)

### Our codebase
- [frontend/src/composables/useCredentialPolling.ts](../frontend/src/composables/useCredentialPolling.ts)
- [frontend/src/components/onboarding/PendingApprovalScreen.vue](../frontend/src/components/onboarding/PendingApprovalScreen.vue)
- [frontend/src/lib/keri/client.ts](../frontend/src/lib/keri/client.ts)

