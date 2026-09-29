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
 * So the wallet remembers the door's answer, and `chooseCredential` passes over
 * a credential remembered here exactly as it does one the agent reads as
 * revoked.
 *
 * What is remembered is a fact about ONE credential SAID — never about a kind,
 * a schema or a holder, so a credential issued again (a new SAID) is untouched.
 * It is held in memory only, mirroring signer.ts and armedPasscode.ts: nothing
 * is written to the device or to the agent, and the identity store drops the
 * whole of it on lock or exit ({@link clearRevokedMemory}). A wallet opened
 * again reads the credential as its agent does. It is cleared for one SAID
 * ({@link forgetRevoked}) when that credential is read as live — today, when a
 * door verifies it.
 */

/** The SAIDs a door answered `revoked` to, this unlocked session. */
const revoked = new Set<string>();

/**
 * Remember that a door answered `revoked` to the credential with this SAID. A
 * credential with no SAID is not remembered: a blank would stand for every
 * credential that has none.
 */
export function rememberRevoked(said: string | null | undefined): void {
  const key = keyOf(said);
  if (key) revoked.add(key);
}

/** Whether a door answered `revoked` to this credential, this session. */
export function isRememberedRevoked(said: string | null | undefined): boolean {
  const key = keyOf(said);
  return !!key && revoked.has(key);
}

/** This credential was read as live: forget what was remembered of it. */
export function forgetRevoked(said: string | null | undefined): void {
  const key = keyOf(said);
  if (key) revoked.delete(key);
}

/** Forget everything — called on lock/logout so nothing survives the session. */
export function clearRevokedMemory(): void {
  revoked.clear();
}

function keyOf(said: string | null | undefined): string {
  return typeof said === 'string' ? said.trim() : '';
}
