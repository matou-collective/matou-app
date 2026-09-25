import { test, expect, Page } from './fixtures';

/**
 * Feature (#624): in dark mode the registration profile form's raw
 * <textarea>s ("Tell us a bit about yourself" #bio and "Why would you like to
 * join us?" #joinReason) typed BLACK text on the dark input background — a
 * native control does not inherit `color`, so it fell back to the system field
 * text (black), invisible on dark.
 *
 * The global stylesheet now gives every native input/textarea/select
 * `color: var(--matou-foreground)` and their placeholders
 * `var(--matou-muted-foreground)`, so raw controls follow light/dark themes.
 * This spec drives the profile form in dark mode and asserts the typed text and
 * placeholders render light, not black.
 */

// Force dark mode before the app boots (theme.ts keys off localStorage +
// the `.dark` class it toggles on <html>).
async function forceDark(page: Page) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('matou:theme', 'dark');
    } catch {
      /* ignore */
    }
  });
}

// Average channel value of an "rgb(r, g, b)" string — a light foreground
// scores high, black scores 0. Robust to token-value tweaks.
function brightness(color: string): number {
  const m = color.match(/(\d+(?:\.\d+)?)/g);
  if (!m || m.length < 3) return 0;
  const [r, g, b] = m.map(Number);
  return (r + g + b) / 3;
}

test.describe('issue-624 dark-mode raw textarea text colour', () => {
  test('profile-form #bio and #joinReason type light text on dark', async ({ freshPage, snap }) => {
    const page = freshPage;
    await forceDark(page);
    await page.goto('/');

    // Confirm the app booted into dark mode.
    await expect
      .poll(() => page.evaluate(() => document.documentElement.classList.contains('dark')), {
        timeout: 15_000,
      })
      .toBe(true);

    // Splash → register.
    await expect(page.getByRole('button', { name: /join now/i })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: /join now/i }).click();

    // Kit welcome → walk the info pages to the form (mirrors issue-243).
    await expect(page.getByRole('heading', { name: /join mātou/i })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: /^continue$/i }).click();
    await expect(page.getByRole('heading', { name: /about mātou/i })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: /^continue$/i }).click();
    await expect(page.getByRole('heading', { name: /community goals/i })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: /^continue$/i }).click();
    await expect(page.getByRole('heading', { name: /member expectations/i })).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: /continue to registration/i }).click();

    // Profile form.
    await expect(page.getByRole('heading', { name: /create your profile/i })).toBeVisible({
      timeout: 10_000,
    });

    const bio = page.locator('#bio');
    const joinReason = page.locator('#joinReason');
    await expect(bio).toBeVisible();
    await expect(joinReason).toBeVisible();

    // Placeholders render in the muted (light-ish) colour, not black.
    for (const field of [bio, joinReason]) {
      const placeholderColor = await field.evaluate(
        (el) => getComputedStyle(el, '::placeholder').color
      );
      expect(brightness(placeholderColor), `placeholder is not black: ${placeholderColor}`).toBeGreaterThan(60);
    }

    // Type into both fields; the typed text must render in the light foreground.
    await bio.fill('Kia ora — a bit about myself for the dark-mode check.');
    await joinReason.fill('I would like to join to help kaitiaki our shared knowledge.');

    for (const field of [bio, joinReason]) {
      const textColor = await field.evaluate((el) => getComputedStyle(el).color);
      expect(brightness(textColor), `typed text is light, not black: ${textColor}`).toBeGreaterThan(150);
    }

    await snap(page, 'dark-mode-profile-form-textareas');
  });
});
