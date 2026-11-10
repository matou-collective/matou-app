/**
 * The wallet's sealing half of the control-panel passcode handover (ADR 0282
 * d.6 + its 2026-09-27 #1938 amendment, PU-A2u; matou-app #663). The tab's half
 * (mint the sealing key, open the box) is idss #1938 `app/src/lib/keri/
 * sealedPasscode.ts`; the door's opaque relay is idss #1933. This module is the
 * pure, DOM-free crypto — proven at its own seam over a seal→open round trip, no
 * network, no live door.
 *
 * ## The material (settled against the installed signify-ts, not libsodium raw)
 *
 * `crypto_box_seal` is NOT exported by signify-ts, but `Encrypter` and `Verfer`
 * are, and signify's own `Controller` seals a passcode this exact way
 * (`keri/app/controller.js`). So the wallet imports nothing beyond signify:
 *
 *  - {@link sealPasscode} seals the steward's 21-char passcode (bran) to the
 *    verkey the panel bound at the door (read off the handover key route —
 *    `handover.ts`; no sign-in code carries a sealing key, #688). `Encrypter`
 *    takes an Ed25519 verkey and converts it to X25519 itself, so the sealing
 *    key is an ordinary CESR verkey, not raw X25519 bytes.
 *
 * ## The pad position (the round-trip golden, shared with idss #1938)
 *
 * signify's `Controller` reconstructs the salt qb64 from a bran as
 * `MtrDex.Salt_128 + 'A' + bran.substring(0, 21)` — code `'0A'` (2 chars) + one
 * PREPENDED pad char `'A'` + 21 bran chars = a 24-char qb64 salt. That is what
 * {@link sealPasscode} seals. idss opens it by TRIMMING those same three lead
 * chars (`substring(3)`) — NOT `substring(2, 23)`, which trims a DIFFERENT salt
 * (the mnemonic-derived one, whose pad sits at the tail). The seal→open test
 * over a fixed vector pins that the recovered bran is byte-identical to what was
 * sealed. `sealed_passcode` is therefore a CESR qb64 `X25519_Cipher_Salt`
 * (`1AAH…`, 100 chars) the door relays but cannot open.
 */

import { ready, Encrypter, MtrDex, b } from 'signify-ts';

/**
 * The 24-char qb64 salt the wallet seals for a 21-char bran — signify's
 * `Controller` reconstruction (`Salt_128 + 'A' + bran.substring(0, 21)`). The
 * shared spec with idss #1938's opening half; the round-trip test pins it.
 */
export function saltQb64FromBran(bran: string): string {
  return MtrDex.Salt_128 + 'A' + bran.substring(0, 21);
}

/**
 * Seal a 21-char passcode (bran) to the control-panel tab's sealing-key verkey
 * (the key the panel bound at the door), returning the CESR qb64
 * `X25519_Cipher_Salt` cipher for the handover seal route's `sealed_passcode`.
 * A libsodium sealed box: only the tab that minted the matching seed can open
 * it, so the door relays a box it cannot read.
 *
 * The passcode is read into this scope and sealed; it is never returned, logged
 * or persisted — only the ciphertext leaves. Awaits libsodium first.
 */
export async function sealPasscode(bran: string, sealingKeyVerkeyQb64: string): Promise<string> {
  await ready();
  if (!bran) throw new Error('sealPasscode: no passcode to seal');
  if (!sealingKeyVerkeyQb64) throw new Error('sealPasscode: no sealing key');
  const encrypter = new Encrypter({}, b(sealingKeyVerkeyQb64));
  // encrypt() parses its arg as a Matter, reads the code (Salt_128 → Cipher_Salt)
  // and seals the salt's qb64; the bran must ride in that 24-char salt shape.
  const cipher = encrypter.encrypt(b(saltQb64FromBran(bran)));
  return cipher.qb64;
}
