/**
 * Regression for issue #383 — "Member role does not appear in the UI after
 * membership credential issuance".
 *
 * The role badge reads solely from CommunityProfile (read-only space) and the
 * member list from SharedProfile. In the admin approval flow those writes go
 * through the create-profile handler, which used to emit no SSE refresh signal,
 * and approveRegistration never reloaded the profile stores itself — so if the
 * single init-member broadcast was missed/late, the just-approved member's
 * role badge stayed hidden until a manual reload.
 *
 * The fix makes approveRegistration explicitly reload BOTH community-profile
 * stores on success (belt-and-suspenders, matching decline/remove-member).
 * This test drives approveRegistration with the whole KERI + API surface
 * mocked to succeed and asserts both reloads fire.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const spies = vi.hoisted(() => ({
  loadCommunityProfiles: vi.fn(async () => {}),
  loadCommunityReadOnlyProfiles: vi.fn(async () => {}),
  createOrUpdateProfile: vi.fn(async () => ({ success: true })),
  initMemberProfiles: vi.fn(async () => ({ success: true })),
  getProfileById: vi.fn(async () => ({ data: {} })),
}));

vi.mock('stores/identity', () => ({
  useIdentityStore: () => ({ currentAID: 'EAdmin' }),
}));

vi.mock('stores/profiles', () => ({
  useProfilesStore: () => ({
    loadCommunityProfiles: spies.loadCommunityProfiles,
    loadCommunityReadOnlyProfiles: spies.loadCommunityReadOnlyProfiles,
  }),
}));

vi.mock('src/lib/keri/client', () => ({
  useKERIClient: () => ({
    getSignifyClient: () => ({
      identifiers: () => ({ list: async () => ({ aids: [{ name: 'org', prefix: 'EOrg' }] }) }),
    }),
    getCesrUrl: () => 'http://localhost:3903',
    resolveOOBIWithReason: async () => ({ ok: true }),
    issueCredential: async () => ({ said: 'ECredentialSAID' }),
    pushKelToAgent: async () => {},
    listNotifications: async () => [],
    markNotificationRead: async () => {},
    getExchange: async () => null,
  }),
}));

vi.mock('src/api/config', () => ({
  fetchOrgConfig: async () => ({
    status: 'configured',
    config: { registry: { id: 'EReg' }, organization: { aid: 'EOrg' } },
  }),
}));

vi.mock('src/lib/keri/registry', () => ({
  getOrCreateOrgRegistry: async () => 'EReg',
}));

vi.mock('src/lib/secureStorage', () => ({
  secureStorage: { getItem: async () => null, setItem: async () => {} },
}));

vi.mock('src/lib/api/client', () => ({
  BACKEND_URL: 'http://localhost:9080',
  createOrUpdateProfile: spies.createOrUpdateProfile,
  getProfileById: spies.getProfileById,
  grantStewardAdmin: vi.fn(),
  initMemberProfiles: spies.initMemberProfiles,
  sendRegistrationApprovedNotification: vi.fn(async () => {}),
  removeMember: vi.fn(),
}));

import { useAdminActions } from 'src/composables/useAdminActions';
import type { PendingRegistration } from 'src/composables/useRegistrationPolling';

function makeRegistration(): PendingRegistration {
  return {
    notificationId: 'note-1',
    exnSaid: 'Eexn',
    applicantAid: 'EApplicant',
    applicantOOBI: 'http://localhost:3903/oobi/EApplicant/agent/EAgent',
    profile: {
      name: 'Aroha',
      email: 'aroha@example.nz',
      bio: '',
      interests: [],
      submittedAt: new Date().toISOString(),
    },
    isPending: false,
  };
}

describe('approveRegistration — post-approval profile refresh (issue #383)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        success: true,
        communitySpaceId: 'ECommunitySpace',
        inviteKey: 'AInviteKey',
        readOnlyInviteKey: 'AReadOnlyInviteKey',
        readOnlySpaceId: 'EReadOnlySpace',
      }),
      text: async () => '',
    })) as unknown as typeof fetch;
  });

  it('reloads both community-profile stores on a successful approval', async () => {
    const { approveRegistration } = useAdminActions();

    const ok = await approveRegistration(makeRegistration());

    expect(ok).toBe(true);
    // The role badge reads from CommunityProfile (read-only space); the member
    // list from SharedProfile. Both stores must refresh so the role appears
    // without a manual page reload.
    expect(spies.loadCommunityProfiles).toHaveBeenCalledTimes(1);
    expect(spies.loadCommunityReadOnlyProfiles).toHaveBeenCalledTimes(1);
  });
});
