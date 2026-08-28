import { test, expect, Page } from './fixtures';

// Feature (#127): the Contributions page now
//   1. defaults to the **List** view on both mobile and desktop when there is
//      no stored preference (an explicitly stored Timeline choice is honored), and
//   2. renders the Timeline/List toggle full-width as two equal halves on mobile.
//
// Timeline (`.timeline-view`) and List (`.feed-container`) render mutually
// exclusively, so which container is present tells us the active view.

const VIEW_KEY = 'matou:contributions:view';
const PHONE = { width: 390, height: 844 };

async function enterCommunity(page: Page) {
  await page
    .getByRole('button', { name: /enter community/i })
    .click({ timeout: 15_000 })
    .catch(() => {});
}

// Navigate to the Contributions page with no stored view preference so the
// default applies. Clearing then reloading guarantees a genuine fresh load.
async function openContributionsFresh(page: Page) {
  await enterCommunity(page);
  await page.evaluate((k) => window.localStorage.removeItem(k), VIEW_KEY);
  await page.getByRole('button', { name: 'Contributions' }).click();
  await page.reload();
  await enterCommunity(page);
  await page.getByRole('button', { name: 'Contributions' }).click();
}

test.describe('Contributions view default + mobile toggle (#127)', () => {
  test('defaults to List view on desktop with no stored preference', async ({ adminPage, snap }) => {
    test.setTimeout(120_000);
    await openContributionsFresh(adminPage);

    // List view is present; the timeline container is not.
    await expect(adminPage.locator('.feed-container')).toBeVisible({ timeout: 15_000 });
    await expect(adminPage.locator('.timeline-view')).toHaveCount(0);
    await snap(adminPage, 'contributions-default-list-desktop');
  });

  test('defaults to List view on mobile, with a full-width equal-halves toggle', async ({
    adminPage,
    snap,
  }) => {
    test.setTimeout(120_000);
    await openContributionsFresh(adminPage);
    await adminPage.setViewportSize(PHONE);

    // Still List by default on mobile.
    await expect(adminPage.locator('.feed-container')).toBeVisible({ timeout: 15_000 });
    await expect(adminPage.locator('.timeline-view')).toHaveCount(0);

    // The toggle spans (nearly) the full viewport width, and its two buttons
    // are equal halves.
    const toggle = adminPage.locator('.view-mode-toggle');
    await expect(toggle).toBeVisible();
    const toggleBox = await toggle.boundingBox();
    expect(toggleBox).not.toBeNull();
    if (toggleBox) {
      expect(toggleBox.width, 'toggle spans most of the 390px viewport').toBeGreaterThan(300);
    }

    const buttons = toggle.locator('.q-btn');
    await expect(buttons).toHaveCount(2);
    const first = await buttons.nth(0).boundingBox();
    const second = await buttons.nth(1).boundingBox();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    if (first && second) {
      // Two equal halves — widths within a few px of each other.
      expect(Math.abs(first.width - second.width), 'toggle halves are equal width').toBeLessThanOrEqual(2);
    }
    await snap(adminPage, 'contributions-default-list-mobile');
  });

  test('honors an explicitly stored Timeline preference', async ({ adminPage, snap }) => {
    test.setTimeout(120_000);
    await enterCommunity(adminPage);
    await adminPage.evaluate((k) => window.localStorage.setItem(k, 'timeline'), VIEW_KEY);
    await adminPage.getByRole('button', { name: 'Contributions' }).click();
    await adminPage.reload();
    await enterCommunity(adminPage);
    await adminPage.getByRole('button', { name: 'Contributions' }).click();

    // Stored Timeline choice is respected — timeline container renders.
    await expect(adminPage.locator('.timeline-view')).toBeVisible({ timeout: 15_000 });
    await snap(adminPage, 'contributions-stored-timeline');
  });
});
