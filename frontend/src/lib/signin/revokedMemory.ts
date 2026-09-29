/**
 * What a sign-in door said of a credential the wallet presented: that it is
 * revoked (#690; idss ADR 0289 as amended 2026-09-29, decision 5).
 *
 * Revoking a credential writes to its ISSUER's registry. Nothing is sent to the
 * holder, so the standing the member's agent records for a held credential is
 * the standing on the day it was admitted. The door reads the witnessed ledger
 * at every presentation: when it answers `revoked`, its reading is the newer
 * one. Found on Whakatōhea Demo, 2026-09-29 — an Administrator revoked from the
 * control panel went on being presented, and refused, for as long as the app's
 * view stayed stale, and the steward's Membership behind it was never reached.
 *
 * So the wallet remembers the door's answer, and reads the credentials it holds
 * as that door read them ({@link asTheDoorReadThem}) before it chooses one:
 * `chooseCredential` then passes over the credential exactly as it does one the
 * agent reads as revoked, and so does every other reader of its standing.
 *
 * What is remembered is a fact about ONE credential SAID — never about a kind,
 * a schema or a holder, so a credential issued again (a new SAID) is untouched
 * — **as ONE sign-in site read it**. A door is believed about its own sign-ins
 * and no further: what one site answers changes nothing the wallet presents at
 * another, so no site can take a credential, or a steward's standing, away from
 * the wallet at a door that is not its own. And only the site's own answer is
 * heard ({@link answeredByTheDoor}): a code names the site and, apart from it,
 * where to post, and an answer from anywhere else is remembered as nothing.
 *
 * It is held in memory only, mirroring signer.ts and armedPasscode.ts: nothing
 * is written to the device or to the agent, and the identity store drops the
 * whole of it on lock or exit ({@link clearRevokedMemory}). A wallet opened
 * again reads the credential as its agent does. It is cleared for one SAID, at
 * every site ({@link forgetRevoked}), when that credential is read as live —
 * today, when a door verifies it.
 */

import type { HeldCredential } from './credential';

/** door → the SAIDs it answered `revoked` to, this unlocked session. */
const revoked = new Map<string, Set<string>>();

/**
 * The standing the agent gives a revoked credential (`status.s` is the
 * registry event's sequence number, `et` its type) — what a credential the
 * door called revoked is read as.
 */
const REVOKED_STANDING = { s: '1', et: 'rev' } as const;

/**
 * What a sign-in site is known by: its address as the code carried it, less
 * any trailing slash — the key the wallet's known sign-in sites are kept under
 * (stores/knownDoors.ts). Blank when there is none.
 */
export function doorKey(door: string | null | undefined): string {
  return typeof door === 'string' ? door.trim().replace(/\/+$/, '') : '';
}

/**
 * Whether an answer posted to `presentUrl` is the sign-in site's own: the two
 * share an origin. A code carries `present` apart from `door` and the wallet
 * posts to it verbatim (app-door-golden `present.url`); the door's own present
 * route is on the door's own origin. An address that cannot be read is nobody's.
 */
export function answeredByTheDoor(door: string | null | undefined, presentUrl: string | null | undefined): boolean {
  const site = originOf(door);
  return !!site && site === originOf(presentUrl);
}

/**
 * Remember that this sign-in site answered `revoked` to the credential with
 * this SAID. A credential with no SAID is not remembered — a blank would stand
 * for every credential that has none — and nor is anything of a site with no
 * address.
 */
export function rememberRevoked(door: string | null | undefined, said: string | null | undefined): void {
  const site = doorKey(door);
  const key = keyOf(said);
  if (!site || !key) return;
  let saids = revoked.get(site);
  if (!saids) {
    saids = new Set();
    revoked.set(site, saids);
  }
  saids.add(key);
}

/** Whether this sign-in site answered `revoked` to this credential, this session. */
export function isRememberedRevoked(door: string | null | undefined, said: string | null | undefined): boolean {
  const site = doorKey(door);
  const key = keyOf(said);
  return !!site && !!key && (revoked.get(site)?.has(key) ?? false);
}

/**
 * This credential was read as live: forget what was remembered of it, at every
 * site. Its standing is one fact on one ledger, and a live reading is the
 * newer one.
 */
export function forgetRevoked(said: string | null | undefined): void {
  const key = keyOf(said);
  if (!key) return;
  for (const saids of revoked.values()) saids.delete(key);
}

/** Forget everything — called on lock/logout so nothing survives the session. */
export function clearRevokedMemory(): void {
  revoked.clear();
}

/**
 * The credentials the wallet holds, as this sign-in site read them: one it
 * answered `revoked` to wears the standing the agent gives a revoked
 * credential; every other is handed back as it was, itself and in its place.
 * Nothing given is changed.
 */
export function asTheDoorReadThem<T extends HeldCredential>(
  creds: readonly T[],
  door: string | null | undefined,
): T[] {
  const saids = revoked.get(doorKey(door));
  if (!saids || saids.size === 0) return [...creds];
  return creds.map((cred) =>
    saids.has(keyOf(cred.sad?.d)) ? { ...cred, status: { ...cred.status, ...REVOKED_STANDING } } : cred,
  );
}

function keyOf(said: string | null | undefined): string {
  return typeof said === 'string' ? said.trim() : '';
}

function originOf(url: string | null | undefined): string {
  if (typeof url !== 'string' || !url.trim()) return '';
  try {
    const { origin } = new URL(url.trim());
    // An opaque origin (a scheme with no host) serialises as "null".
    return origin && origin !== 'null' ? origin : '';
  } catch {
    return '';
  }
}
