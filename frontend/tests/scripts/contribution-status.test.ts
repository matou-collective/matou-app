import { describe, it, expect } from 'vitest';
import { isContributionOverdue } from '../../src/lib/contributionStatus';

const PAST = new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(); // yesterday
const FUTURE = new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString(); // tomorrow

describe('isContributionOverdue', () => {
  it('returns true for a past deadline on an eligible open status', () => {
    expect(isContributionOverdue({ deadline: PAST, status: 'created' })).toBe(true);
    expect(isContributionOverdue({ deadline: PAST, status: 'assigned' })).toBe(true);
    expect(isContributionOverdue({ deadline: PAST, status: 'needs_review' })).toBe(true);
  });

  it('returns false when there is no deadline', () => {
    expect(isContributionOverdue({ status: 'created' })).toBe(false);
    expect(isContributionOverdue({ deadline: undefined, status: 'assigned' })).toBe(false);
  });

  it('returns false for terminal statuses even with a past deadline', () => {
    expect(isContributionOverdue({ deadline: PAST, status: 'signed_off' })).toBe(false);
    expect(isContributionOverdue({ deadline: PAST, status: 'rewarded' })).toBe(false);
    expect(isContributionOverdue({ deadline: PAST, status: 'archived' })).toBe(false);
    expect(isContributionOverdue({ deadline: PAST, status: 'declined' })).toBe(false);
  });

  it('returns false for a future deadline', () => {
    expect(isContributionOverdue({ deadline: FUTURE, status: 'created' })).toBe(false);
    expect(isContributionOverdue({ deadline: FUTURE, status: 'in_progress' })).toBe(false);
  });

  it('returns false for an unparsable deadline', () => {
    expect(isContributionOverdue({ deadline: 'not-a-date', status: 'created' })).toBe(false);
  });
});
