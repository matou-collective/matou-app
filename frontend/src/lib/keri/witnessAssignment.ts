import { fetchClientConfig } from 'src/lib/clientConfig';

export interface WitnessAssignment {
  personal: string[];
  org: string[];
  toad: number;
}

/**
 * Pick disjoint witness subsets for an admin's personal AID and the org AID.
 *
 * Deterministic: pool is sorted by AID prefix, then split in half.
 * - personal = first half
 * - org = second half (always non-empty when pool >= 2)
 * - toad = 2 when pool >= 4, else 1
 *
 * A community backend descriptor may name a single community witness (ADR 0226:
 * the witness floor of two becomes one). When the pool holds exactly one
 * witness the personal and org AIDs share it — disjoint sets are impossible and
 * not required at that scale — so the only refusal is an empty pool.
 */
export async function assignWitnesses(): Promise<WitnessAssignment> {
  const config = await fetchClientConfig();
  const pool = Object.values(config.witnesses?.aids ?? {}).sort();
  if (pool.length < 1) {
    throw new Error('Witness pool is empty; need at least one witness.');
  }
  if (pool.length === 1) {
    return { personal: pool.slice(), org: pool.slice(), toad: 1 };
  }
  const mid = Math.floor(pool.length / 2);
  return {
    personal: pool.slice(0, mid),
    org: pool.slice(mid),
    toad: pool.length >= 4 ? 2 : 1,
  };
}

/**
 * Extract witness AIDs from KERIA config introduction OOBI URLs (iurls).
 * iurls can also carry schema/data OOBIs (they belong in durls but have been
 * mixed in — infra 2c010fb): those SAIDs are 'E'-prefixed digests, and passing
 * one as a witness makes KERIA reject inception with "unknown witness".
 * Witnesses are always non-transferable 'B'-prefixed AIDs, so filter on that.
 */
export function extractWitnessAids(iurls: string[]): string[] {
  return iurls
    .map((iurl) => /\/oobi\/([^/]+)/.exec(iurl)?.[1] ?? '')
    .filter((aid) => aid.startsWith('B'));
}
