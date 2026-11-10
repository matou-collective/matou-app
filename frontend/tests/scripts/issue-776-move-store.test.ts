import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useContributionsStore } from 'src/stores/contributions';
import type { Contribution } from 'src/lib/api/contributions';

function stub(id: string, milestone_id: string, sort_order?: number): Contribution {
  return {
    id,
    project_id: 'p',
    milestone_id,
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
    ...(sort_order === undefined ? {} : { sort_order }),
  };
}

describe('contributions store move', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
  });

  it('posts milestone_id to the move endpoint and patches the new milestone into the list', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(stub('c1', 'ms2', 0)), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const store = useContributionsStore();
    store.contributions = [stub('c1', 'ms1', 3)];

    const result = await store.move('c1', 'ms2');

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/v1/contributions/c1/move');
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ milestone_id: 'ms2' });

    expect(result.milestone_id).toBe('ms2');
    // Local list reflects the moved contribution's new milestone.
    expect(store.contributions[0]!.milestone_id).toBe('ms2');
  });

  it('surfaces the error and sets store.error on failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'cannot move a sub-contribution between milestones' }), { status: 400 }),
    ));
    const store = useContributionsStore();
    await expect(store.move('sub1', 'ms2')).rejects.toThrow('cannot move a sub-contribution between milestones');
    expect(store.error).toBe('cannot move a sub-contribution between milestones');
  });
});
