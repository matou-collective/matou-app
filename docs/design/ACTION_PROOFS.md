# KERI-anchored action proofs (v1)

**Status:** writer-side implemented (issue #20, "Enforcement 5/5"). Peer-side
verifier deferred to land with [#19](https://github.com/matou-collective/matou-app/issues/8).

## Why

any-sync signatures prove *which sync account* wrote the bytes into a space
tree. They say nothing about the writer's **organizational role**, and any-sync
has no revocation concept — a modified peer that holds legitimate Writer
permission on the community space can forge a high-stakes transition and every
peer's SDK accepts it into the tree.

KERI already provides the missing layer for one case (credential issuance is
cryptographic — you must control the org AID/registry). This extends that
pattern to high-stakes **application** actions: each carries a
KERI-verifiable proof that any peer can check offline against synced/cached key
state, complementary to (not a replacement for) space ACLs.

## The two proof paths (maintainer ruling, 2026-08-10)

Split by action frequency:

| Action | Path | Rationale |
| --- | --- | --- |
| Member **role change** | **credential-backed (ACDC)** — the profile `role` change ships with a membership-credential revoke/re-issue, TEL-anchored | rare; needs revocation + audit |
| Contribution **sign-off** | signed canonical digest | frequent — per-action ACDC issuance would put witness-receipting / TEL-propagation latency (~5.5 min observed) on every one |
| Contribution **reward** | signed canonical digest | " |
| **Plan sign-off** (implementation plan) | signed canonical digest | " |
| **Project completion** (submit + approve) | signed canonical digest | " |

Role changes additionally carry the signed digest (defense-in-depth); see the
writer path below.

## The signed-digest format (v1)

The acting AID's signify-ts wallet signs a **canonical digest string** and the
detached signature + key-state reference is embedded on the object as a `proof`
envelope.

### Canonical digest

```
<action>:<subject>[:<context>]:<dt>
```

- `action` — one of the fixed literals (`contribution.sign_off`,
  `contribution.reward`, `plan.sign_off`, `project.completion_approval`,
  `member.role_change`).
- `subject` — the object the action targets (contribution / plan / project id,
  or the member AID for a role change).
- `context` — optional extra term bound into the digest (e.g. the new role on a
  role change). **Omitted entirely when empty** — a proof without context
  reproduces exactly the three-part `action:subject:dt` form.
- `dt` — ISO-8601 timestamp; binds the proof to a time.

> **The digest is reconstructed, never parsed.** `dt` contains colons, so
> splitting on `:` is ambiguous. Verifiers rebuild the string from the
> envelope's structured fields with the shared `canonicalDigest` /
> `CanonicalDigest` builder, then verify the signature over it.

### Proof envelope

Embedded as the object's `proof` field. Short keys because it rides on every
synced object:

| Key | Meaning |
| --- | --- |
| `v` | format version — `MATOU-PROOF-v1` |
| `action` | the attested action |
| `subject` | target id / said / AID |
| `context` | optional extra digest term (omitted when empty) |
| `dt` | ISO-8601 timestamp (part of the digest) |
| `aid` | acting AID prefix (the signer) |
| `ki` | key index into the signer's key-state `k` array |
| `s` | signer key-state sequence number (hex) at signing time |
| `sig` | qb64 detached (Cigar) signature over the canonical digest |

The signature is a **non-indexed Cigar** (detached), not a KEL/TEL
establishment-event signature. `ki`/`s` let a verifier resolve the correct key
state point even after later rotations.

## Shared implementation (locked cross-language)

The canonical-digest builder and envelope shape are mirrored so the signer and
the (future) verifier reconstruct byte-identical digests:

- **Frontend (signer):** `frontend/src/lib/keri/actionProof.ts` +
  `frontend/src/composables/useActionProof.ts`. Signing primitive:
  `KERIClient.signDigest(aidName, data)` in `frontend/src/lib/keri/client.ts`.
- **Backend (format mirror):** `backend/internal/keri/actionproof.go`.
- **Golden vectors** are shared byte-for-byte between
  `frontend/tests/scripts/action-proof.test.ts` and
  `backend/internal/keri/actionproof_test.go`. Change one → change both.

## Writer path (this PR)

- Frontend stores/composables build a **best-effort** proof
  (`useActionProof().tryCreateProof(...)`) at action time and send it in the
  action's POST body. Best-effort because the peer-side verifier that makes
  proofs load-bearing is deferred — until it lands, an unsignable environment
  must not block the user's action.
- Backend action handlers accept an optional `{"proof": {...}}` and persist it
  **opaquely** on the object (`Contribution.Proof`, `Project.Proof`,
  `ImplementationPlan.Proof`). The backend does **not** verify — verification is
  the peer's job.

## Verifier path (deferred, decision (a) — 2026-08-13)

Not in this PR. A minimal CESR + ed25519 + KEL/TEL verifier in Go (building on
#18's primitives), landing with #19. It must:

1. Resolve the actor's key state at the proof's `s`, and check `sig` over the
   reconstructed canonical digest with `k[ki]`.
2. Confirm the actor holds a valid, **TEL-unrevoked** org credential.
3. Be **deterministic and offline-capable** against synced/cached KEL+TEL —
   peers in a P2P protocol must judge validity without phoning home.

Until then, no acceptance criterion of #20 is verifiable (there is no verifier
to reject an unproven object); this PR lays the forward-compatible writer half.
