import { test, expect, Page, Locator } from './fixtures';

// Feature (#72): a single global `!important` rule in src/css/app.scss makes
// every dialog `q-card` fit a phone viewport (≤767px). 24+ dialogs carry inline
// `min-width: 400–620px` that would otherwise overflow a 390px-wide screen and
// force horizontal page scroll. The rule reflows them to `calc(100vw - 24px)`
// with a 12px gutter on each side; desktop (≥768px) is untouched.
//
// The mobile sidebar is hidden ≤767px (DashboardLayout.vue), so we open each
// dialog at the default desktop width, then resize to 390×844 — CSS media
// queries reflow the open dialog live — and assert it fits.

const PHONE = { width: 390, height: 844 };
const GUTTER_MIN = 8; // target is 12px; allow a little slack for sub-pixel rounding.

// Dismiss the welcome splash if present so the sidebar nav is reachable.
async function enterCommunity(page: Page) {
  await page
    .getByRole('button', { name: /enter community/i })
    .click({ timeout: 15_000 })
    .catch(() => {});
}

// Resize to a phone viewport and assert the open dialog card fits within it
// with gutters on both sides and no horizontal page scroll.
async function assertFitsPhone(page: Page, card: Locator, label: string, snap: (p: Page, l: string) => Promise<void>) {
  await page.setViewportSize(PHONE);
  await expect(card).toBeVisible();

  // Let the reflow settle, then measure.
  const box = await card.boundingBox();
  expect(box, `${label}: card should have a bounding box`).not.toBeNull();
  if (!box) return;

  // Left gutter, right gutter, and total width all respect the 390px viewport.
  expect(box.x, `${label}: left gutter ≥ ${GUTTER_MIN}px`).toBeGreaterThanOrEqual(GUTTER_MIN);
  expect(
    PHONE.width - (box.x + box.width),
    `${label}: right gutter ≥ ${GUTTER_MIN}px`
  ).toBeGreaterThanOrEqual(GUTTER_MIN);
  expect(box.width, `${label}: card fits inside the viewport`).toBeLessThanOrEqual(PHONE.width - 2 * GUTTER_MIN);

  // No horizontal page scroll — the whole point of the override.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow, `${label}: no horizontal page scroll`).toBeLessThanOrEqual(1);

  await snap(page, label);
}

test.describe('mobile dialog override (#72)', () => {
  test('ReportIssueDialog (scoped 525px) fits a 390px viewport', async ({ adminPage, snap }) => {
    test.setTimeout(120_000);
    await enterCommunity(adminPage);

    // Sidebar is visible at the default desktop width.
    await adminPage.getByRole('button', { name: /report an issue/i }).click();
    const card = adminPage.locator('.q-dialog .report-dialog');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await snap(adminPage, 'report-issue-desktop');

    await assertFitsPhone(adminPage, card, 'report-issue-390px', snap);
  });

  test('CreateProposalDialog (600px) fits a 390px viewport', async ({ adminPage, snap }) => {
    test.setTimeout(120_000);
    await enterCommunity(adminPage);

    await adminPage.getByRole('button', { name: 'Proposals' }).click();
    await adminPage.getByRole('button', { name: /new proposal/i }).click();

    // Only one dialog is open; scope to the visible dialog's card.
    const card = adminPage.locator('.q-dialog .q-card').filter({ hasText: /create proposal/i });
    await expect(card.first()).toBeVisible({ timeout: 15_000 });
    await snap(adminPage, 'create-proposal-desktop');

    await assertFitsPhone(adminPage, card.first(), 'create-proposal-390px', snap);
  });
});
