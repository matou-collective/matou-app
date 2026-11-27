import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useContributionsStore } from 'src/stores/contributions';
import type { Contribution } from 'src/lib/api/contributions';

function stub(id: string, extra: Partial<Contribution> = {}): Contribution {
  return {
    id,
    project_id: 'p',
    title: id,
    description: '',
    contribution_type: 'technical',
    priority: 'medium',
    status: 'created',
    objectives: [],
    deliverables: [],
    acceptance_criteria: [],
    skill_requirements: [],
    created_by: 'u',
    created_at: '',
    updated_at: '',
    ...extra,
  };
}

describe('contributions store promoteSub', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
  });

  it('POSTs to the promote endpoint, patches the detached child, and drops it from its former parent', async () => {
    // Backend returns the promoted child: no parent, now carrying the milestone.
    const promoted = stub('sub', { milestone_id: 'ms-1', sort_order: 3 });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(promoted), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const store = useContributionsStore();
    store.contributions = [
      stub('parent', { child_contributions: ['sub', 'other'] }),
      stub('sub', { parent_contribution: 'parent' }),
      stub('other', { parent_contribution: 'parent' }),
    ];

    const result = await store.promoteSub('sub');

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/v1/contributions/sub/promote');
    expect((init as RequestInit).method).toBe('POST');

    // The returned child is patched in with no parent and the milestone set.
    expect(result.parent_contribution ?? '').toBe('');
    expect(result.milestone_id).toBe('ms-1');
    const sub = store.contributions.find(c => c.id === 'sub');
    expect(sub?.milestone_id).toBe('ms-1');

    // The former parent no longer lists the promoted child, but keeps the rest.
    const parent = store.contributions.find(c => c.id === 'parent');
    expect(parent?.child_contributions).toEqual(['other']);
  });

  it('surfaces the error and sets store.error on failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'insufficient permissions' }), { status: 403 }),
    ));
    const store = useContributionsStore();
    store.contributions = [stub('sub', { parent_contribution: 'parent' })];
    await expect(store.promoteSub('sub')).rejects.toThrow('insufficient permissions');
    expect(store.error).toBe('insufficient permissions');
  });
});
