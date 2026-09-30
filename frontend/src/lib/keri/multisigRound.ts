export type MultisigRotRound = 'round-1' | 'round-2' | 'unknown';

interface ExnLike {
  a?: { smids?: unknown; rmids?: unknown; round?: unknown } | undefined;
}

/**
 * Classify a /multisig/rot EXN's rotation ROUND.
 *
 * The round is a property of the group rotation itself, not of the recipient:
 *   round-1 pre-rotates the joining member into next-keys (rmids) only;
 *   round-2 promotes them into the signing set (smids).
 *
 * Prefer the explicit `a.round` the sender now stamps into the payload (see
 * `sendMultisigRotExn`). Fall back to inferring the round from smids/rmids for
 * EXNs sent by older clients that predate the explicit field — but that
 * inference is only correct for the JOINING member. An existing co-signer is
 * listed in BOTH rounds' smids, so the smids-membership inference misclassifies
 * an existing co-signer's round-1 notification as round-2 (issue #520). Callers
 * must therefore decide "co-sign vs. joining-member action" by membership
 * (am I already a signer of this group?), never by the round alone.
 */
export function classifyMultisigRot(exn: ExnLike, myPrefix: string): MultisigRotRound {
  const explicit = exn?.a?.round;
  if (explicit === 'round-1' || explicit === 'round-2') return explicit;

  const smids = Array.isArray(exn?.a?.smids) ? (exn.a!.smids as string[]) : undefined;
  const rmids = Array.isArray(exn?.a?.rmids) ? (exn.a!.rmids as string[]) : undefined;
  if (!smids || !rmids) return 'unknown';
  if (smids.includes(myPrefix)) return 'round-2';
  if (rmids.includes(myPrefix)) return 'round-1';
  return 'unknown';
}

/**
 * Admin is by convention the first entry in smids of a /multisig/rot EXN.
 * Returns undefined when the payload is malformed.
 */
export function adminPrefixFromExn(exn: ExnLike): string | undefined {
  const smids = Array.isArray(exn?.a?.smids) ? (exn.a!.smids as string[]) : undefined;
  return smids?.[0];
}

/** The promotion's initiator is by convention smids[0]; a co-signer's forwarded /multisig/rot has another sender. */
export function isInitiatorExn(exn: { i?: string; a?: { smids?: unknown } }): boolean {
  const smids = Array.isArray(exn?.a?.smids) ? (exn.a!.smids as string[]) : [];
  return !!exn?.i && exn.i === smids[0];
}

export function rotationSaidOf(exn: { e?: { rot?: { d?: string } } }): string | undefined {
  return exn?.e?.rot?.d;
}

/**
 * The joining member rotates its personal AID ONCE per proposed group
 * rotation — on the initiator's exn only. A co-signer forwards the same
 * proposal (d29ab75); treating that as a new round 1 rotated member2 three
 * times while round 2 committed its first new key (e2e test 5, 2026-09-30).
 */
export function shouldRotateForRound1(
  exn: { i?: string; a?: { smids?: unknown }; e?: { rot?: { d?: string } } },
  handled: Set<string>,
): { rotate: boolean; said?: string } {
  const said = rotationSaidOf(exn);
  if (!said || handled.has(said) || !isInitiatorExn(exn)) return { rotate: false, said };
  return { rotate: true, said };
}
