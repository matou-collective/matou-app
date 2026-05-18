export type MultisigRotRound = 'round-1' | 'round-2' | 'unknown';

interface ExnLike {
  a?: { smids?: unknown; rmids?: unknown } | undefined;
}

/**
 * Classify a /multisig/rot EXN from this member's perspective.
 *
 * round-1: member is in rmids only -> need to rotate own personal hab.
 * round-2: member is in smids       -> need to sign the rotation (joinGroup).
 * unknown: malformed payload, or this notification isn't addressed to us.
 */
export function classifyMultisigRot(exn: ExnLike, myPrefix: string): MultisigRotRound {
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
