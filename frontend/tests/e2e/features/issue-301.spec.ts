import { test, expect } from './fixtures';

// Feature (#301): the participation-interests vocabulary lives in the
// SharedProfile schema (backend `Validation.Enum`), and the frontend offers
// exactly the values the schema declares — read from
// GET /api/v1/types/SharedProfile via the types store — instead of a hardcoded
// list. This spec drives the Account Settings profile editor (the reachable
// surface for a logged-in session; the onboarding form uses the same options
// source) and verifies the rendered participation-interest chips are the
// shipped vocabulary.

const SETTINGS_URL = '/#/dashboard/settings';

// Labels the frontend renders for the shipped enum values (built-in metadata
// keyed by the schema value). Kept in sync with the backend
// `ParticipationInterests` enum and src/lib/participationInterests.ts.
const SHIPPED_LABELS = [
  'Research and Knowledge',
  'Coordination and Operations',
  'Art and Designs',
  'Discussions and Community Input',
  'Follow and Learn',
  'Coding and Technical Dev',
  'Cultural Oversight',
];

test.describe('participation interests sourced from the SharedProfile schema (#301)', () => {
  test('the profile editor offers the shipped schema vocabulary', async ({ adminPage, snap }) => {
    test.setTimeout(120_000);

    await adminPage.goto(SETTINGS_URL);

    const chips = adminPage.locator('.interest-chip');
    await expect(chips.first()).toBeVisible({ timeout: 30_000 });

    // One chip per shipped enum value, labelled from the schema value.
    await expect(chips).toHaveCount(SHIPPED_LABELS.length);
    const rendered = (await chips.allInnerTexts()).map((t) => t.trim());
    for (const label of SHIPPED_LABELS) {
      expect(rendered).toContain(label);
    }
    await snap(adminPage, 'participation-interests-from-schema');

    // Selecting an interest reflects in the chip's selected state.
    const first = chips.first();
    await first.click();
    await expect(first).toHaveClass(/interest-chip--selected/);
    await snap(adminPage, 'participation-interest-selected');
  });
});
