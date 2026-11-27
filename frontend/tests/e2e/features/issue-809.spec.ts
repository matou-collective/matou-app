import { test, expect, Page } from './fixtures';

/**
 * Feature (#809): the Contributions list filter splits into two independent,
 * combinable axes so a user can narrow to e.g. "Mine" AND "Assigned" at the
 * same time (dropping approved/terminal items), isolate contributions
 * "Offered to me", and filter to what is "Overdue".
 *
 * The filtering logic itself is proven exhaustively by the unit tests in
 * tests/scripts/contributions-view.test.ts (ownership × status AND, the
 * offered-to-me and overdue predicates, persistence keys). This e2e walks the
 * toolbar so the reviewer can eyeball that both pill rows render and that an
 * ownership pill and a status pill can be active at once.
 */

async function enterCommunity(page: Page) {
  await page
    .getByRole('button', { name: /enter community/i })
    .click({ timeout: 15_000 })
    .catch(() => {});
}

// Scope to the ownership row (plain .filter-pill, not status-/type-pill) and
// the status row so the duplicated "All" label resolves unambiguously.
function ownershipPill(page: Page, label: string) {
  return page.locator('.filter-pill:not(.status-pill):not(.type-pill)', { hasText: label });
}
function statusPill(page: Page, label: string) {
  return page.locator('.filter-pill.status-pill', { hasText: label });
}

test('#809 ownership and status filters combine on the Contributions list', async ({
  adminPage,
  snap,
}) => {
  test.setTimeout(120_000);

  await adminPage.goto('/dashboard/contributions');
  await enterCommunity(adminPage);
  await adminPage.waitForTimeout(1500);

  // Both axes present: ownership (All / Mine / Offered to me) and status
  // (All / Open / Assigned / … / Overdue).
  await expect(ownershipPill(adminPage, 'Mine')).toBeVisible();
  await expect(ownershipPill(adminPage, 'Offered to me')).toBeVisible();
  await expect(statusPill(adminPage, 'Assigned')).toBeVisible();
  await expect(statusPill(adminPage, 'Overdue')).toBeVisible();
  await snap(adminPage, 'contributions-filter-bar');

  // Combine Mine + Assigned — the reporter's core ask. Both pills stay active.
  await ownershipPill(adminPage, 'Mine').click();
  await statusPill(adminPage, 'Assigned').click();
  await expect(ownershipPill(adminPage, 'Mine')).toHaveClass(/active/);
  await expect(statusPill(adminPage, 'Assigned')).toHaveClass(/active/);
  await snap(adminPage, 'mine-and-assigned');

  // Offered to me.
  await ownershipPill(adminPage, 'Offered to me').click();
  await statusPill(adminPage, 'All').click();
  await expect(ownershipPill(adminPage, 'Offered to me')).toHaveClass(/active/);
  await snap(adminPage, 'offered-to-me');

  // Overdue.
  await ownershipPill(adminPage, 'All').click();
  await statusPill(adminPage, 'Overdue').click();
  await expect(statusPill(adminPage, 'Overdue')).toHaveClass(/active/);
  await snap(adminPage, 'overdue');

  // Each axis persists independently across a reload.
  await adminPage.reload();
  await enterCommunity(adminPage);
  await adminPage.waitForTimeout(1500);
  await expect(statusPill(adminPage, 'Overdue')).toHaveClass(/active/);
  await expect(ownershipPill(adminPage, 'All')).toHaveClass(/active/);
  await snap(adminPage, 'overdue-persisted');
});
