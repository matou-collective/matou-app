/**
 * Shared canonical-digest proof format for high-stakes application actions.
 *
 * Issue #20 ("Enforcement 5/5"). any-sync signatures only prove *which sync
 * account* wrote the bytes — they say nothing about organizational role, and
 * any-sync has no revocation concept. This module defines a KERI-verifiable
 * proof that any peer can check: the acting AID's signify-ts wallet signs a
 * canonical digest of the action (e.g. `contribution.sign_off:<said>:<dt>`),
 * and the detached signature + key-state reference is embedded in the object.
 *
 * This is the WRITER side only. The peer-side verifier (deterministic,
 * offline-capable against synced/cached KEL+TEL) is deferred to land with #19
 * — see the Go mirror `backend/internal/keri/actionproof.go`, which keeps the
 * canonical-digest construction byte-identical across languages (golden test
 * vectors are shared between `action-proof.test.ts` and `actionproof_test.go`).
 *
 * IMPORTANT: the canonical digest is *reconstructed* from the envelope's
 * structured fields by the verifier — it is never parsed by splitting on `:`.
 * Timestamps contain colons, so a `:`-split would be ambiguous; joining is
 * deterministic, splitting is not. Verifiers rebuild the string via
 * {@link canonicalDigest} from `action`/`subject`/`context`/`dt` and check the
 * signature over it.
 */

/** Version tag stamped into every proof envelope. Bump on any format change. */
export const PROOF_VERSION = 'MATOU-PROOF-v1';

/**
 * The high-stakes actions that carry a proof. The 2026-08-10 maintainer ruling
 * splits these by frequency: role changes are additionally credential-backed
 * (ACDC revoke/re-issue, item 3), while sign-offs/rewards/completions rely on
 * the signed digest alone (frequent actions can't absorb per-action TEL
 * propagation latency).
 */
export type ProofAction =
  | 'contribution.sign_off'
  | 'contribution.reward'
  | 'plan.sign_off'
  | 'project.completion_approval'
  | 'member.role_change';

/**
 * Raw signing result from the wallet — mirrors {@link KERIClient.signDigest}.
 * Kept here (rather than in client.ts) so this module stays free of the heavy
 * client import and is trivially unit-testable with a stub signer.
 */
export interface SignedDigest {
  /** AID prefix that produced the signature. */
  aid: string;
  /** Index into the key-state `k` array that this signature corresponds to. */
  keyIndex: number;
  /** qb64 public key used (key state `k[keyIndex]`), captured at signing time. */
  verferQb64: string;
  /** Key-state sequence number (hex `s`) at signing time — lets a verifier
   *  resolve the correct KEL point even after later rotations. */
  sequence: string;
  /** qb64 detached (Cigar) signature over the canonical digest. */
  signature: string;
}

/** A signer over canonical digest bytes — supplied by the KERI client wrapper. */
export type DigestSigner = (data: string) => Promise<SignedDigest>;

/**
 * The proof envelope embedded on a high-stakes object. Field names are short
 * because this rides on every synced object; the Go mirror uses identical JSON
 * tags.
 */
export interface ActionProof {
  /** Format version — {@link PROOF_VERSION}. */
  v: string;
  /** Which action this proof attests. */
  action: ProofAction;
  /** The subject the action targets (contribution/plan/project id or member AID). */
  subject: string;
  /** Optional extra term bound into the digest (e.g. the new role, reward id). */
  context?: string;
  /** ISO-8601 timestamp; part of the signed digest (binds the proof to a time). */
  dt: string;
  /** Acting AID prefix (the signer). */
  aid: string;
  /** Key index into the signer's key state `k` array. */
  ki: number;
  /** Signer key-state sequence number (hex) at signing time. */
  s: string;
  /** qb64 detached signature over {@link canonicalDigest}. */
  sig: string;
}

/**
 * Build the canonical string that gets signed. Deterministic and delimiter
 * (`:`) joined to match the issue's stated `sign_off:<said>:<timestamp>` form.
 * The `context` term is only included when non-empty, so a proof without extra
 * context reproduces exactly the three-part form.
 *
 * Components (action, subject, context) are colon-free by construction (AID
 * prefixes and SAIDs are base64url; actions are fixed literals). The timestamp
 * DOES contain colons — which is why verifiers reconstruct via this function
 * rather than splitting the result.
 */
export function canonicalDigest(
  action: ProofAction,
  subject: string,
  dt: string,
  context?: string,
): string {
  const parts =
    context !== undefined && context !== ''
      ? [action, subject, context, dt]
      : [action, subject, dt];
  return parts.join(':');
}

/**
 * Sign a high-stakes action and return the embeddable proof envelope.
 *
 * @param sign    a {@link DigestSigner} — e.g. `(d) => keriClient.signDigest(aidName, d)`
 * @param action  the action being attested
 * @param subject the target id/said/AID
 * @param opts.dt      override timestamp (defaults to now); use to bind the
 *                     proof to the same timestamp written elsewhere on the object
 * @param opts.context optional extra term bound into the digest
 */
export async function signActionProof(
  sign: DigestSigner,
  action: ProofAction,
  subject: string,
  opts?: { dt?: string; context?: string },
): Promise<ActionProof> {
  const dt = opts?.dt ?? new Date().toISOString();
  const context = opts?.context;
  const digest = canonicalDigest(action, subject, dt, context);
  const signed = await sign(digest);
  const proof: ActionProof = {
    v: PROOF_VERSION,
    action,
    subject,
    dt,
    aid: signed.aid,
    ki: signed.keyIndex,
    s: signed.sequence,
    sig: signed.signature,
  };
  if (context !== undefined && context !== '') proof.context = context;
  return proof;
}
