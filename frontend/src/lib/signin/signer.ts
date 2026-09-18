/**
 * The in-memory signer cache (idss spec #1492 story 18, ADR 0236).
 *
 * The member's Argon2 key derivation costs 5–8 s and happens once, when the
 * wallet unlocks and the KERI client connects. Once unlocked, resolving the
 * keeper for an AID and signing is sub-second — so a second sign-in in the same
 * unlocked session must not pay anything like the first. This module memoises
 * the resolved keeper per AID for the life of the unlocked session and drops it
 * on lock or exit; nothing is persisted.
 *
 * A `Signer` is a bound `sign(message) => qb64` closure. `getSigner` resolves
 * and caches it; `clearSigners` is called from the identity store on logout so
 * a locked wallet holds no live signer.
 */

import { useKERIClient } from 'src/lib/keri/client';

/** A cached, ready-to-use signer for one AID. */
export interface Signer {
  /** Sign a UTF-8 message and return the CESR-qualified qb64 signature. */
  sign(message: string): Promise<string>;
}

/** AID prefix → its resolved signer for this unlocked session. */
const cache = new Map<string, Signer>();

/**
 * A test seam so the composable and its tests can inject a signer factory
 * without signify-ts. Production leaves it `null` and the real keeper is used.
 */
let factoryOverride: ((aidPrefix: string) => Promise<Signer>) | null = null;

/** Install a signer factory (tests only). Pass `null` to restore the default. */
export function setSignerFactory(factory: ((aidPrefix: string) => Promise<Signer>) | null): void {
  factoryOverride = factory;
  cache.clear();
}

/**
 * Return a cached signer for `aidPrefix`, resolving and memoising it on first
 * use. The second call in the same unlocked session returns the cached signer
 * without re-resolving the keeper (spec story 18).
 */
export async function getSigner(aidPrefix: string): Promise<Signer> {
  const existing = cache.get(aidPrefix);
  if (existing) return existing;
  const signer = factoryOverride ? await factoryOverride(aidPrefix) : await resolveKeeperSigner(aidPrefix);
  cache.set(aidPrefix, signer);
  return signer;
}

/** Drop every cached signer — called on lock/logout so nothing survives. */
export function clearSigners(): void {
  cache.clear();
}

/** True when a signer for this AID is already warm (mainly for tests/telemetry). */
export function hasCachedSigner(aidPrefix: string): boolean {
  return cache.has(aidPrefix);
}

/**
 * Resolve the keeper for `aidPrefix` off the connected KERI client and return a
 * signer bound to it. Mirrors `KERIClient.signChallenge` but over an arbitrary
 * bound message, and keeps the resolved keeper so repeat signs skip the
 * identifiers().list() / manager.get() round-trips.
 */
async function resolveKeeperSigner(aidPrefix: string): Promise<Signer> {
  if (!aidPrefix) throw new Error('getSigner: aidPrefix is required');
  const keriClient = useKERIClient();
  await keriClient.ensureSession();
  const client = keriClient.getSignifyClient();
  if (!client) throw new Error('getSigner: KERI client not initialized');

  const list = await client.identifiers().list();
  const habs = list.aids ?? [];
  // Never fall back to another identifier: signing as the wrong AID would fail
  // verification at best and present the wrong member at worst.
  const hab = habs.find((h: { prefix: string }) => h.prefix === aidPrefix);
  if (!hab) throw new Error(`getSigner: AID ${aidPrefix} is not managed by this agent`);

  const keeper = await client.manager!.get(hab);
  const signify = await import('signify-ts');

  return {
    async sign(message: string): Promise<string> {
      // Non-indexed signature (indexed=false) → Cigar[], code "0B"; keeper.sign
      // is async in signify-ts 0.3.x.
      const sigs = await keeper.sign(signify.b(message), false);
      const first = Array.isArray(sigs) ? sigs[0] : sigs;
      const qb64 = typeof first === 'string' ? first : (first as { qb64?: string } | undefined)?.qb64;
      if (!qb64) throw new Error('getSigner: the wallet produced no signature');
      return qb64;
    },
  };
}
