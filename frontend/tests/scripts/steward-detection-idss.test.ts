/**
 * Steward detection ignores the config `admins` list on an IDSS backend
 * (issue #612, ADR 0235 decision 10).
 *
 * On idss the steward role is the HELD membership/steward credential (Method 1)
 * or org group-AID membership (Method 1b) — never a bare entry in the
 * descriptor's `admins` list, which d.10 hides. `checkAdminStatus`'s Method 2
 * (config `admins`) must therefore be skipped on idss: an AID that appears ONLY
 * in `admins` is not a steward. On a legacy backend Method 2 is unchanged.
 *
 * The KERI + API surface is mocked so the test drives only the admin-detection
 * branch: the wallet holds no credential, the user is not in the org group AID,
 * and the user's AID IS present in the config `admins` list — so the only thing
 * that decides the outcome is whether Method 2 runs.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

const ctrl = vi.hoisted(() => ({ isIdssBackend: false }));

// No held credential, and the user is not a member of the org group AID.
vi.mock('src/lib/keri/client', () => ({
  KERIClient: class {},
  useKERIClient: () => ({
    getSignifyClient: () => ({
      credentials: () => ({ list: async () => [] }),
      identifiers: () => ({ list: async () => ({ aids: [] }) }),
    }),
    ensureSession: async () => {},
  }),
}));

// The config server lists the user's AID as an admin, and names an org AID the
// user does NOT control — so only Method 2 could make them a steward.
vi.mock('src/api/config', () => ({
  fetchOrgConfig: async () => ({
    status: 'configured',
    config: {
      organization: { aid: 'EORG_GROUP_AID' },
      admins: [{ aid: 'EUSER_APPLICANT_AID' }],
    },
  }),
}));

vi.mock('stores/app', () => ({
  useAppStore: () => ({ isIdssBackend: ctrl.isIdssBackend }),
}));

vi.mock('src/lib/api/client', () => ({
  getUserSpaces: vi.fn(async () => ({})),
  verifyCommunityAccess: vi.fn(async () => ({ hasAccess: false })),
  joinCommunity: vi.fn(async () => ({})),
  getAuthChallenge: vi.fn(async () => ({ challenge: '', expiresAt: '' })),
  postAuthLogin: vi.fn(async () => ({ token: '', expiresAt: '' })),
  setSessionToken: vi.fn(),
}));
vi.mock('src/lib/secureStorage', () => ({
  secureStorage: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));
vi.mock('src/lib/keri/alias', () => ({ toKeriAlias: (s: string) => s }));
vi.mock('src/lib/signin/signer', () => ({ clearSigners: vi.fn() }));
vi.mock('quasar', () => ({ Notify: { create: vi.fn() } }));

describe('checkAdminStatus config-admins gate (#612, ADR 0235 d.10)', () => {
  beforeEach(() => {
    vi.resetModules();
    setActivePinia(createPinia());
    ctrl.isIdssBackend = false;
  });

  it('legacy backend: an AID in config admins IS a steward (Method 2 runs)', async () => {
    ctrl.isIdssBackend = false;
    const { useIdentityStore } = await import('../../src/stores/identity');
    const identity = useIdentityStore();
    identity.setCurrentAID({ prefix: 'EUSER_APPLICANT_AID' } as never);

    const isAdmin = await identity.checkAdminStatus();

    expect(isAdmin).toBe(true);
    expect(identity.adminCredential?.status).toBe('config');
  });

  it('idss backend: the same config-admins AID is NOT a steward (Method 2 skipped)', async () => {
    ctrl.isIdssBackend = true;
    const { useIdentityStore } = await import('../../src/stores/identity');
    const identity = useIdentityStore();
    identity.setCurrentAID({ prefix: 'EUSER_APPLICANT_AID' } as never);

    const isAdmin = await identity.checkAdminStatus();

    expect(isAdmin).toBe(false);
    expect(identity.adminCredential).toBeNull();
  });
});
