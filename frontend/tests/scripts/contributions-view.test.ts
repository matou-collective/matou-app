import { describe, it, expect } from 'vitest';
import {
  filterByOwnership,
  filterByStatus,
  filterByType,
  isOfferedToMe,
  isOverdueContribution,
  searchContributions,
  sortContributions,
  applyContributionsView,
  resolveInitialViewMode,
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

describe('filterByOwnership', () => {
  it('"all" keeps everything but hides offers made privately to other users', () => {
    const list = [
      make({ id: 'ok', status: 'shared' }),
      make({ id: 'my-offer', status: 'offered', offered_to: ME }),
      make({ id: 'other-offer', status: 'offered', offered_to: 'did:someone-else' }),
    ];
    const r = filterByOwnership(list, 'all', ME).map((c) => c.id);
    expect(r).toEqual(['ok', 'my-offer']);
  });

  it('"all" keeps offers to other users visible for admins', () => {
    const list = [
      make({ id: 'other-offer', status: 'offered', offered_to: 'did:someone-else' }),
      make({ id: 'ok', status: 'shared' }),
    ];
    const r = filterByOwnership(list, 'all', ME, { viewerIsAdmin: true }).map((c) => c.id);
    expect(r).toEqual(['other-offer', 'ok']);
  });

  it('"mine" matches assigned or offered to me, regardless of status', () => {
    const list = [
      make({ id: 'assigned', status: 'in_progress', assigned_contributor_id: ME }),
      make({ id: 'offered', status: 'offered', offered_to: ME }),
      make({ id: 'archived-mine', status: 'archived', assigned_contributor_id: ME }),
      make({ id: 'not-mine', status: 'shared' }),
    ];
    const r = filterByOwnership(list, 'mine', ME).map((c) => c.id);
    // Ownership no longer hides terminal statuses — the status axis does that.
    expect(r).toEqual(['assigned', 'offered', 'archived-mine']);
  });

  it('"offered_to_me" shows only pending offers addressed to me', () => {
    const list = [
      make({ id: 'to-me', status: 'offered', offered_to: ME }),
      make({ id: 'to-other', status: 'offered', offered_to: 'did:someone-else' }),
      make({ id: 'assigned-me', status: 'in_progress', assigned_contributor_id: ME }),
    ];
    expect(filterByOwnership(list, 'offered_to_me', ME).map((c) => c.id)).toEqual(['to-me']);
  });
});

describe('isOfferedToMe', () => {
  it('is true only for status "offered" addressed to me', () => {
    expect(isOfferedToMe(make({ status: 'offered', offered_to: ME }), ME)).toBe(true);
    expect(isOfferedToMe(make({ status: 'offered', offered_to: 'other' }), ME)).toBe(false);
    expect(isOfferedToMe(make({ status: 'assigned', offered_to: ME }), ME)).toBe(false);
    expect(isOfferedToMe(make({ status: 'offered', offered_to: ME }), '')).toBe(false);
  });
});

describe('filterByStatus', () => {
  it('"all" hides archived, rewarded, and confirmed (planning)', () => {
    const list = [
      make({ id: 'ok', status: 'shared' }),
      make({ id: 'arch', status: 'archived' }),
      make({ id: 'rew', status: 'rewarded' }),
      make({ id: 'plan', status: 'confirmed' }),
    ];
    expect(filterByStatus(list, 'all').map((c) => c.id)).toEqual(['ok']);
  });

  it('"open" only shows shared', () => {
    const list = [
      make({ id: 'a', status: 'shared' }),
      make({ id: 'b', status: 'in_progress' }),
    ];
    expect(filterByStatus(list, 'open').map((c) => c.id)).toEqual(['a']);
  });

  it('"assigned" covers assigned/changed/in_progress', () => {
    const list = [
      make({ id: 'a', status: 'assigned' }),
      make({ id: 'b', status: 'changed' }),
      make({ id: 'c', status: 'in_progress' }),
      make({ id: 'd', status: 'shared' }),
    ];
    expect(filterByStatus(list, 'assigned').map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('"signed_off" and "rewarded" each match only their own status', () => {
    const list = [
      make({ id: 'a', status: 'signed_off' }),
      make({ id: 'b', status: 'rewarded' }),
      make({ id: 'c', status: 'needs_review' }),
    ];
    expect(filterByStatus(list, 'signed_off').map((c) => c.id)).toEqual(['a']);
    expect(filterByStatus(list, 'rewarded').map((c) => c.id)).toEqual(['b']);
    expect(filterByStatus(list, 'in_review').map((c) => c.id)).toEqual(['c']);
  });

  it('"archived" only shows archived', () => {
    const list = [
      make({ id: 'a', status: 'archived' }),
      make({ id: 'b', status: 'shared' }),
    ];
    expect(filterByStatus(list, 'archived').map((c) => c.id)).toEqual(['a']);
  });

  it('"overdue" shows non-terminal items with a past deadline', () => {
    const past = '2000-01-01T00:00:00Z';
    const future = '2999-01-01T00:00:00Z';
    const list = [
      make({ id: 'late-active', status: 'in_progress', deadline: past }),
      make({ id: 'late-done', status: 'signed_off', deadline: past }),
      make({ id: 'late-archived', status: 'archived', deadline: past }),
      make({ id: 'future', status: 'in_progress', deadline: future }),
      make({ id: 'no-deadline', status: 'in_progress' }),
    ];
    expect(filterByStatus(list, 'overdue').map((c) => c.id)).toEqual(['late-active']);
  });
});

describe('isOverdueContribution', () => {
  const now = new Date('2026-06-15T12:00:00Z');

  it('is true for a non-terminal item whose deadline is before today', () => {
    expect(
      isOverdueContribution(make({ status: 'in_progress', deadline: '2026-06-10T00:00:00Z' }), now),
    ).toBe(true);
  });

  it('is false for terminal statuses even with a past deadline', () => {
    for (const status of ['signed_off', 'rewarded', 'completed', 'archived']) {
      expect(
        isOverdueContribution(make({ status, deadline: '2026-06-10T00:00:00Z' }), now),
      ).toBe(false);
    }
  });

  it('is false with no deadline or a future deadline', () => {
    expect(isOverdueContribution(make({ status: 'in_progress' }), now)).toBe(false);
    expect(
      isOverdueContribution(make({ status: 'in_progress', deadline: '2026-07-01T00:00:00Z' }), now),
    ).toBe(false);
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

  it('matches the derived reference (issue #753)', () => {
    const refList = [
      make({ id: 'a', title: 'Audit planning', reference: '1.2.0' }),
      make({ id: 'b', title: 'Onboarding', reference: '1.2.1' }),
      make({ id: 'c', title: 'Branding', reference: '2.1.0' }),
    ];
    expect(searchContributions(refList, '1.2.1').map((c) => c.id)).toEqual(['b']);
    // A prefix query matches every reference under it.
    expect(searchContributions(refList, '1.2.').map((c) => c.id)).toEqual(['a', 'b']);
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
  it('composes ownership → status → type → search → sort', () => {
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
      ownership: 'all',
      status: 'all',
      type: 'technical',
      search: 'fix',
      sortField: 'deadline',
      sortDirection: 'asc',
      currentUserId: ME,
    });
    expect(r.map((c) => c.id)).toEqual(['match']);
  });

  it('ANDs the ownership and status axes: "Mine" + "Assigned" (issue #809)', () => {
    const list = [
      make({ id: 'mine-assigned', status: 'in_progress', assigned_contributor_id: ME }),
      make({ id: 'mine-signed-off', status: 'signed_off', assigned_contributor_id: ME }),
      make({ id: 'mine-offered', status: 'offered', offered_to: ME }),
      make({ id: 'other-assigned', status: 'in_progress', assigned_contributor_id: 'did:other' }),
    ];
    const r = applyContributionsView(list, {
      ownership: 'mine',
      status: 'assigned',
      type: 'all',
      search: '',
      sortField: 'created',
      sortDirection: 'asc',
      currentUserId: ME,
    });
    // Only my in-progress/assigned work — signed-off and offered dropped.
    expect(r.map((c) => c.id)).toEqual(['mine-assigned']);
  });

  it('"Offered to me" isolates pending offers addressed to me', () => {
    const list = [
      make({ id: 'to-me', status: 'offered', offered_to: ME }),
      make({ id: 'to-other', status: 'offered', offered_to: 'did:other' }),
      make({ id: 'assigned-me', status: 'in_progress', assigned_contributor_id: ME }),
    ];
    const r = applyContributionsView(list, {
      ownership: 'offered_to_me',
      status: 'all',
      type: 'all',
      search: '',
      sortField: 'created',
      sortDirection: 'asc',
      currentUserId: ME,
    });
    expect(r.map((c) => c.id)).toEqual(['to-me']);
  });

  it('passes viewerIsAdmin through to the ownership filter', () => {
    const list = [
      make({ id: 'other-offer', status: 'offered', offered_to: 'did:someone-else' }),
    ];
    const opts = {
      ownership: 'all' as const,
      status: 'all' as const,
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

describe('resolveInitialViewMode', () => {
  it('defaults to list when no preference is stored', () => {
    expect(resolveInitialViewMode(null)).toBe('list');
  });

  it('honors an explicitly stored timeline preference', () => {
    expect(resolveInitialViewMode('timeline')).toBe('timeline');
  });

  it('honors an explicitly stored list preference', () => {
    expect(resolveInitialViewMode('list')).toBe('list');
  });

  it('falls back to list for an unrecognized stored value', () => {
    expect(resolveInitialViewMode('grid')).toBe('list');
    expect(resolveInitialViewMode('')).toBe('list');
  });
});
