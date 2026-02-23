# KERIA Per-Agent Credential Store Isolation

**Date:** 2026-02-20
**Status:** Investigated, workaround applied. Root cause is in KERIA/keripy.
**KERIA version:** v0.2.0rc1 | **keripy version:** v1.2.2

## Summary

When a credential is received via IPEX grant+admit, KERIA stores it in the
recipient agent's `reger.creds` database (visible via `GET /credentials/query`)
but does **not** submit it to the recipient agent's verifier. This means the
credential is never placed in `reger.saved`, which is the store used by the
verifier for edge chain verification.

As a result, any credential issued by the receiving agent that references the
received credential via an edge will fail chain verification permanently,
generating `MissingChainError` at ~12 retries/second for up to 1 hour.

## Affected Credential Types

| Credential | Edge Field | References |
|---|---|---|
| Endorsement (`EIefou...`) | `e.endorserMembership` | Endorser's membership credential |
| Event Attendance (`ELhtm...`) | `e.hostMembership` | Host's membership credential |

Both schemas define `"e"` as optional (not in `required` array), which allowed
a workaround of omitting edge data during issuance.

## Architecture Context

```
Org AID Agent (matou-community)          Admin Personal AID Agent (admin-user)
  reger.creds: [membership cred]           reger.creds: [membership cred]  <-- visible via API
  reger.saved: [membership cred]           reger.saved: []                 <-- EMPTY, verifier can't see it
                                           reger.mce:   [endorsement]      <-- stuck in escrow
```

- **Org AID** issues membership credentials (via `POST /identifiers/{org-name}/credentials`)
- **Admin's personal AID** issues endorsements and event attendance credentials
- KERIA maintains **separate databases per agent** at `/usr/local/var/keri/reg/agent-{prefix}/`

## Root Cause Chain

### 1. IPEX Grant Reception Has No Behavior Handler

When the admin-user agent receives an `/ipex/grant` message, KERIA logs:

```
Behavior for /ipex/grant missing or does not have verify for said=...
Behavior for /ipex/grant missing or does not have handle for said=...
```

This means KERIA does not register an exchange behavior for `/ipex/grant` on the
recipient side. The credential data from the grant is stored in `reger.creds`
(for API access) but is never submitted to the verifier.

### 2. Two Separate Credential Stores

In `keri/vdr/credentialing.py`, `Reger.__init__` defines (via `reopen()`):

```python
self.creds = subing.SerderSuber(db=self, subkey="creds.", klas=serdering.SerderACDC)
self.saved = subing.CesrSuber(db=self, subkey='saved.', klas=coring.Saider)
```

- **`reger.creds`** — Raw credential storage. Populated when credentials are
  created or received. Used by `cloneCreds()` which powers `GET /credentials/query`.
- **`reger.saved`** — Verified credential index. Populated ONLY after the verifier's
  `processCredential()` succeeds completely. Used by `verifyChain()` for edge validation.

### 3. Verifier Chain Check Fails

When the admin issues an endorsement with an edge referencing the membership
credential, the verifier calls `verifyChain()`:

```python
# keri/vdr/verifying.py, line ~317-361
def verifyChain(self, nodeSaid, op, issuer):
    state = self.reger.saved.get(keys=nodeSaid)  # <-- checks reger.saved, NOT reger.creds
    if state is None:
        return None  # triggers MissingChainError
```

Since the membership credential was never verified by the admin agent's verifier,
`reger.saved` is empty for that SAID, and `verifyChain()` returns `None`.

### 4. MissingChainError Escrow Loop

```python
# keri/vdr/verifying.py, line ~160-164
state = self.verifyChain(nodeSaid, op, creder.issuer)
if state is None:
    self.escrowMCE(creder, prefixer, seqner, saider)
    self.cues.append(dict(kin="proof", said=nodeSaid))
    raise kering.MissingChainError(...)
```

The credential goes into MCE (Missing Chain Error) escrow.

### 5. Escrow Retries Indefinitely (Up to 1 Hour)

```python
# keri/vdr/verifying.py
TimeoutMRI = 3600  # 1 hour timeout

# keri/vc/walleting.py, lines 92-96
def escrowDo(self, tymth, tock=0.0):
    while True:
        self.verifier.processEscrows()
        yield self.tock  # tock=0.0 means run every event loop tick
```

The escrow processing runs in a tight `while True: yield` loop with `tock=0.0`
(every event loop tick). Each iteration retries ALL MCE entries. Measured rate:
~12 retries/second per credential.

### 6. "proof" Cue Is Never Handled

When chain verification fails, the verifier emits a `"proof"` cue:

```python
self.cues.append(dict(kin="proof", said=nodeSaid))
```

However, **no handler exists** for this cue in either keripy or KERIA. In
`keri/vc/walleting.py:verifierDo()`, only these cues are handled:

- `"saved"` — credential saved successfully
- `"query"` — need to query KEL
- `"telquery"` — need to query TEL

The `"proof"` cue is silently discarded. If a handler existed, it could trigger
a query to fetch the missing credential from the issuer.

### 7. Credential Operation Never Completes

```python
# keria/src/keria/app/credentialing.py
def complete(self, said):
    return self.rgy.reger.ccrd.get(keys=(said,)) is not None

# reger.ccrd is populated by processCredentialMissingSigEscrow():
def processCredentialMissingSigEscrow(self):
    creder = self.reger.saved.get(keys=said)  # <-- requires reger.saved
    if creder is not None:
        self.reger.ccrd.put(...)  # <-- only then does ccrd get populated
```

The `complete()` check in the long-running operation monitor requires
`reger.ccrd`, which requires `reger.saved`, which is never populated.
So `operations().wait()` polls until it times out (60 seconds in our client).

## Production Impact

**Severity: Medium-High**

- Each credential stuck in MCE generates ~12 `MissingChainError` per second
- With multiple stale credentials, this can reach thousands of errors per minute
- MCE timeout is 1 hour (`TimeoutMRI = 3600`), so stale entries persist
- `escrowMCE()` uses `Suber.put()` with `overwrite=False`, so the timestamp
  is preserved from initial escrow (entries DO eventually time out)
- Multiple doers run `processEscrows()` concurrently (`walleting.py:escrowDo`
  and `indirecting.py`), multiplying the retry rate

In the test environment, 14 stale credentials from previous test runs generated
~2000 `MissingChainError`/minute for over an hour.

## Workaround Applied

**Commit:** (pending) on `event-credentials` branch

Removed edge data from endorsement and event attendance credential issuance.
Both schemas allow `"e"` to be optional. The membership check is preserved
via `client.credentials().list()` (which reads from `reger.creds`).

**Files changed:**

- `frontend/src/composables/useEndorsements.ts` — Removed `edgeData` from
  `issueCredential()` call. Still verifies endorser has membership credential
  via API before issuing.
- `frontend/src/composables/useEventAttendance.ts` — Same change for event
  attendance credentials.

## Potential Future Fixes

### Option 1: KERIA Fix — Register /ipex/grant Behavior on Recipient

Register a behavior handler for `/ipex/grant` on the recipient agent that
submits the received credential to the agent's verifier, populating
`reger.saved`. This would be the proper fix at the infrastructure level.

### Option 2: KERIA Fix — Handle "proof" Cue

Add a handler for the `"proof"` cue in `walleting.py:verifierDo()` that
triggers a query to fetch the missing chain credential from the issuer or
from the local credential store (`reger.creds`). This could be as simple as:

```python
if cue["kin"] == "proof":
    said = cue["said"]
    # Check if credential exists in creds but not in saved
    creder = self.reger.creds.get(keys=(said,))
    if creder is not None:
        # Re-submit to verifier for full verification
        self.verifier.processCredential(creder, ...)
```

### Option 3: Application Fix — Issue from Org AID

Issue endorsements from the org AID instead of personal AIDs. The org agent
already has the membership credential in its `reger.saved` (since it issued it).
However, this changes the semantics (endorsements come from the organization,
not individual members).

### Option 4: Application Fix — Pre-verify Received Credentials

After receiving a credential via IPEX, explicitly call
`POST /credentials/verify` to submit it to the agent's verifier. This would
populate `reger.saved` without requiring KERIA changes. Needs investigation
to confirm the `/credentials/verify` endpoint populates `reger.saved`.

### Option 5: Re-enable Edges When KERIA Is Fixed

Keep the schema definitions with edge support. When a future version of KERIA
properly handles received credentials in `reger.saved`, re-add edge data to
the `issueCredential()` calls. The schema is already forward-compatible.

## Key KERIA/keripy Source Locations

| Component | File | Lines | Purpose |
|---|---|---|---|
| Chain verification | `keri/vdr/verifying.py` | 317-361 | `verifyChain()` checks `reger.saved` |
| MCE escrow | `keri/vdr/verifying.py` | 198-212 | `escrowMCE()` stores failed creds |
| Escrow processing | `keri/vdr/verifying.py` | 230-290 | `processEscrows()` / `_processEscrow()` |
| Escrow runner | `keri/vc/walleting.py` | 92-96 | `escrowDo()` tight loop |
| Cue handler | `keri/vc/walleting.py` | 113-114 | `verifierDo()` — missing "proof" handler |
| Credential stores | `keri/vdr/credentialing.py` | `reopen()` | `creds`, `saved`, `ccrd` definitions |
| Operation completion | `keria/app/credentialing.py` | 878-879 | `complete()` checks `reger.ccrd` |
| IPEX admit handler | `keria/app/agenting.py` | 724-770 | `Admitter` class (issuer-side only) |
| Credential query API | `keria/app/credentialing.py` | 485-565 | `POST /credentials/query` reads `reger.creds` |

## Reproduction Steps

1. Clean test KERI infrastructure: `cd matou-infrastructure/keri && make clean-test`
2. Clean frontend test data: `cd frontend && scripts/clean-test.sh`
3. Run org-setup E2E test (creates org AID + admin personal AID + membership credential)
4. Run registration E2E test — endorsement step will timeout at 60s
5. Check KERIA logs: `docker logs matou-keri-test-keria-1 2>&1 | grep MissingChainError`
