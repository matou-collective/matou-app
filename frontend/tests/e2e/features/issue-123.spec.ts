import { test, expect, Page } from './fixtures';

// Feature (#123): on mobile (≤767px, the `useIsMobile` composable) the Home
// header must not show the three placeholder "coming soon" stat tiles — New
// Transactions, Proposal Updates, Contribution Actions. The greeting + moon
// line stays, and desktop (≥768px) is unchanged.

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

const PLACEHOLDER_TILES = ['New Transactions', 'Proposal Updates', 'Contribution Actions'];

// Dismiss the welcome splash if present so the Home header is reachable.
async function enterCommunity(page: Page) {
  await page
    .getByRole('button', { name: /enter community/i })
    .click({ timeout: 15_000 })
    .catch(() => {});
}

function tile(page: Page, label: string) {
  return page.locator('.stats-row .stat-label', { hasText: label });
}

test.describe('mobile Home header stat tiles (#123)', () => {
  test('the three placeholder tiles show on desktop but not on mobile', async ({ adminPage, snap }) => {
    test.setTimeout(120_000);
    await enterCommunity(adminPage);

    // Desktop: the welcome header, greeting, and all three placeholder tiles render.
    await adminPage.setViewportSize(DESKTOP);
    await expect(adminPage.locator('.welcome-header')).toBeVisible({ timeout: 15_000 });
    await expect(adminPage.locator('.welcome-header .greeting')).toBeVisible();
    for (const label of PLACEHOLDER_TILES) {
      await expect(tile(adminPage, label)).toBeVisible();
    }
    await snap(adminPage, 'home-header-desktop');

    // Mobile: the greeting stays; the three placeholder tiles are gone.
    await adminPage.setViewportSize(PHONE);
    await expect(adminPage.locator('.welcome-header .greeting')).toBeVisible();
    for (const label of PLACEHOLDER_TILES) {
      await expect(tile(adminPage, label)).toHaveCount(0);
    }
    await snap(adminPage, 'home-header-mobile');
  });
});
