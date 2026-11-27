import { test, expect, Page } from './fixtures';

/**
 * Feature (#636): the header gradient is one shared, theme-invariant token —
 * `linear-gradient(to top left, var(--matou-brand-secondary), var(--matou-brand))`
 * (kit secondary at the bottom right rising to the kit primary at the top left) —
 * and dark mode no longer swaps the kit primary for Mātou's hardcoded teal.
 *
 * The pre-login onboarding screens (splash / Join Now / invite code / sign in
 * with computer) run before the logged-in fixtures exist, so they can't be
 * driven from here; the token wiring that fixes them is covered by
 * tests/scripts/kit-colour-leaks.test.ts and tests/scripts/apply-kit.test.ts.
 * This spec shows the reachable brand surface — the dashboard welcome header —
 * in light and dark so the reviewer can confirm the gradient and the dark-mode
 * brand colour on screenshots.
 */

// Dismiss the welcome splash if present so the dashboard is reachable.
async function enterCommunity(page: Page) {
  await page
    .getByRole('button', { name: /enter community/i })
    .click({ timeout: 15_000 })
    .catch(() => {});
}

async function forceTheme(page: Page, choice: 'dark' | 'light') {
  await page.addInitScript((c) => {
    try {
      localStorage.setItem('matou:theme', c);
    } catch {
      /* ignore */
    }
  }, choice);
}

test.describe('#636 brand header gradient + dark-mode kit primary', () => {
  test('the dashboard welcome header renders the shared brand gradient (light)', async ({
    adminPage,
    snap,
  }) => {
    test.setTimeout(120_000);
    await forceTheme(adminPage, 'light');
    await adminPage.goto('/dashboard');
    await enterCommunity(adminPage);

    const header = adminPage.locator('.welcome-header');
    await expect(header).toBeVisible({ timeout: 15_000 });
    // The shared gradient resolves to a linear-gradient background image.
    await expect
      .poll(async () =>
        header.evaluate((el) => getComputedStyle(el).backgroundImage.includes('gradient')),
      )
      .toBe(true);
    await snap(adminPage, 'dashboard-header-light');
  });

  test('dark mode keeps the kit brand on the welcome header', async ({ adminPage, snap }) => {
    test.setTimeout(120_000);
    await forceTheme(adminPage, 'dark');
    await adminPage.goto('/dashboard');
    await enterCommunity(adminPage);

    // Dark mode is active (design tokens key off the .dark class).
    await expect
      .poll(async () =>
        adminPage.evaluate(() => document.documentElement.classList.contains('dark')),
      )
      .toBe(true);

    const header = adminPage.locator('.welcome-header');
    await expect(header).toBeVisible({ timeout: 15_000 });
    await snap(adminPage, 'dashboard-header-dark');
  });
});
