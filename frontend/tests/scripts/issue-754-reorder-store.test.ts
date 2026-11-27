import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useContributionsStore } from 'src/stores/contributions';
import type { Contribution } from 'src/lib/api/contributions';

function stub(title: string, sort_order?: number): Contribution {
  return {
    id: title,
    project_id: 'p',
    title,
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
    ...(sort_order === undefined ? {} : { sort_order }),
  };
}

describe('contributions store reorder', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
  });

  it('posts ordered_ids to the representative and patches new sort_order into the list', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          contributions: [stub('c', 0), stub('a', 1), stub('b', 2)],
          total: 3,
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const store = useContributionsStore();
    store.contributions = [stub('a', 0), stub('b', 1), stub('c', 2)];

    const result = await store.reorder(['c', 'a', 'b']);

    // Hit the first id's reorder endpoint with the full ordered list.
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/v1/contributions/c/reorder');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ ordered_ids: ['c', 'a', 'b'] });

    expect(result.map(c => c.id)).toEqual(['c', 'a', 'b']);
    // Local list reflects the new sort_order values.
    const byId = Object.fromEntries(store.contributions.map(c => [c.id, c.sort_order]));
    expect(byId).toEqual({ c: 0, a: 1, b: 2 });
  });

  it('surfaces the error and sets store.error on failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'insufficient permissions' }), { status: 403 }),
    ));
    const store = useContributionsStore();
    await expect(store.reorder(['a', 'b'])).rejects.toThrow('insufficient permissions');
    expect(store.error).toBe('insufficient permissions');
  });
});
