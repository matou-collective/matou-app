import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useTypesStore } from 'src/stores/types';
import type { TypeDefinition } from 'src/lib/api/client';

function def(name: string, version: number, fieldNames: string[]): TypeDefinition {
  return {
    name,
    version,
    description: '',
    space: 'community',
    fields: fieldNames.map((n) => ({ name: n, type: 'string', core: n === 'aid' })),
    layouts: { form: { fields: fieldNames } },
    permissions: { read: 'member', write: 'owner' },
  };
}

describe('types store saveDefinition (#401)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
  });

  it('replaces the local copy with the version-bumped definition on success', async () => {
    const updated = def('SharedProfile', 3, ['aid', 'nickname']);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify(updated), { status: 200 })),
    );
    const store = useTypesStore();
    const res = await store.saveDefinition(def('SharedProfile', 2, ['aid', 'nickname']));
    expect(res.ok).toBe(true);
    expect(store.getDefinition('SharedProfile')?.version).toBe(3);
    expect(store.getDefinition('SharedProfile')?.fields.map((f) => f.name)).toEqual([
      'aid',
      'nickname',
    ]);
  });

  it('refetches and reports a conflict on a 409 stale version', async () => {
    const latest = def('SharedProfile', 5, ['aid', 'bio']);
    const fetchMock = vi
      .fn()
      // PUT → 409 stale version
      .mockResolvedValueOnce(new Response(JSON.stringify({ currentVersion: 5 }), { status: 409 }))
      // refetch GET /api/v1/types → 200
      .mockResolvedValueOnce(new Response(JSON.stringify({ types: [latest] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const store = useTypesStore();
    const res = await store.saveDefinition(def('SharedProfile', 2, ['aid']));
    expect(res.ok).toBe(false);
    expect(res.conflict).toBe(true);
    expect(res.error).toMatch(/Someone else changed/i);
    // The store now holds the refetched latest definition.
    expect(store.getDefinition('SharedProfile')?.version).toBe(5);
  });

  it('surfaces the core-invariant / structural 400 message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'core field "aid" may not be removed' }), {
          status: 400,
        }),
      ),
    );
    const store = useTypesStore();
    const res = await store.saveDefinition(def('SharedProfile', 2, ['nickname']));
    expect(res.ok).toBe(false);
    expect(res.conflict).toBeUndefined();
    expect(res.error).toContain('may not be removed');
  });
});
