/**
 * useRecoverIdentity (#473 / #466): the recovery sequence shared by
 * RecoveryScreen and the linked-device screens.
 *
 * The invariant under test is ORDER: on the link path the AID hints
 * (`matou_admin_aid`, `matou_org_aid`) must be in secure storage BEFORE
 * `identityStore.connect` runs, because connect() reads `matou_admin_aid` to
 * pick the current AID (stores/identity.ts) — written afterwards, a steward's
 * fresh phone would pick the wrong AID (spec §3.4).
 *
 * (Ported from the S6 API — `recover()` that threw — to the shared
 * `recoverIdentity()` result-object API with `mode: 'recover' | 'link'`.)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
  const calls: string[] = [];
  return {
    calls,
    connect: vi.fn(async () => {
      calls.push('connect');
      return true;
    }),
    setItem: vi.fn(async (key: string) => {
      calls.push(`set:${key}`);
    }),
    validateMnemonic: vi.fn(() => true),
    store: {
      hasIdentity: true,
      currentAID: { prefix: 'EAID', name: 'me' } as { prefix: string; name: string } | null,
      error: null as string | null,
    },
  };
});

vi.mock('stores/identity', () => ({
  useIdentityStore: () => ({
    connect: h.connect,
    get hasIdentity() {
      return h.store.hasIdentity;
    },
    get currentAID() {
      return h.store.currentAID;
    },
    get error() {
      return h.store.error;
    },
  }),
}));

vi.mock('src/lib/keri/client', () => ({
  KERIClient: {
    validateMnemonic: h.validateMnemonic,
    passcodeFromMnemonic: () => 'passcode-from-mnemonic',
  },
}));

vi.mock('src/lib/secureStorage', () => ({
  secureStorage: { setItem: h.setItem, getItem: vi.fn(async () => null), removeItem: vi.fn() },
}));

import { useRecoverIdentity } from 'src/composables/useRecoverIdentity';

const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

beforeEach(() => {
  vi.clearAllMocks();
  h.calls.length = 0;
  h.validateMnemonic.mockReturnValue(true);
  h.store.hasIdentity = true;
  h.store.currentAID = { prefix: 'EAID', name: 'me' };
  h.store.error = null;
});

describe('useRecoverIdentity', () => {
  it('link path: writes the admin/org AID hints BEFORE connect, the mnemonic after', async () => {
    const { recoverIdentity } = useRecoverIdentity();
    const result = await recoverIdentity(WORDS, { mode: 'link', adminAid: 'EADMIN', orgAid: 'EORG' });
    expect(result).toEqual({ success: true, aid: 'EAID', name: 'me' });
    expect(h.calls).toEqual([
      'set:matou_admin_aid',
      'set:matou_org_aid',
      'connect',
      'set:matou_mnemonic',
    ]);
    expect(h.setItem).toHaveBeenCalledWith('matou_admin_aid', 'EADMIN');
    expect(h.setItem).toHaveBeenCalledWith('matou_org_aid', 'EORG');
    expect(h.setItem).toHaveBeenCalledWith('matou_mnemonic', WORDS);
  });

  it('recover path: no hint writes, just connect then the mnemonic', async () => {
    const { recoverIdentity } = useRecoverIdentity();
    await recoverIdentity(WORDS.split(' '));
    expect(h.calls).toEqual(['connect', 'set:matou_mnemonic']);
  });

  it('recover path ignores AID hints even when supplied', async () => {
    const { recoverIdentity } = useRecoverIdentity();
    await recoverIdentity(WORDS, { mode: 'recover', adminAid: 'EADMIN', orgAid: 'EORG' });
    expect(h.calls).toEqual(['connect', 'set:matou_mnemonic']);
  });

  it('normalises the phrase (case, whitespace, array input) before validating', async () => {
    const { recoverIdentity } = useRecoverIdentity();
    await recoverIdentity(['  Abandon', 'ABANDON ', ...WORDS.split(' ').slice(2)]);
    expect(h.validateMnemonic).toHaveBeenCalledWith(WORDS);
    expect(h.connect).toHaveBeenCalledWith('passcode-from-mnemonic');
  });

  it('invalid phrase: fails before connect and stores nothing', async () => {
    h.validateMnemonic.mockReturnValue(false);
    const { recoverIdentity } = useRecoverIdentity();
    const result = await recoverIdentity('not a phrase', { mode: 'link', adminAid: 'EADMIN' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Invalid recovery phrase/);
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.setItem).not.toHaveBeenCalled();
  });

  it('connect failure: surfaces the store error and never stores the mnemonic', async () => {
    h.connect.mockResolvedValueOnce(false);
    h.store.error = 'KERIA unreachable';
    const { recoverIdentity } = useRecoverIdentity();
    const result = await recoverIdentity(WORDS);
    expect(result.success).toBe(false);
    expect(result.error).toBe('KERIA unreachable');
    expect(h.setItem).not.toHaveBeenCalledWith('matou_mnemonic', expect.anything());
  });

  it('no identity behind the phrase: fails and never stores the mnemonic', async () => {
    h.store.hasIdentity = false;
    h.store.currentAID = null;
    const { recoverIdentity } = useRecoverIdentity();
    const result = await recoverIdentity(WORDS);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No identity found/);
    expect(h.setItem).not.toHaveBeenCalledWith('matou_mnemonic', expect.anything());
  });
});
