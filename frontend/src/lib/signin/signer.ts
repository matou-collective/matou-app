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
 * A signer is only good for the KEYS it was resolved at. An identity rotates
 * its keys — a steward's own identity does whenever the steward set changes,
 * because every signer of the community's identity rotates first — and the
 * sign-in door verifies against the newest key state. So the cache is keyed on
 * the identity AND the key state it was resolved at: `getSigner` reads the
 * identity's current key state (one cheap read, no derivation) and resolves
 * afresh when it has moved on. Holding a signer across a rotation signed with
 * the old key, and the door answered `signature` to a steward who had done
 * nothing wrong until they restarted the app.
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

/** A resolved signer and the key state it was resolved at ('' when unread). */
interface Resolved {
  signer: Signer;
  keyState: string;
}

/** AID prefix → its resolved signer for this unlocked session. */
const cache = new Map<string, Resolved>();

/**
 * A test seam so the composable and its tests can inject a signer factory
 * without signify-ts. Production leaves it `null` and the real keeper is used.
 */
let factoryOverride: ((aidPrefix: string) => Promise<Signer>) | null = null;
/** The matching seam for the key-state read; `null` reads the real agent. */
let keyStateOverride: ((aidPrefix: string) => Promise<string>) | null = null;

/**
 * Install a signer factory and, optionally, a key-state reader (tests only).
 * Pass `null` to restore the defaults. With a factory and no reader the key
 * state reads as unchanged, so the cache behaves as it did before it followed
 * rotation.
 */
export function setSignerFactory(
  factory: ((aidPrefix: string) => Promise<Signer>) | null,
  keyState: ((aidPrefix: string) => Promise<string>) | null = null,
): void {
  factoryOverride = factory;
  keyStateOverride = factory ? (keyState ?? (async () => '')) : null;
  cache.clear();
}

/**
 * Return a signer for `aidPrefix` that signs with the identity's CURRENT keys.
 * The second call in the same unlocked session returns the cached signer
 * without re-resolving the keeper (spec story 18) — unless the identity has
 * rotated since, in which case the old signer is dropped and a fresh one is
 * resolved. A key state that cannot be read keeps the signer already held: a
 * blip must not cost a sign-in, and the door has the last word either way.
 */
export async function getSigner(aidPrefix: string): Promise<Signer> {
  const existing = cache.get(aidPrefix);
  let keyState = '';
  try {
    keyState = await (keyStateOverride ?? readKeyState)(aidPrefix);
  } catch {
    keyState = '';
  }
  if (existing && (keyState === '' || existing.keyState === keyState)) return existing.signer;

  const signer = factoryOverride ? await factoryOverride(aidPrefix) : await resolveKeeperSigner(aidPrefix);
  cache.set(aidPrefix, { signer, keyState });
  return signer;
}

/** Drop every cached signer — called on lock/logout so nothing survives. */
export function clearSigners(): void {
  cache.clear();
}

/**
 * Drop one identity's signer, so its next sign resolves afresh. Called when the
 * door answers `signature`: whatever made the signer stale, the retry must not
 * sign with it again.
 */
export function dropSigner(aidPrefix: string): void {
  cache.delete(aidPrefix);
}

/** True when a signer for this AID is already warm (mainly for tests/telemetry). */
export function hasCachedSigner(aidPrefix: string): boolean {
  return cache.has(aidPrefix);
}

/** The identifier record the agent lists: its prefix and its keeper's parameters. */
interface ListedHab {
  prefix: string;
  salty?: unknown;
  randy?: unknown;
  group?: unknown;
  extern?: unknown;
}

/**
 * The key state a keeper is built from, as one comparable string. The agent
 * lists each identifier with its keeper's parameters (for a salty keeper the
 * key index, which a rotation advances, and the encrypted salt, which replacing
 * the twelve words changes), so any change that would make a held keeper sign
 * with the wrong key changes this string.
 */
export function keyStateOf(hab: ListedHab): string {
  return JSON.stringify(hab.salty ?? hab.randy ?? hab.group ?? hab.extern ?? null);
}

/** Find `aidPrefix` among the identifiers this agent manages. */
async function listedHab(aidPrefix: string): Promise<ListedHab> {
  if (!aidPrefix) throw new Error('getSigner: aidPrefix is required');
  const keriClient = useKERIClient();
  await keriClient.ensureSession();
  const client = keriClient.getSignifyClient();
  if (!client) throw new Error('getSigner: KERI client not initialized');

  const list = await client.identifiers().list();
  const habs = (list.aids ?? []) as ListedHab[];
  // Never fall back to another identifier: signing as the wrong AID would fail
  // verification at best and present the wrong member at worst.
  const hab = habs.find((h) => h.prefix === aidPrefix);
  if (!hab) throw new Error(`getSigner: AID ${aidPrefix} is not managed by this agent`);
  return hab;
}

/** Read the identity's current key state from the agent (no key derivation). */
async function readKeyState(aidPrefix: string): Promise<string> {
  return keyStateOf(await listedHab(aidPrefix));
}

/**
 * Resolve the keeper for `aidPrefix` off the connected KERI client and return a
 * signer bound to it. Mirrors `KERIClient.signChallenge` but over an arbitrary
 * bound message, and keeps the resolved keeper so repeat signs skip the
 * identifiers().list() / manager.get() round-trips.
 */
async function resolveKeeperSigner(aidPrefix: string): Promise<Signer> {
  const hab = await listedHab(aidPrefix);
  const client = useKERIClient().getSignifyClient();
  if (!client) throw new Error('getSigner: KERI client not initialized');

  const keeper = await client.manager!.get(hab as Parameters<NonNullable<typeof client.manager>['get']>[0]);
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
