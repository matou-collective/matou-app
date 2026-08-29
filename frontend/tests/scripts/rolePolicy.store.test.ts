import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useRolePolicyStore } from 'src/stores/rolePolicy';

const policyResponse = {
  policy: {
    version: 2,
    roles: [
      { id: 'member', displayName: 'Member', builtin: true },
      { id: 'kaitiaki', displayName: 'Kaitiaki', builtin: false },
    ],
    grants: { member: ['contribute'], kaitiaki: ['sign_off'] },
  },
  source: 'synced',
  capabilities: { contribute: ['create_contribution'], sign_off: ['sign_off_contribution'] },
  callerCapabilities: ['contribute', 'manage_roles'],
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
    expect(store.roleOptions.map((r) => r.id)).toEqual(['member', 'kaitiaki']);
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
