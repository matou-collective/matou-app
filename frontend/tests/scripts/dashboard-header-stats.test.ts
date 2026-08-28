import { describe, it, expect } from 'vitest';
import { buildHeaderStats } from '../../src/pages/dashboardHeaderStats';

const PLACEHOLDER_LABELS = ['New Transactions', 'Proposal Updates', 'Contribution Actions'];

/** Labels of the tiles that would actually render (visible === true). */
function visibleLabels(opts: Parameters<typeof buildHeaderStats>[0]) {
  return buildHeaderStats(opts)
    .filter(s => s.visible)
    .map(s => s.label);
}

describe('buildHeaderStats (Home header stat tiles, #123)', () => {
  it('shows the three placeholder tiles on desktop', () => {
    const labels = visibleLabels({ isSteward: false, pendingCount: 0, isMobile: false });
    for (const label of PLACEHOLDER_LABELS) {
      expect(labels).toContain(label);
    }
  });

  it('hides the three placeholder tiles on mobile (≤767px)', () => {
    const labels = visibleLabels({ isSteward: false, pendingCount: 0, isMobile: true });
    for (const label of PLACEHOLDER_LABELS) {
      expect(labels).not.toContain(label);
    }
  });

  it('never shows Pending Registrations to a non-steward, on either viewport', () => {
    expect(visibleLabels({ isSteward: false, pendingCount: 3, isMobile: false })).not.toContain(
      'Pending Registrations'
    );
    expect(visibleLabels({ isSteward: false, pendingCount: 3, isMobile: true })).not.toContain(
      'Pending Registrations'
    );
  });

  it('shows the steward Pending Registrations tile on desktop with its live count', () => {
    const stats = buildHeaderStats({ isSteward: true, pendingCount: 5, isMobile: false });
    const pending = stats.find(s => s.label === 'Pending Registrations');
    expect(pending?.visible).toBe(true);
    expect(pending?.value).toBe(5);
  });

  it('keeps the steward Pending Registrations tile visible on mobile (only the placeholders are hidden)', () => {
    const labels = visibleLabels({ isSteward: true, pendingCount: 2, isMobile: true });
    expect(labels).toEqual(['Pending Registrations']);
  });
});
