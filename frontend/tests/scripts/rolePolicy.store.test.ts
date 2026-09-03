import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useRolePolicyStore } from 'src/stores/rolePolicy';

const policyResponse = {
  policy: {
    version: 2,
    roles: [
      { id: 'member', displayName: 'Member', builtin: true, scope: 'community' },
      { id: 'project_steward', displayName: 'Project Steward', builtin: true, scope: 'project' },
      { id: 'kaitiaki', displayName: 'Kaitiaki', builtin: false, scope: 'community' },
    ],
    grants: { member: ['contribute'], project_steward: ['sign_off'], kaitiaki: ['sign_off'] },
  },
  source: 'synced',
  capabilities: {
    contribute: ['create_contribution'],
    sign_off: ['sign_off_contribution'],
    manage_roles: ['manage_role_policy'],
  },
  capabilityOrder: ['contribute', 'sign_off', 'manage_roles'],
  projectCapabilities: ['contribute', 'sign_off'],
  callerCapabilities: ['contribute', 'manage_roles'],
  capabilityMeta: [
    { id: 'contribute', displayName: 'Contribute', group: 'Projects & Contributions', scope: 'project' },
    { id: 'sign_off', displayName: 'Sign Off', group: 'Projects & Contributions', scope: 'project' },
    { id: 'manage_roles', displayName: 'Manage Roles', group: 'Community', scope: 'community' },
  ],
};

describe('rolePolicy store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
  });

  it('load populates policy and caller capabilities', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify(policyResponse), { status: 200 }),
    ));
    const store = useRolePolicyStore();
    await store.load();
    expect(store.policy?.version).toBe(2);
    expect(store.canManageRoles).toBe(true);
    expect(store.can('sign_off')).toBe(false);
    expect(store.roleOptions.map((r) => r.id)).toEqual(['member', 'project_steward', 'kaitiaki']);
    // Scope split for the two tables.
    expect(store.communityRoles.map((r) => r.id)).toEqual(['member', 'kaitiaki']);
    expect(store.projectRoles.map((r) => r.id)).toEqual(['project_steward']);
    // Column order comes from the server, project caps drive the disabling.
    expect(store.capabilityColumns).toEqual(['contribute', 'sign_off', 'manage_roles']);
    expect(store.isProjectCapability('sign_off')).toBe(true);
    expect(store.isProjectCapability('manage_roles')).toBe(false);
  });

  it('groups capabilities into feature areas for the overview (#319)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify(policyResponse), { status: 200 }),
    ));
    const store = useRolePolicyStore();
    await store.load();
    // One entry per group, in server order, each carrying its capability ids.
    expect(store.featureGroups).toEqual([
      { name: 'Projects & Contributions', capabilities: ['contribute', 'sign_off'] },
      { name: 'Community', capabilities: ['manage_roles'] },
    ]);
    // Labels come from the server metadata; unknown ids fall back to the raw id.
    expect(store.capabilityLabel('manage_roles')).toBe('Manage Roles');
    expect(store.capabilityLabel('unknown_cap')).toBe('unknown_cap');
  });

  it('featureGroups is empty when the backend omits capabilityMeta', async () => {
    const legacy = {
      policy: {
        version: 1,
        roles: [{ id: 'member', displayName: 'Member', builtin: true }],
        grants: { member: ['contribute', 'manage_roles'] },
      },
      source: 'synced',
      capabilities: { contribute: ['create_contribution'], manage_roles: ['manage_role_policy'] },
      callerCapabilities: ['manage_roles'],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify(legacy), { status: 200 })),
    );
    const store = useRolePolicyStore();
    await store.load();
    expect(store.featureGroups).toEqual([]);
  });

  it('falls back gracefully when the backend omits scope/order fields', async () => {
    const legacy = {
      policy: {
        version: 1,
        roles: [{ id: 'member', displayName: 'Member', builtin: true }],
        grants: { member: ['contribute', 'manage_roles'] },
      },
      source: 'synced',
      capabilities: { contribute: ['create_contribution'], manage_roles: ['manage_role_policy'] },
      callerCapabilities: ['manage_roles'],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify(legacy), { status: 200 })),
    );
    const store = useRolePolicyStore();
    await store.load();
    // No scope → treated as community; no order → keys; empty project set →
    // every capability allowed (nothing disabled).
    expect(store.communityRoles.map((r) => r.id)).toEqual(['member']);
    expect(store.projectRoles).toEqual([]);
    expect(store.capabilityColumns).toEqual(['contribute', 'manage_roles']);
    expect(store.isProjectCapability('manage_roles')).toBe(true);
  });

  it('save handles 409 by reloading and reporting conflict', async () => {
    const fetchMock = vi
      .fn()
      // PUT → 409
      .mockResolvedValueOnce(new Response(JSON.stringify({ currentVersion: 3 }), { status: 409 }))
      // reload GET → 200
      .mockResolvedValueOnce(new Response(JSON.stringify(policyResponse), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const store = useRolePolicyStore();
    const ok = await store.save({ version: 1, roles: [], grants: {} });
    expect(ok).toBe(false);
    expect(store.error).toContain('Someone else changed the policy');
    expect(store.policy?.version).toBe(2); // reloaded
  });
});
