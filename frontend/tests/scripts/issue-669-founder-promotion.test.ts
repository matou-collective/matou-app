/**
 * #669 — administrator 2/2: upgrading someone to founding member runs the IDSS
 * promotion rail, not a role-history grant (idss#1948, ADR 0286 d.13).
 *
 * A founding member in this app IS an org-AID signer, so the upgrade is a
 * promotion — the community group identity rotates to include them (the landing
 * issues Administrator per idss#1954) — not a permission grant. These tests pin
 * that behaviour at the admin-actions / multisig seam, on an IDSS backend:
 *
 *   - the promotion rail runs: `upgradeMemberToSteward` rotates the group
 *     (addMemberRound1 + addMemberRound2) to add the member as a signer;
 *   - it is idempotent: a member who is already a signer skips both rounds;
 *   - when the rotation cannot complete, it reports honestly (returns false) and
 *     writes nothing — no credential is re-issued, so the member is NOT shown as
 *     a founding member.
 *
 * Driven through useAdminActions with a mocked signify client and an IDSS
 * descriptor, mirroring admin-actions-idss-membership.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const IDSS_MEMBERSHIP_SCHEMA = 'IBpju1vRXOpF3gG-PXOdkeseqsqr0uD1ut7YN5538x9t';

// Mutable key state, flipped per test to drive the full-rounds / already-signer
// paths. Hoisted so the (hoisted) vi.mock factories can close over it.
const state = vi.hoisted(() => ({
  steward: { s: '0', k: ['KSTEWARD0'] } as { s: string; k: string[] },
  group: { k: ['KADMIN', 'KSOMEONE'], n: ['ndig'], s: '3' } as { k: string[]; n: string[]; s: string },
  admin: { k: ['KADMIN'], s: '2' } as { k: string[]; s: string },
}));

type WalletEntry = { sad: { d: string; s: string; a: Record<string, unknown> & { i: string } }; status: { et: string; s: string } };
const wallet: WalletEntry[] = [];

const issueCredential = vi.fn(
  async (_issuer: string, _registry: string, schema: string, issuee: string, data: Record<string, unknown>) => {
    const said = `ECRED_${wallet.length}`;
    wallet.push({ sad: { d: said, s: schema, a: { i: issuee, ...data } }, status: { et: 'iss', s: '0' } });
    return { said };
  },
);
const listCredentials = vi.fn(async () => wallet.slice());

const addMemberRound1 = vi.fn(async () => {});
const addMemberRound2 = vi.fn(async () => {});
const waitForMemberRotation = vi.fn(async () => {});

const signifyClient = {
  credentials: () => ({ list: listCredentials }),
  identifiers: () => ({
    list: async () => ({ aids: [{ name: 'org', prefix: 'ORGAID' }, { name: 'admin', prefix: 'DADMIN' }] }),
    get: async (name: string) => ({ state: name === 'org' ? state.group : state.admin }),
  }),
  keyStates: () => ({ query: async () => ({ name: 'op' }) }),
  operations: () => ({ wait: async () => ({ response: state.steward }) }),
};

const keriClientMock = {
  getSignifyClient: () => signifyClient,
  getCesrUrl: () => 'http://cesr',
  resolveOOBI: vi.fn(async () => true),
  issueCredential,
  revokeCredential: vi.fn(async () => {}),
  addMemberRound1,
  addMemberRound2,
  waitForMemberRotation,
  pushKelToAgent: vi.fn(async () => ({ pushed: 1, failed: 0 })),
};

vi.mock('src/lib/keri/client', () => ({ useKERIClient: () => keriClientMock }));
vi.mock('src/lib/keri/registry', () => ({
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

import { useAdminActions } from 'composables/useAdminActions';
import { grantStewardAdmin, createOrUpdateProfile } from 'src/lib/api/client';

const STEWARD_AID = 'DMEMBER';

describe('#669 founding-member upgrade runs the IDSS promotion rail', () => {
  beforeEach(() => {
    wallet.length = 0;
    issueCredential.mockClear();
    addMemberRound1.mockReset().mockResolvedValue(undefined);
    addMemberRound2.mockReset().mockResolvedValue(undefined);
    waitForMemberRotation.mockClear();
    vi.mocked(grantStewardAdmin).mockClear();
    vi.mocked(createOrUpdateProfile).mockClear();
    // Default: a member who is not yet a signer → the full rotation runs.
    state.steward = { s: '0', k: ['KSTEWARD0'] };
    state.group = { k: ['KADMIN', 'KSOMEONE'], n: ['ndig'], s: '3' };
    state.admin = { k: ['KADMIN'], s: '2' };
  });

  it('rotates the group identity to add the member as a signer (AC1)', async () => {
    const ok = await useAdminActions().upgradeMemberToSteward(STEWARD_AID, 'Founding Member');
    expect(ok).toBe(true);

    // The promotion rail ran: both rotation rounds fired for this member.
    expect(addMemberRound1).toHaveBeenCalledTimes(1);
    expect(addMemberRound1).toHaveBeenCalledWith('org', STEWARD_AID, 'admin');
    expect(waitForMemberRotation).toHaveBeenCalledWith(STEWARD_AID, '1', expect.anything());
    expect(addMemberRound2).toHaveBeenCalledTimes(1);
    expect(addMemberRound2).toHaveBeenCalledWith('org', STEWARD_AID, 'admin', '1');

    // The upgraded member is granted signer-level any-sync rights (AC3: they can
    // then approve applications and issue/revoke credentials via the steward path).
    expect(vi.mocked(grantStewardAdmin)).toHaveBeenCalledWith(STEWARD_AID);
  });

  it('is idempotent — a member who is already a signer skips both rounds (AC6)', async () => {
    // The member's current signing key is already one of the group's keys, and
    // admin is still a signer: both rounds have already landed.
    state.steward = { s: '5', k: ['KSTEWARD'] };
    state.group = { k: ['KADMIN', 'KSTEWARD'], n: ['ndig'], s: '7' };
    state.admin = { k: ['KADMIN'], s: '6' };

    const ok = await useAdminActions().upgradeMemberToSteward(STEWARD_AID, 'Founding Member');
    expect(ok).toBe(true);
    expect(addMemberRound1).not.toHaveBeenCalled();
    expect(addMemberRound2).not.toHaveBeenCalled();
  });

  it('reports honestly and writes nothing when the rotation cannot complete (AC5)', async () => {
    // The rail refuses / co-signs are unavailable: round 1 throws.
    addMemberRound1.mockRejectedValue(new Error('co-signers unavailable'));

    const ok = await useAdminActions().upgradeMemberToSteward(STEWARD_AID, 'Founding Member');
    expect(ok).toBe(false);

    // No credential re-issue, no profile role write: the member is NOT shown as a
    // founding member, because the rotation that would make them a signer failed.
    expect(addMemberRound2).not.toHaveBeenCalled();
    expect(issueCredential).not.toHaveBeenCalled();
    expect(vi.mocked(createOrUpdateProfile)).not.toHaveBeenCalled();
    expect(vi.mocked(grantStewardAdmin)).not.toHaveBeenCalled();
  });
});
