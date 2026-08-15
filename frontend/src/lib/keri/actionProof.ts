/**
 * Canonical proof format for KERI-anchored high-stakes actions (issue #20).
 *
 * any-sync signatures only prove *which sync account* wrote the bytes; they say
 * nothing about organizational role, and any-sync has no revocation concept.
 * High-stakes application objects therefore carry a signed proof so any honest
 * peer can verify the action was authorised by an AID that (a) actually signed
 * it and (b) holds a valid, unrevoked org credential.
 *
 * This module is the SINGLE SOURCE OF TRUTH for how the signed message is
 * constructed. The peer-side verifier (Go, landing with #19) MUST reconstruct
 * the identical byte string from the object's OWN fields and verify `sig`
 * against the signer AID's KEL key state at signing time. The golden vectors in
 * tests/scripts/action-proof.test.ts pin the wire format — keep the two sides
 * in lockstep.
 *
 * Scope (per the 2026-08-10 maintainer ruling): sign-offs, rewards and
 * completion approvals use this signed-digest path. Member ROLE changes do NOT
 * use this path — they are credential-backed (ACDC revoke/re-issue), which
 * gets TEL-anchored revocation and audit for free.
 */

/** Wire-format tag. Bump the version suffix on any breaking layout change. */
export const PROOF_VERSION = 'matou-proof/v1';

/**
 * The high-stakes actions covered by the signed-digest proof path. The string
 * value is part of the signed message, so these constants are wire-stable.
 */
export type ProofAction =
  | 'contribution_signoff'
  | 'contribution_reward'
  | 'plan_signoff'
  | 'project_completion';

export interface ActionProofInput {
  /** Which high-stakes action is being asserted. */
  action: ProofAction;
  /** Stable identifier of the object being acted on (SAID / object id). */
  subject: string;
  /**
   * any-sync space id the object lives in. Bound into the signed message so a
   * proof can never be replayed onto a same-id object in another space.
   */
  space: string;
  /** The target value the action asserts (e.g. the new status). */
  value: string;
  /** RFC3339 / ISO-8601 UTC timestamp bound into the signed message. */
  dt: string;
}

/**
 * The proof envelope embedded on the object. Every field except `sig` is also
 * derivable from the object itself; they are duplicated here only so the
 * verifier knows exactly which values were signed. The verifier MUST check each
 * one against the object's authoritative field before trusting the signature.
 */
export interface ActionProof extends ActionProofInput {
  /** Format tag; always {@link PROOF_VERSION} for proofs written by this code. */
  v: typeof PROOF_VERSION;
  /** Signer AID prefix (the acting steward's personal AID). */
  aid: string;
  /** qb64 CESR non-indexed signature (Cigar) over the canonical message bytes. */
  sig: string;
}

const FIELD_ORDER: (keyof ActionProofInput)[] = ['action', 'subject', 'space', 'value', 'dt'];

/**
 * Build the canonical message that gets signed. Deterministic and trivially
 * reproducible in any language: the version tag followed by action, subject,
 * space, value and timestamp, each on its own line. None of these fields may contain a
 * newline (enforced below), so the layout is unambiguous.
 *
 * IMPORTANT for verifiers: do NOT trust a copy of this string carried on the
 * object. Rebuild it from the object's own authoritative fields, otherwise a
 * valid signature could be lifted onto forged values.
 */
export function buildProofMessage(input: ActionProofInput): string {
  for (const key of FIELD_ORDER) {
    const val = input[key];
    if (typeof val !== 'string' || val.length === 0) {
      throw new Error(`actionProof: field "${key}" must be a non-empty string`);
    }
    if (val.includes('\n') || val.includes('\r')) {
      throw new Error(`actionProof: field "${key}" must not contain a line break`);
    }
  }
  return [PROOF_VERSION, input.action, input.subject, input.space, input.value, input.dt].join('\n');
}

/** UTF-8 bytes of the canonical message — exactly what gets signed/verified. */
export function proofMessageBytes(input: ActionProofInput): Uint8Array {
  return new TextEncoder().encode(buildProofMessage(input));
}

/**
 * Assemble a complete proof envelope from the signed input, signer AID and the
 * qb64 signature produced over {@link proofMessageBytes}.
 */
export function makeActionProof(
  input: ActionProofInput,
  aid: string,
  sig: string,
): ActionProof {
  if (!aid) throw new Error('actionProof: signer aid is required');
  if (!sig) throw new Error('actionProof: signature is required');
  // Re-validate the input fields so a malformed envelope can never be built.
  buildProofMessage(input);
  return { v: PROOF_VERSION, ...input, aid, sig };
}
