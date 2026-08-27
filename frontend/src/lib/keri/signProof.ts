/**
 * Signs high-stakes actions with the current user's personal AID (issue #20).
 *
 * Kept separate from actionProof.ts so the canonical-format module stays pure
 * (no signify-ts / Pinia deps) and trivially mirrorable by the Go verifier.
 */
import { useKERIClient } from './client';
import { useIdentityStore } from 'stores/identity';
import {
  proofMessageBytes,
  makeActionProof,
  type ActionProof,
  type ProofAction,
  type ActionProofInput,
} from './actionProof';
import { createLogger } from '../logging';

const log = createLogger('ActionProof');

/**
 * Parse a KERI key-state sequence number ("s"), a hex string per the KERI spec,
 * into a non-negative integer. Returns undefined for a missing or unparseable
 * value so the proof is written without an sn anchor (safe fallback).
 */
function parseKelSn(s: string | undefined): number | undefined {
  if (typeof s !== 'string' || s.length === 0) return undefined;
  const n = parseInt(s, 16);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

export interface SignActionProofArgs {
  action: ProofAction;
  /** Stable identifier of the object being acted on (SAID / object id). */
  subject: string;
  /** The target value the action asserts (e.g. the new status). */
  value: string;
  /** Optional explicit timestamp; defaults to now (UTC ISO-8601). */
  dt?: string;
}

/**
 * Produce a KERI proof envelope for a high-stakes action, signed by the current
 * user's personal AID via the local signify-ts keystore.
 *
 * Returns `null` (never throws) when signing is not possible — no identity, no
 * KERIA session, or a keystore error. In this writer-side-only phase nothing
 * verifies proofs yet (the peer-side verifier lands with #19), so a missing
 * proof must not block the action; the gap is logged so it stays visible. Once
 * #19 lands, an object written without a proof will simply be treated as
 * invalid by honest peers — exactly the intended enforcement.
 *
 * Signing is `keeper.sign` over the canonical message bytes: local ed25519
 * crypto with no witness/TEL round-trip, so it succeeds whenever the wallet is
 * unlocked and offline.
 */
export async function signActionProof(args: SignActionProofArgs): Promise<ActionProof | null> {
  try {
    const identityStore = useIdentityStore();
    const aid = identityStore.currentAID;
    if (!aid?.prefix || !aid?.name) {
      log.warn('No current AID — skipping %s proof for %s', args.action, args.subject);
      return null;
    }

    const keriClient = useKERIClient();
    const client = keriClient.getSignifyClient();
    if (!client?.manager) {
      log.warn('No signify keystore — skipping %s proof for %s', args.action, args.subject);
      return null;
    }
    await keriClient.ensureSession();

    const space = identityStore.communitySpaceId;
    if (!space) {
      log.warn('No community space id — skipping %s proof for %s', args.action, args.subject);
      return null;
    }

    const input: ActionProofInput = {
      action: args.action,
      subject: args.subject,
      space,
      value: args.value,
      dt: args.dt ?? new Date().toISOString(),
    };

    // manager.get needs the full identifier record (HabState), not just a prefix.
    const hab = await client.identifiers().get(aid.name);
    const keeper = client.manager.get(hab);
    // indexed=false → non-indexed CESR signature (Cigar) verifiable against the
    // AID's single current signing key from its KEL key state.
    const sigs = await keeper.sign(proofMessageBytes(input), false);
    const sig = Array.isArray(sigs) ? sigs[0] : undefined;
    if (!sig) {
      log.warn('Keystore returned no signature for %s proof (%s)', args.action, args.subject);
      return null;
    }

    // Anchor the proof to the current KEL sequence number so it survives a later
    // legitimate rotation (#112): hab.state.s is the current establishment
    // event's sn, a hex string. Best-effort — a missing/unparseable sn simply
    // omits the anchor (the verifier then falls back to current-key checking).
    const sn = parseKelSn((hab as { state?: { s?: string } }).state?.s);

    return makeActionProof(input, aid.prefix, sig, sn);
  } catch (err) {
    log.warn(
      'Failed to sign %s proof for %s: %s',
      args.action,
      args.subject,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
