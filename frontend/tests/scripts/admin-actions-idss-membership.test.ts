/**
 * On an IDSS community the steward's Approve (and a role change) issues the
 * Membership ACDC with the IDSS attribute body — not the Mātou one the gateway
 * refused live on whakatohea-demo (2026-09-25): "'Member' is not one of
 * ['operator', 'member']". Driven through useAdminActions with a mocked
 * signify client and an IDSS descriptor.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const IDSS_MEMBERSHIP_SCHEMA = 'IBpju1vRXOpF3gG-PXOdkeseqsqr0uD1ut7YN5538x9t';

type WalletEntry = { sad: { d: string; s: string; a: Record<string, unknown> & { i: string } }; status: { et: string; s: string } };
const wallet: WalletEntry[] = [];

const issueCredential = vi.fn(
  async (_issuer: string, _registry: string, schema: string, issuee: string, data: Record<string, unknown>) => {
    const said = `ECRED_${wallet.length}`;
    wallet.push({ sad: { d: said, s: schema, a: { i: issuee, ...data } }, status: { et: 'iss', s: '0' } });
    return { said };
  },
);

const listCredentials = vi.fn(async (kargs?: { filter?: Record<string, unknown> }) => {
  const filter = kargs?.filter ?? {};
  const field = (c: WalletEntry, key: string) =>
    key === '-s' ? c.sad.s : key === '-a-i' ? c.sad.a.i : key === '-d' ? c.sad.d : undefined;
  return wallet.filter((c) => Object.entries(filter).every(([k, v]) => field(c, k) === v));
});

const signifyClient = {
  credentials: () => ({ list: listCredentials }),
  identifiers: () => ({ list: async () => ({ aids: [{ name: 'org', prefix: 'ORGAID' }] }) }),
};

const keriClientMock = {
  getSignifyClient: () => signifyClient,
  getCesrUrl: () => 'http://cesr',
  resolveOOBI: vi.fn(async () => true),
  resolveOOBIWithReason: vi.fn(async () => ({ ok: true, reason: '' })),
  issueCredential,
  grantCredential: vi.fn(async (_i: string, said: string) => ({ said })),
  revokeCredential: vi.fn(async () => {}),
  pushKelToAgent: vi.fn(async () => ({ pushed: 1, failed: 0 })),
  listNotifications: vi.fn(async () => []),
  markNotificationRead: vi.fn(async () => {}),
  getExchange: vi.fn(async () => null),
};

vi.mock('src/lib/keri/client', () => ({ useKERIClient: () => keriClientMock }));
vi.mock('src/lib/keri/registry', () => ({
  getOrCreateOrgRegistry: vi.fn(async () => 'REGID'),
  resolveIssuingRegistry: vi.fn(async () => 'REGID'),
}));
vi.mock('src/lib/clientConfig', () => ({
  getMembershipSchemaSaid: vi.fn(async () => IDSS_MEMBERSHIP_SCHEMA),
  getCommunityDescriptor: vi.fn(async () => ({
    version: '1.1',
    backend_kind: 'idss',
    admins: [],
    schemas: {},
    community: { name: 'Whakatōhea Demo', slug: 'whakatohea-demo', aid: 'ORGAID', oobi: '', registry: 'REGID' },
  })),
}));
vi.mock('src/api/config', () => ({
  fetchOrgConfig: vi.fn(async () => ({
    status: 'configured',
    config: { organization: { aid: 'ORGAID' }, registry: { id: 'REGID' } },
  })),
}));
vi.mock('src/lib/registrationResolve', () => ({
  buildOobiCandidates: () => ['http://cesr/oobi/DAPPLICANT'],
}));
vi.mock('src/lib/api/client', () => ({
  BACKEND_URL: 'http://backend',
  createOrUpdateProfile: vi.fn(async () => ({ success: true })),
  getProfileById: vi.fn(async () => null),
  grantStewardAdmin: vi.fn(async () => ({ success: true })),
  initMemberProfiles: vi.fn(async () => ({ success: true })),
  sendRegistrationApprovedNotification: vi.fn(async () => {}),
  removeMember: vi.fn(async () => ({ success: true })),
}));
vi.mock('src/lib/secureStorage', () => ({
  secureStorage: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}) },
}));
vi.mock('stores/identity', () => ({
  useIdentityStore: () => ({ currentAID: { prefix: 'DADMIN' } }),
}));
vi.mock('stores/profiles', () => ({
  useProfilesStore: () => ({
    loadCommunityProfiles: vi.fn(async () => {}),
    loadCommunityReadOnlyProfiles: vi.fn(async () => {}),
  }),
}));
vi.mock('quasar', () => ({ Notify: { create: vi.fn() } }));

vi.stubGlobal(
  'fetch',
  vi.fn(async () => ({
    ok: true,
    json: async () => ({ success: true, communitySpaceId: 'S', inviteKey: 'K' }),
    text: async () => '',
  })),
);

import { useAdminActions } from 'composables/useAdminActions';
import { createOrUpdateProfile, getProfileById } from 'src/lib/api/client';

const registration: any = {
  notificationId: 'note1',
  applicantAid: 'DAPPLICANT',
  applicantOOBI: 'http://cesr/oobi/DAPPLICANT',
  exnSaid: 'EEXN',
  profile: { name: 'Aroha Te Kani' }, // no email → no email attribute, no notification branch
};

describe('useAdminActions on an IDSS community', () => {
  beforeEach(() => {
    wallet.length = 0;
    issueCredential.mockClear();
    vi.mocked(createOrUpdateProfile).mockClear();
    vi.mocked(getProfileById).mockReset().mockResolvedValue(null);
  });

  it('approve issues the IDSS Membership body (role member, no joinedAt)', async () => {
    const ok = await useAdminActions().approveRegistration(registration);
    expect(ok).toBe(true);
    expect(issueCredential).toHaveBeenCalledTimes(1);
    const [, registry, schema, issuee, data] = issueCredential.mock.calls[0]!;
    expect(registry).toBe('REGID');
    expect(schema).toBe(IDSS_MEMBERSHIP_SCHEMA);
    expect(issuee).toBe('DAPPLICANT');
    expect(data).toEqual({
      communityName: 'Whakatōhea Demo',
      preferred_username: 'aroha-te-kani',
      name: 'Aroha Te Kani',
      role: 'member',
    });
  });

  it('a role change to the steward role re-issues role operator, keeping handle/name/email', async () => {
    wallet.push({
      sad: {
        d: 'EOLD',
        s: IDSS_MEMBERSHIP_SCHEMA,
        a: {
          i: 'DMEMBER',
          communityName: 'Whakatōhea Demo',
          preferred_username: 'kahu',
          name: 'Kahu R',
          email: 'kahu@example.org',
          role: 'member',
        },
      },
      status: { et: 'iss', s: '0' },
    });
    const ok = await useAdminActions().reissueMembershipCredential('DMEMBER', 'Founding Member');
    expect(ok).toBe(true);
    expect(keriClientMock.revokeCredential).toHaveBeenCalledWith('ORGAID', 'EOLD');
    const data = issueCredential.mock.calls[0]![4];
    expect(data).toEqual({
      communityName: 'Whakatōhea Demo',
      preferred_username: 'kahu',
      name: 'Kahu R',
      role: 'operator',
      email: 'kahu@example.org',
    });
    // The CommunityProfile keeps the app's own role string.
    expect(vi.mocked(createOrUpdateProfile)).toHaveBeenCalledWith(
      'CommunityProfile',
      expect.objectContaining({ role: 'Founding Member' }),
      { id: 'CommunityProfile-DMEMBER' },
    );
  });

  it('a role change with no prior IDSS attributes falls back to the SharedProfile', async () => {
    vi.mocked(getProfileById).mockImplementation(async (type: string) =>
      type === 'SharedProfile'
        ? ({ data: { displayName: 'Mere Paewai', publicEmail: 'mere@example.org' } } as Awaited<
            ReturnType<typeof getProfileById>
          >)
        : null,
    );
    const ok = await useAdminActions().reissueMembershipCredential('DMEMBER', 'Contributor');
    expect(ok).toBe(true);
    expect(issueCredential.mock.calls[0]![4]).toEqual({
      communityName: 'Whakatōhea Demo',
      preferred_username: 'mere',
      name: 'Mere Paewai',
      role: 'member',
      email: 'mere@example.org',
    });
  });
});
