import { test, expect } from './fixtures';

// #370 — the registration/onboarding screens rendered a different typeface from
// the rest of the app on the Android WebView. Root cause: Roboto was delivered
// by Quasar's `roboto-font` extra as plain `.woff` with no `font-display`
// (defaults to `block`), so the first-painted screens (splash/onboarding)
// showed fallback/invisible text until the font loaded. Roboto is now
// self-hosted via `@fontsource/roboto` (woff2 + `font-display: swap`, same
// `Roboto` family), so every screen resolves the same font stack and swaps in
// Roboto without a blocking flash.
//
// This spec captures onboarding vs. in-app typography for the reviewer and
// asserts, at the CSS level, that both contexts resolve the identical
// Roboto-led font-family stack.

const robotoStack = /roboto/i;

test.describe('issue-370 onboarding matches in-app typography', () => {
  test('onboarding welcome renders the Roboto app font', async ({ freshPage, snap }) => {
    const page = freshPage;
    await page.goto('/');

    // Splash → register into the onboarding welcome flow.
    await expect(page.getByRole('button', { name: /join now/i })).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole('button', { name: /join now/i }).click();

    await expect(page.getByRole('heading', { name: /join mātou/i })).toBeVisible({
      timeout: 10_000,
    });

    const family = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    expect(family).toMatch(robotoStack);

    // Roboto must actually be self-hosted and available (not a system fallback).
    const robotoLoaded = await page.evaluate(() => document.fonts.check('16px Roboto'));
    expect(robotoLoaded).toBe(true);

    await snap(page, 'onboarding-welcome-typography');
  });

  test('in-app dashboard renders the same Roboto app font', async ({ adminPage, snap }) => {
    const page = adminPage;
    await page.goto('/#/dashboard');

    await expect(page).toHaveURL(/dashboard/, { timeout: 30_000 });

    const family = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
    expect(family).toMatch(robotoStack);

    const robotoLoaded = await page.evaluate(() => document.fonts.check('16px Roboto'));
    expect(robotoLoaded).toBe(true);

    await snap(page, 'dashboard-typography');
  });
});
