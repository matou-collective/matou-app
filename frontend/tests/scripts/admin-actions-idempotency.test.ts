/**
 * Cross-device approval idempotency (issue #480, follow-up to #470 / #466).
 *
 * `approveRegistration`'s `isProcessing` guard is per-JS-instance, so two linked
 * steward devices sharing one KERIA agent can both reach Approve for the same
 * applicant. On a shared agent both devices see the same wallet, so the guard
 * added in #480 re-checks the wallet before issuing: if the membership
 * credential is already present, the second approval bails without issuing a
 * second ACDC / TEL event / grant.
 *
 * This exercises the real `isCredentialAlreadyIssued` guard inside
 * `approveRegistration` against a mocked signify client whose wallet gains the
 * credential after the first issuance — proving exactly one `issueCredential`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Shared mocked KERIA wallet (both "devices" list the same agent) ---------
type WalletEntry = { sad: { d: string; s: string; a: { i: string } }; status: { et: string; s: string } };
const wallet: WalletEntry[] = [];

const issueCredential = vi.fn(
  async (_issuer: string, _registry: string, schema: string, issuee: string) => {
    const said = `ECRED_${wallet.length}`;
    wallet.push({ sad: { d: said, s: schema, a: { i: issuee } }, status: { et: 'iss', s: '0' } });
    return { said };
  },
);

/**
 * Emulates KERIA's credential query as signify-ts drives it: Seeker equality
 * filters on `-s` / `-a-i` and signify-ts's default `limit` of 25 when none is
 * given. The guard is only as good as the query it issues — a mock returning
 * the whole wallet would hide an unfiltered lookup that truncates in prod.
 */
const listCredentials = vi.fn(
  async (kargs?: { filter?: Record<string, unknown>; limit?: number; skip?: number }) => {
    const filter = kargs?.filter ?? {};
    const field = (c: WalletEntry, key: string) =>
      key === '-s' ? c.sad.s : key === '-a-i' ? c.sad.a.i : key === '-d' ? c.sad.d : undefined;
    const matched = wallet.filter((c) => Object.entries(filter).every(([k, v]) => field(c, k) === v));
    return matched.slice(0, kargs?.limit ?? 25);
  },
);

const signifyClient = {
  credentials: () => ({ list: listCredentials }),
  identifiers: () => ({
    list: async () => ({ aids: [{ name: 'org', prefix: 'ORGAID' }] }),
  }),
};

const keriClientMock = {
  getSignifyClient: () => signifyClient,
  getCesrUrl: () => 'http://cesr',
  resolveOOBIWithReason: vi.fn(async () => ({ ok: true, reason: '' })),
  issueCredential,
  pushKelToAgent: vi.fn(async () => ({ pushed: 1, failed: 0 })),
  listNotifications: vi.fn(async () => []),
  markNotificationRead: vi.fn(async () => {}),
  getExchange: vi.fn(async () => null),
};

vi.mock('src/lib/keri/client', () => ({ useKERIClient: () => keriClientMock }));
vi.mock('src/lib/keri/registry', () => ({
  getOrCreateOrgRegistry: vi.fn(async () => 'REGID'),
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

const notifyCreate = vi.fn();
vi.mock('quasar', () => ({ Notify: { create: (...a: unknown[]) => notifyCreate(...a) } }));

vi.stubGlobal(
  'fetch',
  vi.fn(async () => ({
    ok: true,
    json: async () => ({ success: true, communitySpaceId: 'S', inviteKey: 'K' }),
    text: async () => '',
  })),
);

// Imported AFTER the mocks are registered.
import { useAdminActions, MEMBERSHIP_SCHEMA_SAID } from 'composables/useAdminActions';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const registration: any = {
  notificationId: 'note1',
  applicantAid: 'DAPPLICANT',
  applicantOOBI: 'http://cesr/oobi/DAPPLICANT',
  exnSaid: 'EEXN',
  profile: { name: 'Alice' }, // no email → skips the email-notification branch
};

describe('approveRegistration cross-device idempotency (issue #480)', () => {
  beforeEach(() => {
    wallet.length = 0;
    issueCredential.mockClear();
    listCredentials.mockClear();
    notifyCreate.mockClear();
  });

  it('issues the membership credential exactly once across two devices', async () => {
    // Two composable instances = two linked devices, each with its own
    // per-JS-instance isProcessing ref, but the same shared KERIA wallet.
    const deviceA = useAdminActions();
    const deviceB = useAdminActions();

    const firstOk = await deviceA.approveRegistration(registration);
    expect(firstOk).toBe(true);
    expect(issueCredential).toHaveBeenCalledTimes(1);

    // Device B approves the same (now-stale) pending entry: the wallet already
    // holds the credential, so it must bail without a second issuance.
    const secondOk = await deviceB.approveRegistration(registration);
    expect(secondOk).toBe(true);
    expect(issueCredential).toHaveBeenCalledTimes(1);

    expect(notifyCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('already approved on another device'),
      }),
    );
  });

  it('still issues when a DIFFERENT applicant already holds a credential', async () => {
    wallet.push({
      sad: { d: 'EOTHER', s: 'ESCHEMA_membership_other', a: { i: 'DSOMEONEELSE' } },
      status: { et: 'iss', s: '0' },
    });

    const admin = useAdminActions();
    const ok = await admin.approveRegistration(registration);

    expect(ok).toBe(true);
    expect(issueCredential).toHaveBeenCalledTimes(1);
  });

  it('still catches the duplicate when the org wallet already holds more than 25 credentials', async () => {
    // A real org agent's wallet holds every membership credential it ever
    // issued. Seed 30 other members so the applicant's credential lands past
    // signify-ts's default page — an unfiltered lookup would miss it and
    // device B would issue a second credential.
    for (let i = 0; i < 30; i++) {
      wallet.push({
        sad: { d: `EMEMBER_${i}`, s: MEMBERSHIP_SCHEMA_SAID, a: { i: `DMEMBER_${i}` } },
        status: { et: 'iss', s: '0' },
      });
    }

    const deviceA = useAdminActions();
    const deviceB = useAdminActions();

    expect(await deviceA.approveRegistration(registration)).toBe(true);
    expect(await deviceB.approveRegistration(registration)).toBe(true);
    expect(issueCredential).toHaveBeenCalledTimes(1);
    expect(listCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: expect.objectContaining({ '-a-i': 'DAPPLICANT', '-s': MEMBERSHIP_SCHEMA_SAID }),
      }),
    );
  });

  it('re-issues for an applicant whose earlier membership credential was REVOKED (removed member re-applies)', async () => {
    wallet.push({
      sad: { d: 'EREVOKED', s: MEMBERSHIP_SCHEMA_SAID, a: { i: 'DAPPLICANT' } },
      status: { et: 'rev', s: '1' },
    });

    const admin = useAdminActions();
    const ok = await admin.approveRegistration(registration);

    expect(ok).toBe(true);
    expect(issueCredential).toHaveBeenCalledTimes(1);
    expect(notifyCreate).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('already approved') }),
    );
  });
});
