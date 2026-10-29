/**
 * Top-level vs. nested contribution display, mirroring how the plan page draws
 * a milestone: each sub-contribution is shown nested under its parent (via the
 * parent's `child_contributions`), never as its own top-level card.
 *
 * A sub is meant to carry no `milestone_id` and resolve its milestone through
 * its parent, so it never lands in a milestone's contribution list. A sub that
 * *does* carry a `milestone_id` (passed to add_contribution alongside a
 * parent, or created before that was disallowed) is added to the milestone's
 * list too — so without this filter it shows twice: once nested under its
 * parent and once as a top-level card, and it is counted twice in the
 * milestone's contribution count, progress and budget. See #773.
 */

/** Minimal shape needed to decide whether a contribution nests under a parent. */
export interface NestableContribution {
  id: string;
  contribution_id?: string;
  parent_contribution?: string;
}

/**
 * Drops any contribution whose parent is present in the same list — those are
 * drawn nested under their parent, so they must not appear as top-level cards.
 *
 * A sub whose parent is absent from the list (e.g. the parent lives in another
 * milestone, or was archived) is kept, so it is never orphaned off the page.
 */
export function topLevelContributions<T extends NestableContribution>(all: T[]): T[] {
  const ids = new Set<string>();
  for (const c of all) {
    ids.add(c.id);
    if (c.contribution_id) ids.add(c.contribution_id);
  }
  return all.filter((c) => !(c.parent_contribution && ids.has(c.parent_contribution)));
}
