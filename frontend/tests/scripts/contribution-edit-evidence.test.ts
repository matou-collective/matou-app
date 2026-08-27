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

  it('does NOT let a lead/steward/admin edit on the contributor’s behalf (owner only)', () => {
    const c = contrib({ status: 'needs_review', assigned_contributor: 'aid-other' });
    expect(canEditEvidence(c, 'aid-lead')).toBe(false);
    expect(canEditEvidence(c, 'aid-steward')).toBe(false);
    expect(canEditEvidence(c, 'aid-admin')).toBe(false);
  });

  it('is false when nobody is assigned or the viewer is anonymous', () => {
    expect(canEditEvidence(contrib({ assigned_contributor: undefined }), CONTRIBUTOR)).toBe(false);
    expect(canEditEvidence(contrib({}), '')).toBe(false);
  });

  it('honours the assigned_contributor_id fallback field', () => {
    const c = {
      status: 'approved',
      assigned_contributor_id: CONTRIBUTOR,
    } as Contribution;
    expect(canEditEvidence(c, CONTRIBUTOR)).toBe(true);
  });
});
