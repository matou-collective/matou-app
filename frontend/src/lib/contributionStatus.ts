// Shared helpers for contribution status display. The colour palette itself
// lives in src/css/contribution-status.scss (single source of truth).

// Statuses where a passed deadline still means "someone needs to act".
// Excludes terminal/inactive statuses (signed_off, rewarded, archived,
// declined, approved, cancelled, rejected) where a deadline no longer matters.
const OVERDUE_ELIGIBLE_STATUSES = new Set([
  'created',
  'confirmed',
  'shared',
  'offered',
  'assigned',
  'changed',
  'in_progress',
  'needs_review',
  'incomplete',
]);

export interface OverdueCheckable {
  deadline?: string | null;
  status: string;
}

/**
 * True when the contribution has a deadline in the past and is still in a
 * status where that deadline matters (i.e. it's not done/out of play).
 */
export function isContributionOverdue(c: OverdueCheckable): boolean {
  if (!c.deadline || !OVERDUE_ELIGIBLE_STATUSES.has(c.status)) return false;
  const deadlineMs = new Date(c.deadline).getTime();
  if (Number.isNaN(deadlineMs)) return false;
  return deadlineMs < Date.now();
}
