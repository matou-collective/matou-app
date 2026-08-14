/**
 * Composable for attaching KERI-verifiable proofs to high-stakes actions
 * (issue #20, "Enforcement 5/5").
 *
 * The acting steward's signify-ts wallet signs a canonical digest of the action
 * (see `src/lib/keri/actionProof.ts`) and the resulting envelope is embedded on
 * the object the action produces. Peers verify the proof independently (#19's
 * deferred verifier) — a sign-off/reward/role-change/completion without a valid
 * proof from a currently-credentialed AID is treated as illegitimate.
 *
 * Two entry points:
 * - `createProof` throws if the wallet can't sign (use when the proof is
 *   mandatory for the flow).
 * - `tryCreateProof` never throws — it returns `undefined` and logs a warning
 *   on failure, so an unsignable environment degrades gracefully rather than
 *   blocking the user's action. The writer-side PR uses this: the peer-side
 *   verifier that makes proofs load-bearing lands with #19, so until then a
 *   missing proof must not regress existing flows.
 */
import { useKERIClient } from 'src/lib/keri/client';
import { useIdentityStore } from 'stores/identity';
import {
  signActionProof,
  type ActionProof,
  type ProofAction,
} from 'src/lib/keri/actionProof';

export function useActionProof() {
  const keriClient = useKERIClient();
  const identityStore = useIdentityStore();

  /**
   * Sign and return the proof envelope for `action` on `subject`. Throws if
   * there is no active identity or the wallet fails to sign.
   */
  async function createProof(
    action: ProofAction,
    subject: string,
    opts?: { dt?: string; context?: string },
  ): Promise<ActionProof> {
    const aid = identityStore.currentAID;
    if (!aid?.name) {
      throw new Error('Cannot create action proof: no active identity');
    }
    const name = aid.name;
    return signActionProof(
      (digest) => keriClient.signDigest(name, digest),
      action,
      subject,
      opts,
    );
  }

  /**
   * Best-effort variant: returns the proof envelope, or `undefined` if signing
   * is unavailable/failed (logged, non-fatal).
   */
  async function tryCreateProof(
    action: ProofAction,
    subject: string,
    opts?: { dt?: string; context?: string },
  ): Promise<ActionProof | undefined> {
    try {
      return await createProof(action, subject, opts);
    } catch (err) {
      console.warn(`[ActionProof] Could not sign ${action} for ${subject} (non-fatal):`, err);
      return undefined;
    }
  }

  return { createProof, tryCreateProof };
}
