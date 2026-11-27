// @vitest-environment happy-dom
/**
 * #749 — Project management buttons showed for users the backend then refused
 * with "insufficient permissions".
 *
 * Root cause: the frontend treated ANY credential whose role string contains
 * "steward"/"admin"/"founding" as a full community admin on every project
 * (identityStore.isAdmin / isSteward are loose substring matches). So a
 * Technical / Financial / Cultural / Community Steward saw Delete/Archive,
 * Assign Lead and Assign Steward on projects they were not assigned to — the
 * backend's RequireProjectAction only grants the community-wide pass to
 * Operations Steward / Founding Member, so the click returned 403.
 *
 * The fix:
 *  - identityStore gains isCommunityAdmin (Operations Steward / Founding Member
 *    only — the same tier as canManageMembers, matching the backend adminScope).
 *  - ProjectDetailPage resolves the community-admin role from isCommunityAdmin
 *    rather than the loose isAdmin, so non-admin stewards fall through to the
 *    per-project project_lead_id / project_steward_id match.
 *  - useProjectPermissions.canAssignRoles now also allows the project's assigned
 *    steward (backend assign_project_role = stewardScope), not admins only.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ref } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import { useProjectPermissions } from 'src/composables/useProjectPermissions';
import type { Project, CurrentUser } from 'src/types/projects';

const USER_ID = 'EUSER_AID';

function project(extra: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    title: 'Marae Restoration',
    status: 'active',
    ...extra,
  } as Project;
}

function perms(user: CurrentUser | null, proj: Project | null = project()) {
  return useProjectPermissions(ref(proj), ref(user));
}

describe('#749 useProjectPermissions — project management guards', () => {
  it('a community admin manages every project', () => {
    const p = perms({ id: USER_ID, name: '', role: 'community_admin' });
    expect(p.canDeleteProject.value).toBe(true);
    expect(p.canAssignRoles.value).toBe(true);
    expect(p.canArchiveProject.value).toBe(true);
  });

  it('a plain member (not assigned) sees none of the management controls', () => {
    const p = perms({ id: USER_ID, name: '', role: 'member' });
    expect(p.canDeleteProject.value).toBe(false);
    expect(p.canAssignRoles.value).toBe(false);
    expect(p.canArchiveProject.value).toBe(false);
  });

  it('a *-Steward credential that resolves to member on an unassigned project sees nothing', () => {
    // This is the #749 case: before the fix the holder resolved to
    // community_admin and saw every control. Now a non-Operations/Founding
    // steward who is not the project's own lead/steward resolves to member.
    const p = perms({ id: USER_ID, name: '', role: 'member' }, project({
      project_lead_id: 'someone-else',
      project_steward_id: 'another-person',
    }));
    expect(p.canDeleteProject.value).toBe(false);
    expect(p.canAssignRoles.value).toBe(false);
    expect(p.canArchiveProject.value).toBe(false);
  });

  it('the project\'s assigned steward may archive and assign roles, but not delete', () => {
    const p = perms(
      { id: USER_ID, name: '', role: 'member' },
      project({ project_steward_id: USER_ID }),
    );
    expect(p.canArchiveProject.value).toBe(true);
    expect(p.canAssignRoles.value).toBe(true); // assign_project_role = stewardScope
    expect(p.canDeleteProject.value).toBe(false); // delete stays admin-only
  });

  it('the project\'s assigned lead may archive but not assign roles', () => {
    const p = perms(
      { id: USER_ID, name: '', role: 'member' },
      project({ project_lead_id: USER_ID }),
    );
    expect(p.canArchiveProject.value).toBe(true);
    expect(p.canAssignRoles.value).toBe(false); // a bare lead cannot assign
    expect(p.canDeleteProject.value).toBe(false);
  });
});

// ── identity store: the narrow community-admin flag ──────────────────────────
// Keep the store's module-level dependencies inert so importing it does not
// reach live KERI / config / API surfaces.
vi.mock('src/lib/keri/client', () => ({
  KERIClient: class {},
  useKERIClient: () => ({
    getSignifyClient: () => null,
    ensureSession: async () => {},
  }),
}));
vi.mock('src/api/config', () => ({ fetchOrgConfig: async () => ({ status: 'not_configured' }) }));
vi.mock('stores/app', () => ({ useAppStore: () => ({ isIdssBackend: false, orgAid: null }) }));
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

describe('#749 identityStore.isCommunityAdmin is narrower than isSteward', () => {
  beforeEach(() => {
    vi.resetModules();
    setActivePinia(createPinia());
  });

  async function withRole(role: string) {
    const { useIdentityStore } = await import('../../src/stores/identity');
    const identity = useIdentityStore();
    identity.adminCredential = {
      said: '',
      schema: '',
      issuer: '',
      issuee: USER_ID,
      status: 'issued',
      role,
    } as never;
    return identity;
  }

  it('Operations Steward and Founding Member ARE community admins', async () => {
    for (const role of ['Operations Steward', 'Founding Member']) {
      const identity = await withRole(role);
      expect(identity.isCommunityAdmin, role).toBe(true);
      expect(identity.canManageMembers, role).toBe(true);
    }
  });

  it('other *-Steward credentials are NOT community admins (but still trip the loose isSteward)', async () => {
    for (const role of ['Technical Steward', 'Financial Steward', 'Cultural Steward', 'Community Steward']) {
      const identity = await withRole(role);
      expect(identity.isCommunityAdmin, role).toBe(false);
      // The loose flag — which the #749 regression relied on — still matches.
      expect(identity.isSteward, role).toBe(true);
    }
  });
});
