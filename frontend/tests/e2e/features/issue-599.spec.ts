import { test, expect, Page } from './fixtures';

/**
 * Feature (#599): the `matou://inbox` steward hand-off deep-link routes to the
 * steward's pending approvals — the Pending/Members card on `/dashboard`,
 * reached with `?focus=pending` and scrolled into view. A non-steward (or a
 * wallet with no community yet) lands on its normal home, no error.
 *
 * The pure classifier (`classifyDeepLink('matou://inbox') === 'inbox'`) and the
 * router-aware handler (warm → push `/dashboard?focus=pending`, cold → stash for
 * the onboarding gate) are unit-tested in tests/scripts/deep-link.test.ts. This
 * drives the wallet over the web build to the same `?focus=pending` route the
 * deep link resolves to and shows the user-facing outcome. The native QR-scan
 * hop (Android intent / iOS URL type / Electron protocol client) is verified
 * manually per the issue's acceptance — it cannot be fired from a browser.
 */

// Dismiss the welcome splash if present so the dashboard is reachable.
async function enterCommunity(page: Page) {
  await page
    .getByRole('button', { name: /enter community/i })
    .click({ timeout: 15_000 })
    .catch(() => {});
}

test.describe('matou://inbox steward hand-off deep link (#599)', () => {
  test('a steward lands on the pending approvals card', async ({ adminPage, snap }) => {
    test.setTimeout(120_000);

    // The route the `matou://inbox` deep link resolves to for a steward.
    await adminPage.goto('/dashboard?focus=pending');
    await enterCommunity(adminPage);

    // Landed on the dashboard, on the members/pending card — not the home
    // screen's activity feed.
    await expect(adminPage).toHaveURL(/focus=pending/);
    await expect(adminPage.locator('.members-card')).toBeVisible({ timeout: 15_000 });
    await expect(adminPage.locator('.members-card .card-title').first()).toBeVisible();
    await snap(adminPage, 'steward-pending-approvals');
  });

  test('a non-steward simply lands on its normal home, no error', async ({ memberPage, snap }) => {
    test.setTimeout(120_000);

    await memberPage.goto('/dashboard?focus=pending');
    await enterCommunity(memberPage);

    // Still on the dashboard home — the welcome header renders and nothing errors.
    await expect(memberPage.locator('.welcome-header')).toBeVisible({ timeout: 15_000 });
    await snap(memberPage, 'non-steward-home');
  });
});
