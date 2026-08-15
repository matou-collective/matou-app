# KERI-anchored action proofs (v1)

**Status:** writer-side implemented (issue #20, "Enforcement 5/5"). Peer-side
verifier deferred to land with #19 (Go KEL/TEL verifier per the 2026-08-13
maintainer ruling). Ported from the `agent/issue-20` design doc and rewritten
against the format actually shipped on `agent/issue-20-run3213`.

## Why

any-sync signatures prove *which sync account* wrote the bytes into a space
tree. They say nothing about the writer's **organizational role**, and any-sync
has no revocation concept — a modified peer that holds legitimate Writer
permission on the community space can forge a high-stakes transition and every
peer's SDK accepts it into the tree.

KERI already provides the missing layer for one case (credential issuance is
cryptographic — you must control the org AID/registry). This extends that
pattern to high-stakes **application** actions: each carries a KERI-verifiable
proof that any peer can check offline against synced/cached key state,
complementary to (not a replacement for) space ACLs.

## The two proof paths (maintainer ruling, 2026-08-10)

Split by action frequency:

| Action | Path | Rationale |
| --- | --- | --- |
| Member **role change** | **credential-backed (ACDC)** — every role change goes through `reissueMembershipCredential` (revoke old membership credential → issue new one for the new role → bind the new credential SAID onto the profile), TEL-anchored | rare; needs revocation + audit |
| Contribution **sign-off** | signed canonical message (`contribution_signoff`) | frequent — per-action ACDC issuance would put witness-receipting / TEL-propagation latency (~5.5 min observed) on every one |
| Contribution **reward** | signed canonical message (`contribution_reward`) | " |
| **Plan sign-off** (implementation plan, decision plan) | signed canonical message (`plan_signoff`) | " |
| **Project completion approval** | signed canonical message (`project_completion`) | " |

## The signed-message format (v1)

`frontend/src/lib/keri/actionProof.ts` is the **single source of truth** for
message construction; golden vectors in
`frontend/tests/scripts/action-proof.test.ts` pin the wire format. The Go
verifier (#19) must reconstruct the identical byte string — the `Proof` struct
in `backend/internal/contributions/proof.go` documents the layout on the Go
side until the verifier lands.

### Canonical message

Fixed five-line layout, newline-delimited:

```
matou-proof/v1
<action>
<subject>
<value>
<dt>
```

- Every field is required, non-empty, and **must not contain a newline**
  (enforced in `buildProofMessage`) — so the layout has fixed arity and is
  unambiguous by construction. There is no optional field whose omission could
  make two different field-tuples serialize identically.
- The version tag is **inside the signed bytes**, so a future v2 proof can
  never be cross-replayed as v1.
- `action` — one of the wire-stable literals `contribution_signoff`,
  `contribution_reward`, `plan_signoff`, `project_completion`.
- `subject` — the id of the object the action targets.
- `value` — the asserted target value (e.g. `signed_off`, `rewarded`,
  `completed`). Binding the value means a proof for one transition can never
  validate another (e.g. a submit-completion vs. approve-completion).
- `dt` — ISO-8601 UTC timestamp bound into the signed message.

> **The message is reconstructed, never parsed.** Verifiers rebuild the string
> from the object's own authoritative fields (not from a copy carried on the
> object) and verify `sig` over it — a valid signature can therefore never be
> lifted onto forged values.

### Proof envelope

Embedded on the object (`sign_off_proof` / `reward_proof` on contributions —
one field per proof-bearing transition so a reward never destroys the sign-off
proof — and `proof` on plans/projects, which have a single proof-bearing
transition):

| Key | Meaning |
| --- | --- |
| `v` | format tag `matou-proof/v1` |
| `action` / `subject` / `value` / `dt` | the signed fields (duplicated so the verifier knows exactly what was signed; it must check each against the object's authoritative field) |
| `aid` | signer AID prefix (the acting member's personal AID) |
| `sig` | qb64 CESR non-indexed (Cigar) signature over the canonical message bytes |

Signing is `keeper.sign` over the message bytes — local ed25519, no
witness/TEL round-trip, so it works offline whenever the wallet is unlocked.

### Verification path (lands with #19)

Per the 2026-08-13 ruling: a Go KEL/TEL verifier in the any-sync read layer,
built on #18's CESR/ed25519 primitives, deterministic and offline-capable
against synced/cached KEL+TEL state (read-only KERIA may bootstrap/refresh key
state). For each proof: reconstruct the message from the object's fields,
resolve the signer's key state **as of `dt`**, verify `sig`, and check the
signer holds a valid TEL-unrevoked org credential.

## Writer-side failure mode (current phase)

`signActionProof` returns `null` instead of throwing when signing is
impossible (no identity, no KERIA session, keystore error): nothing verifies
proofs yet, so a missing proof must not block the action. The gap is logged.
Once #19 lands, an object written without a valid proof is treated as invalid
by honest peers — exactly the intended enforcement.

## Known v1 limitations

- **`subject` is the local object id (`ctr_…`), not a content SAID** —
  contributions have no SAID. The proof attests "this AID asserted `value` for
  object `id` at `dt`" and nothing about the object's content; content-level
  attestations need SAIDified objects (future work).
- **Single-signature assumption.** The envelope carries no key index; the
  verifier resolves the signer's key state at `dt` and verifies against its
  keys. Multisig/threshold signing for group AIDs is out of scope for v1.
- **No proof on submit-completion.** Only the approval (`project_completion`,
  value `completed`) is proof-bearing; the lower-privilege submit transition is
  gated by RBAC (#17) but carries no digest.
- **Verification is entirely deferred** — until #19, proofs are persisted
  verbatim and unchecked (the backend does cheap consistency checks only).
