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

/**
 * The witness OOBI bases (`http://host:port`) to pull an AID's KEL from,
 * derived from KERIA config iurls (`<base>/oobi/<witness AID>/controller`).
 *
 * Given the AID's backers (`b` from its key state), only those witnesses'
 * bases are returned: a witness that does not back the AID answers its OOBI
 * with 404, and KERIA's resolve op for it never completes — each such base
 * cost a full timeout and a "Failed to resolve OOBI" error per call. When the
 * backers are unknown (the AID isn't in our kevers yet) or none of them is in
 * the config, every witness base is returned. Non-witness (schema/data) iurls
 * are never returned.
 */
export function witnessOobiBases(iurls: string[], backers: string[] = []): string[] {
  const witnesses = iurls
    .map((iurl) => {
      const match = /^(.*?)\/oobi\/([^/]+)/.exec(iurl);
      return match ? { base: match[1] as string, aid: match[2] as string } : null;
    })
    .filter((w): w is { base: string; aid: string } => !!w && w.aid.startsWith('B'));
  const own = witnesses.filter((w) => backers.includes(w.aid));
  return [...new Set((own.length > 0 ? own : witnesses).map((w) => w.base))];
}
