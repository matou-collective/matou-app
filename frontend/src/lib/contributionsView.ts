/**
 * Contributions view logic
 *
 * Pure functions that compose the Contributions list/timeline view:
 * ownership filter → status filter → type filter → text search → sort. The
 * ownership and status axes are independent and combine with AND, so a user
 * can ask for e.g. "Mine" AND "Assigned" at once (issue #809). Kept free of
 * Vue and store dependencies so the toolbar behaviour can be unit-tested
 * directly.
 */
import type { Contribution } from 'src/lib/api/contributions';

/** Ownership/relationship axis (single-select): who the contribution is for. */
export type OwnershipFilter = 'all' | 'mine' | 'offered_to_me';

/** Status axis (single-select): the lifecycle state (plus the Overdue view). */
export type StatusFilter =
  | 'all'
  | 'open'
  | 'assigned'
  | 'in_review'
  | 'signed_off'
  | 'rewarded'
  | 'archived'
  | 'overdue';

export type SortField = 'deadline' | 'created' | 'title' | 'priority';
export type SortDirection = 'asc' | 'desc';

export type ViewMode = 'list' | 'timeline';

/**
 * Resolve the initial Contributions view mode from a persisted preference.
 *
 * Default is List on all platforms: an explicitly stored 'timeline' preference
 * is honored, while no stored value or any unrecognized value falls back to
 * 'list'.
 */
export function resolveInitialViewMode(stored: string | null): ViewMode {
  return stored === 'timeline' ? 'timeline' : 'list';
}

export const OWNERSHIP_FILTERS: { label: string; value: OwnershipFilter }[] = [
  { label: 'All', value: 'all' },
  { label: 'Mine', value: 'mine' },
  { label: 'Offered to me', value: 'offered_to_me' },
];

export const STATUS_FILTERS: { label: string; value: StatusFilter }[] = [
  { label: 'All', value: 'all' },
  { label: 'Open', value: 'open' },
  { label: 'Assigned', value: 'assigned' },
  { label: 'In Review', value: 'in_review' },
  { label: 'Signed Off', value: 'signed_off' },
  { label: 'Rewarded', value: 'rewarded' },
  { label: 'Archived', value: 'archived' },
  { label: 'Overdue', value: 'overdue' },
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
// Terminal statuses hidden from the default status view; each has its own chip.
const HIDDEN_TERMINAL_STATUSES = new Set(['archived', 'rewarded']);
// Statuses where a passed deadline no longer means "someone must act". Shared
// with the timeline view's Overdue section so the list and timeline agree.
export const TERMINAL_STATUSES = new Set([
  'signed_off',
  'rewarded',
  'completed',
  'archived',
]);

// low → critical. Unknown priorities sort below 'low'.
const PRIORITY_ORDER: Record<string, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/** Assigned to me OR privately offered to me. */
export function isMineContribution(c: Contribution, me: string): boolean {
  const raw = c as typeof c & { assigned_contributor?: string };
  const assigned = c.assigned_contributor_id ?? raw.assigned_contributor;
  if (assigned === me) return true;
  if (c.offered_to === me) return true;
  return false;
}

/** Privately offered to me and still awaiting my response. */
export function isOfferedToMe(c: Contribution, me: string): boolean {
  return !!me && c.status === 'offered' && c.offered_to === me;
}

/**
 * Overdue = still-active work whose deadline has already passed. Matches the
 * Overdue section of ContributionsTimelineView (non-terminal status, deadline
 * before the start of today). Shared so the list filter and the timeline agree.
 */
export function isOverdueContribution(c: Contribution, now: Date = new Date()): boolean {
  if (!c.deadline) return false;
  if (TERMINAL_STATUSES.has(c.status)) return false;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const deadlineMs = new Date(c.deadline).getTime();
  if (Number.isNaN(deadlineMs)) return false;
  return deadlineMs < startOfToday;
}

export interface ScopeFilterOptions {
  /** Admins see everything, including offers made privately to other users. */
  viewerIsAdmin?: boolean;
}

/**
 * Ownership/relationship axis. Combines (ANDs) with the status axis, so the
 * terminal-status and planning hiding that the default list does lives on the
 * status axis — this axis only narrows by who the contribution is for.
 */
export function filterByOwnership(
  list: Contribution[],
  ownership: OwnershipFilter,
  me: string,
  opts: ScopeFilterOptions = {},
): Contribution[] {
  switch (ownership) {
    case 'mine':
      // Assigned to me OR offered to me.
      return list.filter((c) => !!me && isMineContribution(c, me));
    case 'offered_to_me':
      // Privately offered to me, awaiting my response.
      return list.filter((c) => isOfferedToMe(c, me));
    case 'all':
    default:
      // Non-admins never see offers made privately to other users.
      return list.filter((c) => {
        if (!opts.viewerIsAdmin && c.status === 'offered' && c.offered_to && c.offered_to !== me) {
          return false;
        }
        return true;
      });
  }
}

/**
 * Status axis. Combines (ANDs) with the ownership axis. The default ('all')
 * hides planning drafts ('confirmed') and the terminal statuses that each have
 * their own chip (archived/rewarded); every other value is an exact match.
 */
export function filterByStatus(list: Contribution[], status: StatusFilter): Contribution[] {
  switch (status) {
    case 'open':
      return list.filter((c) => c.status === 'shared');
    case 'assigned':
      return list.filter((c) => ASSIGNED_STATUSES.has(c.status));
    case 'in_review':
      return list.filter((c) => c.status === 'needs_review');
    case 'signed_off':
      return list.filter((c) => c.status === 'signed_off');
    case 'rewarded':
      return list.filter((c) => c.status === 'rewarded');
    case 'archived':
      return list.filter((c) => c.status === 'archived');
    case 'overdue':
      return list.filter((c) => isOverdueContribution(c));
    case 'all':
    default:
      return list.filter(
        (c) => c.status !== 'confirmed' && !HIDDEN_TERMINAL_STATUSES.has(c.status),
      );
  }
}

export function filterByType(list: Contribution[], type: string): Contribution[] {
  if (!type || type === 'all') return list;
  return list.filter((c) => c.contribution_type === type);
}

/**
 * Case-insensitive substring match against the derived reference (e.g.
 * "1.2.3"), title, and description. Matching the reference lets people find a
 * contribution by the number shown beside its title (issue #753).
 */
export function searchContributions(list: Contribution[], query: string): Contribution[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter(
    (c) =>
      (c.reference ?? '').toLowerCase().includes(q) ||
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
  ownership: OwnershipFilter;
  status: StatusFilter;
  type: string;
  search: string;
  sortField: SortField;
  sortDirection: SortDirection;
  currentUserId: string;
  viewerIsAdmin?: boolean;
}

/**
 * Compose ownership filter → status filter → type filter → search → sort. The
 * ownership and status axes AND together (and with type/search), so e.g.
 * "Mine" + "Assigned" shows only the user's in-progress work (issue #809).
 */
export function applyContributionsView(
  list: Contribution[],
  opts: ContributionsViewOptions,
): Contribution[] {
  let out = filterByOwnership(list, opts.ownership, opts.currentUserId, {
    viewerIsAdmin: opts.viewerIsAdmin ?? false,
  });
  out = filterByStatus(out, opts.status);
  out = filterByType(out, opts.type);
  out = searchContributions(out, opts.search);
  out = sortContributions(out, opts.sortField, opts.sortDirection);
  return out;
}
