import { describe, it, expect } from 'vitest';
import { topLevelContributions } from 'src/lib/contributions/nesting';

/**
 * #773 — a sub-contribution with a milestone_id landed in the milestone's
 * contribution list and so was drawn both nested under its parent and again as
 * its own top-level card (and double-counted). topLevelContributions is the
 * filter the plan page applies so a sub shows only under its parent.
 */
describe('topLevelContributions (#773)', () => {
  it('drops a sub whose parent is in the same list', () => {
    const parent = { id: 'ctr_parent' };
    const sub = { id: 'ctr_sub', parent_contribution: 'ctr_parent' };
    const other = { id: 'ctr_other' };

    const top = topLevelContributions([parent, sub, other]);

    expect(top.map((c) => c.id)).toEqual(['ctr_parent', 'ctr_other']);
  });

  it('keeps a top-level contribution with no parent', () => {
    const list = [{ id: 'a' }, { id: 'b' }];
    expect(topLevelContributions(list)).toEqual(list);
  });

  it('keeps a sub whose parent is absent (not orphaned off the page)', () => {
    // Parent lives in another milestone / was archived out of this list.
    const sub = { id: 'ctr_sub', parent_contribution: 'ctr_elsewhere' };
    const other = { id: 'ctr_other' };

    const top = topLevelContributions([sub, other]);

    expect(top.map((c) => c.id)).toEqual(['ctr_sub', 'ctr_other']);
  });

  it('matches a parent referenced by contribution_id', () => {
    // Hydrated contributions may carry both id and contribution_id; a sub may
    // reference either form of its parent's identifier.
    const parent = { id: 'ctr_parent', contribution_id: 'cid_parent' };
    const sub = { id: 'ctr_sub', parent_contribution: 'cid_parent' };

    const top = topLevelContributions([parent, sub]);

    expect(top.map((c) => c.id)).toEqual(['ctr_parent']);
  });

  it('removes every copy of a repeated sub so counts are not inflated', () => {
    const parent = { id: 'p' };
    const subs = Array.from({ length: 3 }, (_, i) => ({
      id: `s${i}`,
      parent_contribution: 'p',
    }));

    const top = topLevelContributions([parent, ...subs]);

    expect(top).toHaveLength(1);
    expect(top[0]!.id).toBe('p');
  });
});
