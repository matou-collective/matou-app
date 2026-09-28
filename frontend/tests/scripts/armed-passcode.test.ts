/**
 * The armed-consent registry (matou-app #674, idss #1957). Approve with the
 * unlock line on ARMS the wallet for one sign-in challenge; the panel later asks
 * with the verkey it holds and the passcode is sealed to THAT verkey, once. This
 * proves the seam directly — every acceptance clause on the ticket — with a fake
 * sealer, no signify-ts and no live door.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  armForChallenge,
  isArmed,
  sealForRequest,
  clearArming,
  type PasscodeSealer,
} from 'src/lib/signin/armedPasscode';

/** A sealer that records the verkey it was asked to seal to. */
function fakeSealer(): PasscodeSealer & { calls: string[] } {
  const calls: string[] = [];
  const seal = vi.fn(async (verkey: string) => {
    calls.push(verkey);
    return `sealed(${verkey})`;
  });
  return Object.assign(seal, { calls });
}

const NO_EXPIRY = 0;

beforeEach(() => {
  clearArming();
});

describe('armed passcode registry', () => {
  it('an armed wallet seals to the panel verkey and returns the cipher once', async () => {
    const seal = fakeSealer();
    armForChallenge('c_1', NO_EXPIRY, seal);
    expect(isArmed('c_1')).toBe(true);

    // The panel asks with ITS OWN key — not the sign-in code's `ek=`.
    const cipher = await sealForRequest('c_1', 'DPANEL_KEY');
    expect(cipher).toBe('sealed(DPANEL_KEY)');
    expect(seal.calls).toEqual(['DPANEL_KEY']);
  });

  it('seals nothing on a second request for the same challenge (single-use)', async () => {
    const seal = fakeSealer();
    armForChallenge('c_1', NO_EXPIRY, seal);

    await sealForRequest('c_1', 'DPANEL_KEY');
    const second = await sealForRequest('c_1', 'DPANEL_KEY');
    expect(second).toBeNull();
    expect(seal).toHaveBeenCalledTimes(1);
    expect(isArmed('c_1')).toBe(false);
  });

  it('a request against an expired arming seals nothing and discards it', async () => {
    const seal = fakeSealer();
    armForChallenge('c_1', 5_000, seal);

    // isArmed at a later instant already reports it dead...
    expect(isArmed('c_1', 6_000)).toBe(false);
    // ...and a request seals nothing.
    const cipher = await sealForRequest('c_1', 'DPANEL_KEY', 6_000);
    expect(cipher).toBeNull();
    expect(seal).not.toHaveBeenCalled();
    // Discarded: even a request at a valid instant now finds no arming.
    expect(await sealForRequest('c_1', 'DPANEL_KEY', 1_000)).toBeNull();
  });

  it('an arming still live at the request instant seals', async () => {
    const seal = fakeSealer();
    armForChallenge('c_1', 5_000, seal);
    const cipher = await sealForRequest('c_1', 'DPANEL_KEY', 4_999);
    expect(cipher).toBe('sealed(DPANEL_KEY)');
  });

  it('a request against a wallet that was never armed seals nothing (line off)', async () => {
    const cipher = await sealForRequest('c_never', 'DPANEL_KEY');
    expect(cipher).toBeNull();
  });

  it('a request for a different challenge seals nothing', async () => {
    const seal = fakeSealer();
    armForChallenge('c_1', NO_EXPIRY, seal);
    expect(await sealForRequest('c_other', 'DPANEL_KEY')).toBeNull();
    expect(seal).not.toHaveBeenCalled();
    // The original arming is untouched by a miss.
    expect(isArmed('c_1')).toBe(true);
  });

  it('clearArming drops every arming — nothing survives a lock', async () => {
    armForChallenge('c_1', NO_EXPIRY, fakeSealer());
    armForChallenge('c_2', NO_EXPIRY, fakeSealer());
    clearArming();
    expect(isArmed('c_1')).toBe(false);
    expect(isArmed('c_2')).toBe(false);
    expect(await sealForRequest('c_1', 'DPANEL_KEY')).toBeNull();
  });

  it('a sealer with no passcode (a locked seat) yields no cipher', async () => {
    // The live sealer returns null when the identity store holds no passcode.
    const seal: PasscodeSealer = async () => null;
    armForChallenge('c_1', NO_EXPIRY, seal);
    expect(await sealForRequest('c_1', 'DPANEL_KEY')).toBeNull();
  });

  it('a request with no verkey seals nothing but still consumes the arming', async () => {
    const seal = fakeSealer();
    armForChallenge('c_1', NO_EXPIRY, seal);
    expect(await sealForRequest('c_1', '')).toBeNull();
    expect(seal).not.toHaveBeenCalled();
    // The single-use arming is spent — a request cannot be retried behind a
    // wallet's back once a challenge has been answered, even trivially.
    expect(isArmed('c_1')).toBe(false);
  });

  it('a fresh arm for the same challenge replaces the old one', async () => {
    const first = fakeSealer();
    const second = fakeSealer();
    armForChallenge('c_1', NO_EXPIRY, first);
    armForChallenge('c_1', NO_EXPIRY, second);
    await sealForRequest('c_1', 'DPANEL_KEY');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('a blank challenge arms nothing', () => {
    armForChallenge('', NO_EXPIRY, fakeSealer());
    expect(isArmed('')).toBe(false);
  });
});
