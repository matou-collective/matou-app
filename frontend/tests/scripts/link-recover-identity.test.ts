/**
 * useRecoverIdentity (#472, slice S5 of #466) — the recovery sequence lifted out
 * of RecoveryScreen.vue, shared by the "Recover identity" flow and linked-device
 * sign-in. Covers the recover-vs-link storage side effects (spec §3.4: link mode
 * stores matou_admin_aid / matou_org_aid BEFORE connect) and the error paths.
 *
 * The identity store, KERI client and secure storage are mocked so the test
 * drives the composable's own logic without KERIA/any-sync.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Secure storage: spy on every write ------------------------------------
const setItem = vi.fn(async () => undefined);
vi.mock('src/lib/secureStorage', () => ({
  secureStorage: {
    getItem: vi.fn(async () => null),
    setItem: (k: string, v: string) => setItem(k, v),
    removeItem: vi.fn(async () => undefined),
  },
}));

// --- KERI client statics ---------------------------------------------------
const validateMnemonic = vi.fn(() => true);
const passcodeFromMnemonic = vi.fn(() => 'passcode-xyz');
vi.mock('src/lib/keri/client', () => ({
  KERIClient: {
    validateMnemonic: (m: string) => validateMnemonic(m),
    passcodeFromMnemonic: (m: string) => passcodeFromMnemonic(m),
  },
}));

// --- Identity store fake ---------------------------------------------------
interface FakeStore {
  connect: ReturnType<typeof vi.fn>;
  hasIdentity: boolean;
  currentAID: { prefix: string; name: string } | null;
  error: string | null;
}
const store: FakeStore = {
  connect: vi.fn(async () => true),
  hasIdentity: true,
  currentAID: { prefix: 'EAID-me', name: 'Aroha' },
  error: null,
};
vi.mock('stores/identity', () => ({
  useIdentityStore: () => store,
}));

async function load() {
  const mod = await import('../../src/composables/useRecoverIdentity');
  return mod.useRecoverIdentity();
}

describe('useRecoverIdentity (#472)', () => {
  beforeEach(() => {
    vi.resetModules();
    setItem.mockClear();
    validateMnemonic.mockReset();
    validateMnemonic.mockReturnValue(true);
    passcodeFromMnemonic.mockReset();
    passcodeFromMnemonic.mockReturnValue('passcode-xyz');
    store.connect = vi.fn(async () => true);
    store.hasIdentity = true;
    store.currentAID = { prefix: 'EAID-me', name: 'Aroha' };
    store.error = null;
  });

  it('recover mode: stores only the (normalised) mnemonic, never the AID hints', async () => {
    const { recoverIdentity } = await load();
    const result = await recoverIdentity('  Word ONE   word two  ', { mode: 'recover' });

    expect(result).toEqual({ success: true, aid: 'EAID-me', name: 'Aroha' });
    expect(setItem).toHaveBeenCalledWith('matou_mnemonic', 'word one word two');
    expect(setItem).not.toHaveBeenCalledWith('matou_admin_aid', expect.anything());
    expect(setItem).not.toHaveBeenCalledWith('matou_org_aid', expect.anything());
  });

  it('defaults to recover mode when no options are given', async () => {
    const { recoverIdentity } = await load();
    const result = await recoverIdentity('a b c');
    expect(result.success).toBe(true);
    expect(setItem).not.toHaveBeenCalledWith('matou_admin_aid', expect.anything());
  });

  it('link mode: stores matou_admin_aid / matou_org_aid BEFORE connect (spec §3.4)', async () => {
    const { recoverIdentity } = await load();
    const result = await recoverIdentity('a b c', {
      mode: 'link',
      adminAid: 'EADMIN',
      orgAid: 'EORG',
    });

    expect(result.success).toBe(true);
    expect(setItem).toHaveBeenCalledWith('matou_admin_aid', 'EADMIN');
    expect(setItem).toHaveBeenCalledWith('matou_org_aid', 'EORG');
    expect(setItem).toHaveBeenCalledWith('matou_mnemonic', 'a b c');

    // The hints must be persisted before the connect() call runs.
    const adminOrder = setItem.mock.invocationCallOrder[
      setItem.mock.calls.findIndex((c) => c[0] === 'matou_admin_aid')
    ];
    const connectOrder = (store.connect as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(adminOrder).toBeLessThan(connectOrder!);
  });

  it('link mode without hints: stores neither AID hint', async () => {
    const { recoverIdentity } = await load();
    await recoverIdentity('a b c', { mode: 'link' });
    expect(setItem).not.toHaveBeenCalledWith('matou_admin_aid', expect.anything());
    expect(setItem).not.toHaveBeenCalledWith('matou_org_aid', expect.anything());
    expect(setItem).toHaveBeenCalledWith('matou_mnemonic', 'a b c');
  });

  it('rejects an invalid phrase without connecting or storing anything', async () => {
    validateMnemonic.mockReturnValue(false);
    const { recoverIdentity } = await load();
    const result = await recoverIdentity('nonsense', { mode: 'link', adminAid: 'EADMIN' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invalid recovery phrase/i);
    expect(store.connect).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });

  it('surfaces the store error when connect fails', async () => {
    store.connect = vi.fn(async () => false);
    store.error = 'network down';
    const { recoverIdentity } = await load();
    const result = await recoverIdentity('a b c');

    expect(result.success).toBe(false);
    expect(result.error).toBe('network down');
    expect(setItem).not.toHaveBeenCalledWith('matou_mnemonic', expect.anything());
  });

  it('fails when connect succeeds but no identity is found', async () => {
    store.hasIdentity = false;
    store.currentAID = null;
    const { recoverIdentity } = await load();
    const result = await recoverIdentity('a b c');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no identity found/i);
    expect(setItem).not.toHaveBeenCalledWith('matou_mnemonic', expect.anything());
  });
});
