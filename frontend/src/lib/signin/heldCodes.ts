/**
 * The sign-in codes the wallet will not answer again (#675, #690).
 *
 * A sign-in code is single-use. Once its sign-in site has answered that a code
 * is spent, expired or not one it knows — or has answered `revoked` to what was
 * presented on it, which spends it — presenting on that code again can only be
 * refused. So the code is held: nothing more is posted on it, and the card
 * waits for a fresh one.
 *
 * The hold is the wallet's, not one card's. A refusal that is left and a code
 * that is opened again reach a card opened afresh, and that card must hold the
 * code too — otherwise, after a `revoked` answer, it would present the
 * credential the wallet falls back on, armed, on a challenge the door has
 * already refused (#690).
 *
 * A held code is a code of ONE sign-in site. It is kept in memory only,
 * mirroring signer.ts and armedPasscode.ts: nothing is written to the device,
 * and the identity store drops the whole of it on lock or exit
 * ({@link clearHeldCodes}).
 */

import { doorKey } from './revokedMemory';

/** Why the door will not take the code again — the refusal its face wears. */
export type HeldCodeKind = 'spent' | 'expired' | 'unknown';

/** door → challenge id → why it is held, this unlocked session. */
const held = new Map<string, Map<string, HeldCodeKind>>();

/**
 * Hold a code of this sign-in site. The first reason stands: a dead code does
 * not become another kind of dead. A blank site or a blank code is not held —
 * a blank would stand for every code that has none.
 */
export function holdCode(door: string | null | undefined, challenge: string | null | undefined, kind: HeldCodeKind): void {
  const site = doorKey(door);
  const code = codeOf(challenge);
  if (!site || !code) return;
  let codes = held.get(site);
  if (!codes) {
    codes = new Map();
    held.set(site, codes);
  }
  if (!codes.has(code)) codes.set(code, kind);
}

/** Why this code of this sign-in site is held, or null when it is not. */
export function heldCode(door: string | null | undefined, challenge: string | null | undefined): HeldCodeKind | null {
  const site = doorKey(door);
  const code = codeOf(challenge);
  if (!site || !code) return null;
  return held.get(site)?.get(code) ?? null;
}

/** Forget everything — called on lock/logout so nothing survives the session. */
export function clearHeldCodes(): void {
  held.clear();
}

function codeOf(challenge: string | null | undefined): string {
  return typeof challenge === 'string' ? challenge.trim() : '';
}
