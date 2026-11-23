import { describe, it, expect } from 'vitest';
import { useContributionWorkflow } from '../../src/composables/useContributionWorkflow';
import type { Contribution } from '../../src/types/projects';

const { canCloseParent } = useContributionWorkflow();

const parent = (status = 'assigned') => ({ status }) as Contribution;
const kids = (...statuses: string[]) => statuses.map((status) => ({ status })) as Contribution[];

describe('canCloseParent (#844 — lead closes a parent without a budget)', () => {
  it('allows a lead when every sub-contribution is rewarded', () => {
    expect(canCloseParent(parent(), kids('rewarded', 'rewarded'), 'project_lead')).toBe(true);
    expect(canCloseParent(parent(), kids('rewarded'), 'community_admin')).toBe(true);
  });

  it('ignores archived sub-contributions', () => {
    expect(canCloseParent(parent(), kids('rewarded', 'archived'), 'project_lead')).toBe(true);
  });

  it('refuses while any sub-contribution is not rewarded', () => {
    expect(canCloseParent(parent(), kids('rewarded', 'signed_off'), 'project_lead')).toBe(false);
    expect(canCloseParent(parent(), kids('rewarded', 'assigned'), 'project_lead')).toBe(false);
  });

  it('refuses with no live sub-contributions', () => {
    expect(canCloseParent(parent(), [], 'project_lead')).toBe(false);
    expect(canCloseParent(parent(), kids('archived'), 'project_lead')).toBe(false);
  });

  it('refuses callers who are not a project lead or admin', () => {
    for (const role of ['project_steward', 'contributor', 'member']) {
      expect(canCloseParent(parent(), kids('rewarded'), role)).toBe(false);
    }
  });

  it('refuses a parent that is already rewarded, archived or declined', () => {
    for (const status of ['rewarded', 'archived', 'declined']) {
      expect(canCloseParent(parent(status), kids('rewarded'), 'project_lead')).toBe(false);
    }
  });
});
