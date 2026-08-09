import { describe, it, expect } from 'vitest';
import {
  filterByScope,
  filterByType,
  searchContributions,
  sortContributions,
  applyContributionsView,
} from '../../src/lib/contributionsView';
import type { Contribution } from '../../src/lib/api/contributions';

const ME = 'did:me';

function make(overrides: Partial<Contribution> & Record<string, unknown>): Contribution {
  return {
    id: overrides.id ?? 'c1',
    project_id: 'p1',
    title: 'Title',
    description: 'Description',
    contribution_type: 'technical',
    priority: 'medium',
    status: 'shared',
    objectives: [],
    deliverables: [],
    acceptance_criteria: [],
    skill_requirements: [],
    created_by: 'someone',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  } as Contribution;
}

describe('filterByType', () => {
  const list = [
    make({ id: 'a', contribution_type: 'technical' }),
    make({ id: 'b', contribution_type: 'cultural' }),
    make({ id: 'c', contribution_type: 'governance' }),
  ];

  it('returns everything for "all"', () => {
    expect(filterByType(list, 'all')).toHaveLength(3);
  });

  it('returns everything for empty type', () => {
    expect(filterByType(list, '')).toHaveLength(3);
  });

  it('filters to the matching type', () => {
    const r = filterByType(list, 'cultural');
    expect(r.map((c) => c.id)).toEqual(['b']);
  });
});

describe('filterByScope', () => {
  it('"all" hides archived, rewarded, confirmed, and offers to others', () => {
    const list = [
      make({ id: 'ok', status: 'shared' }),
      make({ id: 'arch', status: 'archived' }),
      make({ id: 'rew', status: 'rewarded' }),
      make({ id: 'plan', status: 'confirmed' }),
      make({ id: 'other-offer', status: 'offered', offered_to: 'did:someone-else' }),
      make({ id: 'my-offer', status: 'offered', offered_to: ME }),
    ];
    const r = filterByScope(list, 'all', ME).map((c) => c.id);
    expect(r).toContain('ok');
    expect(r).toContain('my-offer');
    expect(r).not.toContain('arch');
    expect(r).not.toContain('rew');
    expect(r).not.toContain('plan');
    expect(r).not.toContain('other-offer');
  });

  it('"mine" matches assigned or offered to me, excluding archived and rewarded', () => {
    const list = [
      make({ id: 'assigned', status: 'in_progress', assigned_contributor_id: ME }),
      make({ id: 'offered', status: 'offered', offered_to: ME }),
      make({ id: 'archived-mine', status: 'archived', assigned_contributor_id: ME }),
      make({ id: 'rewarded-mine', status: 'rewarded', assigned_contributor_id: ME }),
      make({ id: 'not-mine', status: 'shared' }),
    ];
    const r = filterByScope(list, 'mine', ME).map((c) => c.id);
    expect(r).toEqual(['assigned', 'offered']);
  });

  it('"open" only shows shared', () => {
    const list = [
      make({ id: 'a', status: 'shared' }),
      make({ id: 'b', status: 'in_progress' }),
    ];
    expect(filterByScope(list, 'open', ME).map((c) => c.id)).toEqual(['a']);
  });

  it('"assigned" covers assigned/changed/in_progress', () => {
    const list = [
      make({ id: 'a', status: 'assigned' }),
      make({ id: 'b', status: 'changed' }),
      make({ id: 'c', status: 'in_progress' }),
      make({ id: 'd', status: 'shared' }),
    ];
    expect(filterByScope(list, 'assigned', ME).map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('"signed_off" only shows signed_off; rewarded has its own chip', () => {
    const list = [
      make({ id: 'a', status: 'signed_off' }),
      make({ id: 'b', status: 'rewarded' }),
      make({ id: 'c', status: 'needs_review' }),
    ];
    expect(filterByScope(list, 'signed_off', ME).map((c) => c.id)).toEqual(['a']);
    expect(filterByScope(list, 'rewarded', ME).map((c) => c.id)).toEqual(['b']);
  });

  it('"archived" only shows archived', () => {
    const list = [
      make({ id: 'a', status: 'archived' }),
      make({ id: 'b', status: 'shared' }),
    ];
    expect(filterByScope(list, 'archived', ME).map((c) => c.id)).toEqual(['a']);
  });
});

describe('searchContributions', () => {
  const list = [
    make({ id: 'a', title: 'Build the marae fence', description: 'woodwork' }),
    make({ id: 'b', title: 'Write docs', description: 'Update the README' }),
    make({ id: 'c', title: 'Design logo', description: 'branding' }),
  ];

  it('returns the full list for an empty query', () => {
    expect(searchContributions(list, '')).toHaveLength(3);
    expect(searchContributions(list, '   ')).toHaveLength(3);
  });

  it('matches the title case-insensitively', () => {
    expect(searchContributions(list, 'MARAE').map((c) => c.id)).toEqual(['a']);
  });

  it('matches the description', () => {
    expect(searchContributions(list, 'readme').map((c) => c.id)).toEqual(['b']);
  });

  it('returns empty when nothing matches', () => {
    expect(searchContributions(list, 'zzz')).toEqual([]);
  });
});

describe('sortContributions', () => {
  it('sorts by deadline ascending with missing deadlines last', () => {
    const list = [
      make({ id: 'none' }),
      make({ id: 'late', deadline: '2026-12-01T00:00:00Z' }),
      make({ id: 'soon', deadline: '2026-02-01T00:00:00Z' }),
    ];
    expect(sortContributions(list, 'deadline', 'asc').map((c) => c.id)).toEqual([
      'soon',
      'late',
      'none',
    ]);
  });

  it('sorts by deadline descending', () => {
    const list = [
      make({ id: 'late', deadline: '2026-12-01T00:00:00Z' }),
      make({ id: 'soon', deadline: '2026-02-01T00:00:00Z' }),
    ];
    expect(sortContributions(list, 'deadline', 'desc').map((c) => c.id)).toEqual([
      'late',
      'soon',
    ]);
  });

  it('does not mutate the input array', () => {
    const list = [
      make({ id: 'b', deadline: '2026-12-01T00:00:00Z' }),
      make({ id: 'a', deadline: '2026-02-01T00:00:00Z' }),
    ];
    const before = list.map((c) => c.id);
    sortContributions(list, 'deadline', 'asc');
    expect(list.map((c) => c.id)).toEqual(before);
  });

  it('sorts by title alphabetically', () => {
    const list = [
      make({ id: 'a', title: 'Zebra' }),
      make({ id: 'b', title: 'apple' }),
      make({ id: 'c', title: 'Mango' }),
    ];
    expect(sortContributions(list, 'title', 'asc').map((c) => c.title)).toEqual([
      'apple',
      'Mango',
      'Zebra',
    ]);
  });

  it('sorts by priority ascending (low → critical)', () => {
    const list = [
      make({ id: 'a', priority: 'critical' }),
      make({ id: 'b', priority: 'low' }),
      make({ id: 'c', priority: 'high' }),
      make({ id: 'd', priority: 'medium' }),
    ];
    expect(sortContributions(list, 'priority', 'asc').map((c) => c.priority)).toEqual([
      'low',
      'medium',
      'high',
      'critical',
    ]);
  });

  it('sorts by created date descending (newest first)', () => {
    const list = [
      make({ id: 'old', created_at: '2026-01-01T00:00:00Z' }),
      make({ id: 'new', created_at: '2026-06-01T00:00:00Z' }),
    ];
    expect(sortContributions(list, 'created', 'desc').map((c) => c.id)).toEqual(['new', 'old']);
  });

  it('uses created_at as a stable tiebreak', () => {
    const list = [
      make({ id: 'b', priority: 'medium', created_at: '2026-02-01T00:00:00Z' }),
      make({ id: 'a', priority: 'medium', created_at: '2026-01-01T00:00:00Z' }),
    ];
    // Same priority → tiebreak keeps earliest created first, both directions.
    expect(sortContributions(list, 'priority', 'asc').map((c) => c.id)).toEqual(['a', 'b']);
    expect(sortContributions(list, 'priority', 'desc').map((c) => c.id)).toEqual(['a', 'b']);
  });
});

describe('applyContributionsView', () => {
  it('composes scope → type → search → sort', () => {
    const list = [
      make({
        id: 'match',
        status: 'shared',
        contribution_type: 'technical',
        title: 'Fix the sync bug',
        deadline: '2026-03-01T00:00:00Z',
      }),
      make({
        id: 'wrong-type',
        status: 'shared',
        contribution_type: 'cultural',
        title: 'Fix the sync bug too',
      }),
      make({ id: 'archived', status: 'archived', contribution_type: 'technical', title: 'Fix' }),
      make({
        id: 'no-search',
        status: 'shared',
        contribution_type: 'technical',
        title: 'Unrelated',
      }),
    ];
    const r = applyContributionsView(list, {
      scope: 'all',
      type: 'technical',
      search: 'fix',
      sortField: 'deadline',
      sortDirection: 'asc',
      currentUserId: ME,
    });
    expect(r.map((c) => c.id)).toEqual(['match']);
  });
});

describe('admin visibility', () => {
  it('"all" keeps offers to other users visible for admins', () => {
    const list = [
      make({ id: 'other-offer', status: 'offered', offered_to: 'did:someone-else' }),
      make({ id: 'my-offer', status: 'offered', offered_to: ME }),
      make({ id: 'plain', status: 'shared' }),
    ];
    const r = filterByScope(list, 'all', ME, { viewerIsAdmin: true }).map((c) => c.id);
    expect(r).toContain('other-offer');
    expect(r).toContain('my-offer');
    expect(r).toContain('plain');
  });

  it('applyContributionsView passes viewerIsAdmin through to the scope filter', () => {
    const list = [
      make({ id: 'other-offer', status: 'offered', offered_to: 'did:someone-else' }),
    ];
    const opts = {
      scope: 'all' as const,
      type: 'all',
      search: '',
      sortField: 'created' as const,
      sortDirection: 'desc' as const,
      currentUserId: ME,
    };
    expect(applyContributionsView(list, opts).map((c) => c.id)).toEqual([]);
    expect(
      applyContributionsView(list, { ...opts, viewerIsAdmin: true }).map((c) => c.id),
    ).toEqual(['other-offer']);
  });
});
