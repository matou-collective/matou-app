/**
 * Projects view logic
 *
 * Pure functions that compose the Projects list view for both the "My
 * Projects" and "All Projects" sections. Kept free of Vue and store
 * dependencies so the show/hide behaviour can be unit-tested directly.
 *
 * Completed and archived projects are terminal states hidden from the
 * default view; each has its own affordance to reveal it (a toggle in "My
 * Projects", a filter pill in "All Projects").
 */
import type { Project } from 'src/lib/api/projects';

/** The three mutually-exclusive views of the "My Projects" section. */
export type MyProjectsView = 'active' | 'completed' | 'archived';

/** Filter pills of the "All Projects" section. */
export type AllProjectsFilter = 'all' | 'active' | 'created' | 'completed' | 'archived';

/**
 * "My Projects" filter.
 *
 * The default 'active' view hides both archived and completed projects; the
 * 'completed' and 'archived' toggles each reveal only that terminal state.
 */
export function filterMyProjects(list: Project[], view: MyProjectsView): Project[] {
  switch (view) {
    case 'archived':
      return list.filter((p) => p.status === 'archived');
    case 'completed':
      return list.filter((p) => p.status === 'completed');
    case 'active':
    default:
      return list.filter((p) => p.status !== 'archived' && p.status !== 'completed');
  }
}

/**
 * "All Projects" filter.
 *
 * The default 'all' filter hides completed projects — the "Completed" pill
 * reveals them on demand. Every other filter matches its status exactly.
 */
export function filterAllProjects(list: Project[], filter: AllProjectsFilter): Project[] {
  if (filter === 'all') return list.filter((p) => p.status !== 'completed');
  return list.filter((p) => p.status === filter);
}

function createdTime(v?: string): number {
  return v ? new Date(v).getTime() : 0;
}

/** Newest first, by created_at. Returns a new array; does not mutate input. */
export function sortByCreatedDesc(list: Project[]): Project[] {
  return [...list].sort((a, b) => createdTime(b.created_at) - createdTime(a.created_at));
}
