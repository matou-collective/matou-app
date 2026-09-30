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

/** A round-1 proposal we started rotating for, with our personal AID's sn just BEFORE that rotation. */
export interface Round1Record {
  said: string;
  snBefore: number;
}

/**
 * Parse the persisted round-1 records. The first shape was a bare string[] of
 * SAIDs written only AFTER a successful rotation, so a legacy string means
 * "rotated" — recorded as snBefore = -1, which any current sn exceeds.
 */
export function parseRound1Records(raw: unknown): Round1Record[] {
  if (!Array.isArray(raw)) return [];
  const out: Round1Record[] = [];
  for (const e of raw) {
    if (typeof e === 'string' && e) out.push({ said: e, snBefore: -1 });
    else if (e && typeof e === 'object' && typeof (e as Round1Record).said === 'string' && Number.isFinite((e as Round1Record).snBefore)) {
      out.push({ said: (e as Round1Record).said, snBefore: (e as Round1Record).snBefore });
    }
  }
  return out;
}

/**
 * What the joining member does with a round-1 /multisig/rot:
 *   'skip'   — a co-signer's forward (or no embedded rotation): never rotate;
 *   'done'   — we recorded this proposal and our sn has advanced past the
 *              recorded pre-rotation sn, so the rotation landed (even if the
 *              call that made it timed out or the app died before marking read);
 *   'rotate' — not yet rotated for it (new, or recorded but sn unchanged).
 * The record is written BEFORE rotating, so a rotation that KERIA committed
 * but our wait timed out on is never repeated (a repeat would leave round 2
 * committing a stale key).
 */
export function round1Action(
  exn: { i?: string; a?: { smids?: unknown }; e?: { rot?: { d?: string } } },
  record: Round1Record | undefined,
  currentSn: number,
): 'skip' | 'done' | 'rotate' {
  if (!rotationSaidOf(exn) || !isInitiatorExn(exn)) return 'skip';
  if (record && currentSn > record.snBefore) return 'done';
  return 'rotate';
}
