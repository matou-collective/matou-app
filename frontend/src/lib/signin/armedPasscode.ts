/**
 * The armed-consent registry for the control-panel passcode handover (ADR 0282
 * d.2/d.6 + its armed-consent amendment; matou-app #674, idss #1957).
 *
 * #663 sealed the steward's passcode ONCE at approve, to the verkey that rode the
 * sign-in code (`ek=`). But that key belongs to the sign-in bridge's door page at
 * `id.<apex>`, which the OIDC hop tears down; the control panel at `admin.<apex>`
 * never minted it and cannot open the box, so the handover never completes for
 * the surface it exists for. Armed consent (Ben's 2026-09-28 ruling: it stays
 * sign-in-armed, one tap, no second scan) fixes the shape: one Approve with the
 * unlock line on ARMS this wallet for that one sign-in challenge — it keeps the
 * passcode ready to seal, for the challenge's life — and it SEALS only when the
 * panel later asks, to the verkey the panel actually holds.
 *
 * This module is that in-memory arming, mirroring signer.ts. Nothing is
 * persisted; the passcode itself is NEVER stored here — the {@link PasscodeSealer}
 * captured at arm time reads it live from the unlocked identity store at seal
 * time and lets only the ciphertext out. The whole registry is dropped on
 * lock/exit via {@link clearArming} from the identity store, so an arming never
 * outlives the wallet's own unlocked session. The seam is proven directly by
 * tests/scripts/armed-passcode.test.ts; the transport that carries the panel's
 * later request (the door routes and the panel port) is idss #1957, out of scope
 * here — this module answers a request, it does not define how one arrives.
 */

/**
 * Seals the steward's live passcode to a verkey, returning the CESR qb64 cipher,
 * or null when there is nothing to seal (a locked seat has no passcode). It reads
 * the passcode LIVE at call time — never a value captured at arm — so a wallet
 * locked between approve and the request yields null.
 */
export type PasscodeSealer = (sealingVerkey: string) => Promise<string | null>;

interface Arming {
  /** Wall-clock ms after which this arming is dead; 0 means no expiry. */
  expiresAt: number;
  /** Seals the live passcode to the verkey the panel holds when it asks. */
  seal: PasscodeSealer;
}

/** challenge id → its live arming. At most one per challenge; single-use. */
const armings = new Map<string, Arming>();

/**
 * Arm the wallet to seal the steward's passcode when the panel later asks for
 * this one challenge. Seals nothing itself and replaces any existing arming for
 * the same challenge. `expiresAt` is wall-clock ms (0 for no expiry). A blank
 * challenge arms nothing.
 */
export function armForChallenge(challenge: string, expiresAt: number, seal: PasscodeSealer): void {
  if (!challenge) return;
  armings.set(challenge, { expiresAt, seal });
}

/**
 * True when a live (unexpired) arming exists for this challenge. An expired
 * arming is discarded as a side-effect of the check, so a dead challenge never
 * reads as armed.
 */
export function isArmed(challenge: string, now: number = Date.now()): boolean {
  const arming = armings.get(challenge);
  if (!arming) return false;
  if (arming.expiresAt !== 0 && arming.expiresAt <= now) {
    armings.delete(challenge);
    return false;
  }
  return true;
}

/**
 * Seal the armed passcode to the verkey the panel holds and return the CESR qb64
 * cipher ONCE. The arming is consumed on the first request (single-use), so a
 * second request for the same challenge — or a request against no arming, an
 * expired arming, or an empty verkey — seals nothing and returns null. An expired
 * arming is discarded without sealing. Nothing but the ciphertext ever leaves:
 * the passcode is read live by the sealer, so a wallet locked since arming (its
 * passcode gone, or the whole registry already {@link clearArming}'d) yields
 * null too.
 */
export async function sealForRequest(
  challenge: string,
  sealingVerkey: string,
  now: number = Date.now(),
): Promise<string | null> {
  const arming = armings.get(challenge);
  if (!arming) return null;
  // Consume first: a concurrent or repeat request for this challenge then finds
  // nothing, so the box is minted at most once.
  armings.delete(challenge);
  if (arming.expiresAt !== 0 && arming.expiresAt <= now) return null;
  if (!sealingVerkey) return null;
  return arming.seal(sealingVerkey);
}

/** Drop every arming — called on lock/logout so nothing survives the session. */
export function clearArming(): void {
  armings.clear();
}
