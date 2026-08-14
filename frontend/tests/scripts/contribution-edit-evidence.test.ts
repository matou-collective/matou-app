import { describe, it, expect } from 'vitest';
import { useContributionWorkflow } from '../../src/composables/useContributionWorkflow';
import type { Contribution } from '../../src/types/projects';

const { canEditEvidence } = useContributionWorkflow();

const CONTRIBUTOR = 'aid-contributor';

function contrib(overrides: Partial<Contribution>): Contribution {
  return {
    status: 'needs_review',
    assigned_contributor: CONTRIBUTOR,
    ...overrides,
  } as Contribution;
}

describe('canEditEvidence (issue #9 — contributor self-edit before sign-off)', () => {
  it('lets the assigned contributor edit while needs_review', () => {
    expect(canEditEvidence(contrib({ status: 'needs_review' }), CONTRIBUTOR)).toBe(true);
  });

  it('lets the assigned contributor edit while approved (pre sign-off)', () => {
    expect(canEditEvidence(contrib({ status: 'approved' }), CONTRIBUTOR)).toBe(true);
  });

  it('blocks editing once signed off (immutable boundary)', () => {
    expect(canEditEvidence(contrib({ status: 'signed_off' }), CONTRIBUTOR)).toBe(false);
    expect(canEditEvidence(contrib({ status: 'rewarded' }), CONTRIBUTOR)).toBe(false);
    expect(canEditEvidence(contrib({ status: 'archived' }), CONTRIBUTOR)).toBe(false);
  });

  it('blocks editing before submission (assigned status)', () => {
    expect(canEditEvidence(contrib({ status: 'assigned' }), CONTRIBUTOR)).toBe(false);
  });

  it('does not let a different member edit someone else’s submission', () => {
    expect(canEditEvidence(contrib({ status: 'needs_review' }), 'aid-someone-else')).toBe(false);
  });

  it('lets a lead/steward edit on the contributor’s behalf', () => {
    const c = contrib({ status: 'needs_review', assigned_contributor: 'aid-other' });
    expect(canEditEvidence(c, 'aid-lead', 'project_lead')).toBe(true);
    expect(canEditEvidence(c, 'aid-steward', 'project_steward')).toBe(true);
    expect(canEditEvidence(c, 'aid-admin', 'community_admin')).toBe(true);
  });

  it('honours the assigned_contributor_id fallback field', () => {
    const c = {
      status: 'approved',
      assigned_contributor_id: CONTRIBUTOR,
    } as Contribution;
    expect(canEditEvidence(c, CONTRIBUTOR)).toBe(true);
  });
});
