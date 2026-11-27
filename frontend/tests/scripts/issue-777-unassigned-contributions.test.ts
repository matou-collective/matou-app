import { describe, it, expect } from 'vitest';
import { unassignedContributions } from 'src/lib/contributions/nesting';

/**
 * #777 — the implementation plan draft needs a place for contributions that
 * aren't yet assigned to a milestone. `unassignedContributions` is the filter
 * the plan page applies to the project's contributions to populate that
 * holding area.
 */
describe('unassignedContributions (#777)', () => {
  it('keeps top-level contributions with no milestone_id', () => {
    const list = [
      { id: 'a' },
      { id: 'b', milestone_id: '' },
    ];
    expect(unassignedContributions(list).map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('drops contributions that are already in a milestone', () => {
    const list = [
      { id: 'a', milestone_id: 'ms_1' },
      { id: 'b' },
    ];
    expect(unassignedContributions(list).map((c) => c.id)).toEqual(['b']);
  });

  it('drops archived contributions even when they have no milestone', () => {
    const list = [
      { id: 'a', status: 'archived' },
      { id: 'b', status: 'created' },
    ];
    expect(unassignedContributions(list).map((c) => c.id)).toEqual(['b']);
  });

  it('does not treat a sub-contribution as unassigned when its parent is present', () => {
    // Subs carry no milestone_id but belong to their parent, not the holding
    // area — they must stay nested under the parent, never show standalone.
    const parent = { id: 'ctr_parent', milestone_id: 'ms_1' };
    const sub = { id: 'ctr_sub', parent_contribution: 'ctr_parent' };
    const loose = { id: 'ctr_loose' };

    expect(unassignedContributions([parent, sub, loose]).map((c) => c.id)).toEqual([
      'ctr_loose',
    ]);
  });

  it('returns an empty list when every contribution is assigned', () => {
    const list = [
      { id: 'a', milestone_id: 'ms_1' },
      { id: 'b', milestone_id: 'ms_2' },
    ];
    expect(unassignedContributions(list)).toEqual([]);
  });
});
