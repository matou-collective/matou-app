/**
 * identityStore.checkAdminStatus on an IDSS community (idss#1948, ADR 0286 d.13).
 *
 * The steward is decided by signify — whether this identity is a member of the
 * community group AID the descriptor names — NOT by reading a role string. It is
 * the same fact the control panel uses to decide who may sign, and it survives
 * IDSS deleting the `role: operator` string the old check read. A group-AID
 * member IS matou-app's Founding Member (the Administrator: one super user across
 * both apps) and gets every steward power; a non-member is not a steward even if
 * they still hold a legacy operator credential; a coa-shared backend is unchanged.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

const COMMUNITY = 'ECOMMUNITY';
const SCHEMA = 'ISCHEMA';
const ME = 'EFOUNDER';

const state = vi.hoisted(() => ({
  creds: [] as unknown[],
  aids: [] as { prefix: string }[],
  idss: true,
}));

vi.mock('src/lib/api/client', () => ({
  getUserSpaces: vi.fn(async () => ({})),
  verifyCommunityAccess: vi.fn(async () => ({ hasAccess: false })),
  joinCommunity: vi.fn(async () => ({})),
  getAuthChallenge: vi.fn(async () => ({ challenge: '', expiresAt: '' })),
  postAuthLogin: vi.fn(async () => ({ token: '', expiresAt: '' })),
  setSessionToken: vi.fn(),
}));
vi.mock('src/lib/clientConfig', () => ({
  getCommunityAid: vi.fn(async () => COMMUNITY),
  getMembershipSchemaSaid: vi.fn(async () => SCHEMA),
}));
vi.mock('src/api/config', () => ({
  fetchOrgConfig: vi.fn(async () => ({ status: 'not_configured' })),
}));
vi.mock('stores/app', () => ({ useAppStore: () => ({ isIdssBackend: state.idss }) }));
vi.mock('src/lib/keri/client', () => {
  const client = {
    credentials: () => ({ list: async () => state.creds }),
    identifiers: () => ({ list: async () => ({ aids: state.aids }) }),
  };
  const k = { getSignifyClient: () => client, ensureSession: async () => {} };
  return { KERIClient: class {}, useKERIClient: () => k };
});

function membership(role: string, issuee = ME) {
  return { sad: { d: 'ESAID-' + role, s: SCHEMA, i: COMMUNITY, a: { i: issuee, role } } };
}

async function adminFor(opts: {
  creds?: unknown[];
  aids?: { prefix: string }[];
  idss?: boolean;
}) {
  state.creds = opts.creds ?? [];
  state.aids = opts.aids ?? [];
  state.idss = opts.idss ?? true;
  const { useIdentityStore } = await import('../../src/stores/identity');
  const identity = useIdentityStore();
  identity.currentAID = { prefix: ME } as never;
  const ok = await identity.checkAdminStatus();
  return { ok, identity };
}

describe('checkAdminStatus — IDSS steward is a member of the community group AID', () => {
  beforeEach(() => {
    vi.resetModules();
    setActivePinia(createPinia());
  });

  it('a member of the community group AID is an admin with every steward power', async () => {
    const { ok, identity } = await adminFor({ aids: [{ prefix: COMMUNITY }, { prefix: ME }] });
    expect(ok).toBe(true);
    expect(identity.isAdmin).toBe(true);
    expect(identity.isSteward).toBe(true);
    expect(identity.canManageMembers).toBe(true);
    expect(identity.adminCredential?.status).toBe('group_member');
  });

  it('a non-member of the group AID is not an admin — even holding a legacy operator credential', async () => {
    const { ok, identity } = await adminFor({
      creds: [membership('operator')],
      aids: [{ prefix: ME }],
    });
    expect(ok).toBe(false);
    expect(identity.isAdmin).toBe(false);
    expect(identity.adminCredential).toBeNull();
  });

  it('a coa-shared backend does not take the IDSS path', async () => {
    // Not IDSS and the wallet holds no admin credential → not an admin, but the
    // decision came from the non-IDSS methods, not the group-AID check.
    const { ok } = await adminFor({ aids: [{ prefix: COMMUNITY }], idss: false });
    expect(ok).toBe(false);
  });
});
