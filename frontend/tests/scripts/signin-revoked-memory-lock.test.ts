/**
 * What a door said of a credential, and the codes it will not take again, never
 * outlive the unlocked session (#690): the identity store drops them on lock or
 * exit, as it drops the sign-in signer and any arming.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

vi.mock('src/lib/keri/client', () => ({
  KERIClient: class {},
  useKERIClient: () => ({ getSignifyClient: () => null, ensureSession: async () => {} }),
}));
vi.mock('src/api/config', () => ({ fetchOrgConfig: async () => ({ status: 'not_configured' }) }));
vi.mock('stores/app', () => ({ useAppStore: () => ({ isIdssBackend: true }) }));
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
vi.mock('src/composables/usePush', () => ({ deregisterPush: async () => ({ success: true }) }));
vi.mock('quasar', () => ({ Notify: { create: vi.fn() } }));

import { useIdentityStore } from 'src/stores/identity';
import { isRememberedRevoked, rememberRevoked } from 'src/lib/signin/revokedMemory';
import { heldCode, holdCode } from 'src/lib/signin/heldCodes';

const DOOR = 'https://id.example.nz/login';

describe('what the sign-in remembers, on lock or exit', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('the revoked memory is dropped when the identity disconnects', async () => {
    const identity = useIdentityStore();
    rememberRevoked(DOOR, 'EAdministratorSAID');
    expect(isRememberedRevoked(DOOR, 'EAdministratorSAID')).toBe(true);

    await identity.disconnect();

    expect(isRememberedRevoked(DOOR, 'EAdministratorSAID')).toBe(false);
  });

  it('the held codes are dropped when the identity disconnects', async () => {
    const identity = useIdentityStore();
    holdCode(DOOR, 'c_refused', 'spent');
    expect(heldCode(DOOR, 'c_refused')).toBe('spent');

    await identity.disconnect();

    expect(heldCode(DOOR, 'c_refused')).toBeNull();
  });
});
