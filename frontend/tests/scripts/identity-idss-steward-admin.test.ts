/**
 * identityStore.checkAdminStatus on an IDSS community (Ben, 2026-09-25).
 *
 * The gateway's steward is the member whose Membership credential, issued by the
 * descriptor's community AID in the descriptor's Membership schema, carries
 * `role: operator` (idss credschema.RoleOperator). The old role-name scan only
 * accepted "steward" / "admin" / "founding", so an IDSS founder was never an
 * admin and never saw a pending registration. An operator is a steward; a
 * `role: member` credential is not; a coa-shared backend is unchanged.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

const COMMUNITY = 'ECOMMUNITY';
const SCHEMA = 'ISCHEMA';
const ME = 'EFOUNDER';

const state = vi.hoisted(() => ({ creds: [] as unknown[], idss: true }));

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
    identifiers: () => ({ list: async () => ({ aids: [] }) }),
  };
  const k = { getSignifyClient: () => client, ensureSession: async () => {} };
  return { KERIClient: class {}, useKERIClient: () => k };
});

function membership(role: string, issuee = ME) {
  return { sad: { d: 'ESAID-' + role, s: SCHEMA, i: COMMUNITY, a: { i: issuee, role } } };
}

async function adminFor(creds: unknown[], idss = true) {
  state.creds = creds;
  state.idss = idss;
  const { useIdentityStore } = await import('../../src/stores/identity');
  const identity = useIdentityStore();
  identity.currentAID = { prefix: ME } as never;
  const ok = await identity.checkAdminStatus();
  return { ok, identity };
}

describe('checkAdminStatus — the IDSS operator is the steward', () => {
  beforeEach(() => {
    vi.resetModules();
    setActivePinia(createPinia());
  });

  it('a Membership credential with role operator makes this member an admin with every steward power', async () => {
    const { ok, identity } = await adminFor([membership('operator')]);
    expect(ok).toBe(true);
    expect(identity.isAdmin).toBe(true);
    expect(identity.isSteward).toBe(true);
    expect(identity.canManageMembers).toBe(true);
  });

  it('a plain member (role member) is not an admin', async () => {
    const { ok, identity } = await adminFor([membership('member')]);
    expect(ok).toBe(false);
    expect(identity.isAdmin).toBe(false);
  });

  it("someone else's operator credential does not count", async () => {
    const { ok } = await adminFor([membership('operator', 'ESOMEONE-ELSE')]);
    expect(ok).toBe(false);
  });

  it('a coa-shared backend does not take the IDSS path', async () => {
    const { ok } = await adminFor([membership('operator')], false);
    expect(ok).toBe(false);
  });
});
