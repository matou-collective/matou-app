/**
 * Contributions view logic
 *
 * Pure functions that compose the Contributions list/timeline view:
 * scope filter → type filter → text search → sort. Kept free of Vue and
 * store dependencies so the toolbar behaviour can be unit-tested directly.
 */
import type { Contribution } from 'src/lib/api/contributions';

export type ScopeFilter =
  | 'all'
  | 'mine'
  | 'open'
  | 'assigned'
  | 'in_review'
  | 'signed_off'
  | 'archived';

export type SortField = 'deadline' | 'created' | 'title' | 'priority';
export type SortDirection = 'asc' | 'desc';

export const SCOPE_FILTERS: { label: string; value: ScopeFilter }[] = [
  { label: 'All', value: 'all' },
  { label: 'Mine', value: 'mine' },
  { label: 'Open', value: 'open' },
  { label: 'Assigned', value: 'assigned' },
  { label: 'In Review', value: 'in_review' },
  { label: 'Signed Off', value: 'signed_off' },
  { label: 'Archived', value: 'archived' },
];

export const TYPE_FILTERS: { label: string; value: string }[] = [
  { label: 'Any Type', value: 'all' },
  { label: 'Governance', value: 'governance' },
  { label: 'Technical', value: 'technical' },
  { label: 'Cultural', value: 'cultural' },
  { label: 'Community', value: 'community' },
];

export const SORT_FIELDS: { label: string; value: SortField }[] = [
  { label: 'Deadline', value: 'deadline' },
  { label: 'Created', value: 'created' },
  { label: 'Title', value: 'title' },
  { label: 'Priority', value: 'priority' },
];

const ASSIGNED_STATUSES = new Set(['assigned', 'changed', 'in_progress']);
const SIGNED_OFF_STATUSES = new Set(['signed_off', 'rewarded']);

// low → critical. Unknown priorities sort below 'low'.
const PRIORITY_ORDER: Record<string, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/** Assigned to me OR privately offered to me. */
export function isMineContribution(c: Contribution, me: string): boolean {
  const raw = c as typeof c & { assigned_contributor?: string; offered_to?: string };
  const assigned = raw.assigned_contributor_id ?? raw.assigned_contributor;
  if (assigned === me) return true;
  if (raw.offered_to === me) return true;
  return false;
}

export function filterByScope(
  list: Contribution[],
  scope: ScopeFilter,
  me: string,
): Contribution[] {
  switch (scope) {
    case 'mine':
      // Assigned to me OR offered to me. Excludes archived.
      return list.filter((c) => c.status !== 'archived' && !!me && isMineContribution(c, me));
    case 'all':
      // Hide planning ('confirmed'), hide private offers to other users,
      // and hide archived (archived has its own chip).
      return list.filter((c) => {
        if (c.status === 'archived') return false;
        if (c.status === 'confirmed') return false;
        const raw = c as typeof c & { offered_to?: string };
        if (c.status === 'offered' && raw.offered_to && raw.offered_to !== me) return false;
        return true;
      });
    case 'open':
      return list.filter((c) => c.status === 'shared');
    case 'assigned':
      return list.filter((c) => ASSIGNED_STATUSES.has(c.status));
    case 'in_review':
      return list.filter((c) => c.status === 'needs_review');
    case 'signed_off':
      return list.filter((c) => SIGNED_OFF_STATUSES.has(c.status));
    case 'archived':
      return list.filter((c) => c.status === 'archived');
    default:
      return list;
  }
}

export function filterByType(list: Contribution[], type: string): Contribution[] {
  if (!type || type === 'all') return list;
  return list.filter((c) => c.contribution_type === type);
}

/** Case-insensitive substring match against title and description. */
export function searchContributions(list: Contribution[], query: string): Contribution[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter(
    (c) =>
      (c.title ?? '').toLowerCase().includes(q) ||
      (c.description ?? '').toLowerCase().includes(q),
  );
}

function timeOrInfinity(v?: string): number {
  return v ? new Date(v).getTime() : Number.POSITIVE_INFINITY;
}

function createdTime(v?: string): number {
  return v ? new Date(v).getTime() : 0;
}

function compareField(a: Contribution, b: Contribution, field: SortField): number {
  switch (field) {
    case 'deadline': {
      // Missing deadlines sort last (ascending); equal/both-missing tie.
      const da = timeOrInfinity(a.deadline);
      const db = timeOrInfinity(b.deadline);
      return da === db ? 0 : da - db;
    }
    case 'created': {
      const ca = createdTime(a.created_at);
      const cb = createdTime(b.created_at);
      return ca - cb;
    }
    case 'title':
      return (a.title ?? '').localeCompare(b.title ?? '', undefined, { sensitivity: 'base' });
    case 'priority': {
      const pa = PRIORITY_ORDER[a.priority] ?? -1;
      const pb = PRIORITY_ORDER[b.priority] ?? -1;
      return pa - pb;
    }
    default:
      return 0;
  }
}

export function sortContributions(
  list: Contribution[],
  field: SortField,
  direction: SortDirection,
): Contribution[] {
  const dir = direction === 'desc' ? -1 : 1;
  return [...list].sort((a, b) => {
    const primary = dir * compareField(a, b, field);
    if (primary !== 0) return primary;
    // Stable secondary sort on created_at (ascending) so equal keys keep a
    // deterministic order regardless of the chosen direction.
    return createdTime(a.created_at) - createdTime(b.created_at);
  });
}

export interface ContributionsViewOptions {
  scope: ScopeFilter;
  type: string;
  search: string;
  sortField: SortField;
  sortDirection: SortDirection;
  currentUserId: string;
}

/** Compose scope filter → type filter → search → sort. */
export function applyContributionsView(
  list: Contribution[],
  opts: ContributionsViewOptions,
): Contribution[] {
  let out = filterByScope(list, opts.scope, opts.currentUserId);
  out = filterByType(out, opts.type);
  out = searchContributions(out, opts.search);
  out = sortContributions(out, opts.sortField, opts.sortDirection);
  return out;
}
