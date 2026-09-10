/**
 * identityStore.hasPendingSpaceAccess (issue #469, slice S2).
 *
 * GET /api/v1/spaces/user now tags each adopted space with
 * `spaceAccess: "ok" | "pending"` — "pending" means the space was adopted but
 * its read key isn't available from ACL yet (data still syncing). The
 * identity store exposes `hasPendingSpaceAccess`, derived from the last
 * fetchUserSpaces() response, so WelcomeOverlayScreen.vue can show a
 * "Waiting for your data to sync…" retry state instead of routing into a
 * dashboard that can't read its own data.
 *
 * The identity store's API-client dependency is mocked (same pattern as
 * push.test.ts / push-relay-session.test.ts) so fetchUserSpaces() is driven
 * by a controlled UserSpacesResponse instead of a live backend.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

const getUserSpaces = vi.fn(async () => ({}));
vi.mock('src/lib/api/client', () => ({
  getUserSpaces: (...a: unknown[]) => getUserSpaces(...(a as [string])),
  verifyCommunityAccess: vi.fn(async () => ({ hasAccess: false })),
  joinCommunity: vi.fn(async () => ({})),
  getAuthChallenge: vi.fn(async () => ({ challenge: '', expiresAt: '' })),
  postAuthLogin: vi.fn(async () => ({ token: '', expiresAt: '' })),
  setSessionToken: vi.fn(),
}));

describe('identityStore.hasPendingSpaceAccess (#469)', () => {
  beforeEach(() => {
    vi.resetModules();
    setActivePinia(createPinia());
    getUserSpaces.mockReset();
  });

  it('is false before any spaces have been fetched', async () => {
    const { useIdentityStore } = await import('../../src/stores/identity');
    const identity = useIdentityStore();

    expect(identity.hasPendingSpaceAccess).toBe(false);
  });

  it('is true when an adopted space reports spaceAccess: "pending"', async () => {
    getUserSpaces.mockResolvedValue({
      privateSpace: {
        spaceId: 'sp-1',
        spaceName: 'Private',
        createdAt: 't',
        keysAvailable: false,
        spaceAccess: 'pending',
      },
    });
    const { useIdentityStore } = await import('../../src/stores/identity');
    const identity = useIdentityStore();
    identity.currentAID = { prefix: 'EAID-a' } as never;

    await identity.fetchUserSpaces();

    expect(identity.hasPendingSpaceAccess).toBe(true);
  });

  it('is false once every fetched space reports spaceAccess: "ok"', async () => {
    getUserSpaces.mockResolvedValue({
      privateSpace: {
        spaceId: 'sp-1',
        spaceName: 'Private',
        createdAt: 't',
        keysAvailable: true,
        spaceAccess: 'ok',
      },
      communitySpace: {
        spaceId: 'sp-2',
        spaceName: 'Community',
        createdAt: 't',
        keysAvailable: true,
        spaceAccess: 'ok',
      },
    });
    const { useIdentityStore } = await import('../../src/stores/identity');
    const identity = useIdentityStore();
    identity.currentAID = { prefix: 'EAID-a' } as never;

    await identity.fetchUserSpaces();

    expect(identity.hasPendingSpaceAccess).toBe(false);
  });
});
