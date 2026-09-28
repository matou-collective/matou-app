/**
 * The wallet's sealing half of the control-panel passcode handover (#663, ADR
 * 0282 d.6). Proven at its own seam: seal a passcode to a freshly minted sealing
 * key, then open it with signify's `Decrypter` exactly as the panel tab does
 * (idss #1938), and assert the recovered bran is byte-identical. This pins the
 * pad position (`substring(3)`, not `substring(2, 23)`) shared across both repos.
 */
import { describe, it, expect } from 'vitest';
import { ready, Signer, Decrypter, MtrDex } from 'signify-ts';
import { sealPasscode, saltQb64FromBran, fingerprintOf } from 'src/lib/signin/sealedPasscode';

// A 21-char bran (the KERI passcode shape) with distinctive characters, so an
// off-by-one recovery would be caught.
const BRAN = 'Abc123Def456Ghi789Jkl';

describe('sealPasscode — the wallet seals, the tab opens', () => {
  it('seals to the tab verkey a box the tab reopens to the exact bran', async () => {
    await ready();
    // The tab's side: mint a throwaway Ed25519 signer; its verkey rides `ek=`.
    const signer = new Signer({ transferable: true });
    const verkeyQb64 = signer.verfer.qb64;
    const seedQb64b = signer.qb64b;

    const cipher = await sealPasscode(BRAN, verkeyQb64);
    // A CESR qb64 X25519_Cipher_Salt (`1AAH…`, 100 chars) the door cannot open.
    expect(cipher.startsWith('1AAH')).toBe(true);
    expect(cipher).toHaveLength(100);

    // The tab opens it exactly as idss #1938 does: Decrypter → Salter → trim the
    // three lead chars ('0A' code + one prepended pad).
    const salter = new Decrypter({}, seedQb64b).decrypt(new TextEncoder().encode(cipher)) as {
      qb64: string;
    };
    expect(salter.qb64.substring(3)).toBe(BRAN);
  });

  it('a box sealed to one key does not open with another', async () => {
    await ready();
    const alice = new Signer({ transferable: true });
    const mallory = new Signer({ transferable: true });
    const cipher = await sealPasscode(BRAN, alice.verfer.qb64);
    expect(() =>
      new Decrypter({}, mallory.qb64b).decrypt(new TextEncoder().encode(cipher)),
    ).toThrow();
  });

  it('builds the 24-char salt qb64 signify Controller reconstructs from a bran', async () => {
    expect(saltQb64FromBran(BRAN)).toBe(MtrDex.Salt_128 + 'A' + BRAN);
    expect(saltQb64FromBran(BRAN)).toHaveLength(24);
  });

  it('refuses to seal without a passcode or a sealing key', async () => {
    await ready();
    const verkey = new Signer({ transferable: true }).verfer.qb64;
    await expect(sealPasscode('', verkey)).rejects.toThrow(/no passcode/);
    await expect(sealPasscode(BRAN, '')).rejects.toThrow(/no sealing key/);
  });
});

describe('fingerprintOf — the same short mark the panel prints', () => {
  it('is a stable xxxx·xxxx hex of the verkey, matching idss #1938', async () => {
    await ready();
    const verkeyQb64 = new Signer({ transferable: true }).verfer.qb64;
    const fp = await fingerprintOf(verkeyQb64);
    expect(fp).toMatch(/^[0-9a-f]{4}·[0-9a-f]{4}$/);
    // Stable: the same verkey always yields the same fingerprint.
    expect(await fingerprintOf(verkeyQb64)).toBe(fp);
  });
});
