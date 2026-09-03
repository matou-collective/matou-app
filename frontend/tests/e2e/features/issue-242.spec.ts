import { test, expect } from './fixtures';

// #242 — the register onboarding flow is now driven by the kit's copy:
// splash → kit welcome → N info pages → profile form. The default `matou`
// kit ships a welcome screen and three info pages ("About Matou",
// "Community Goals", "Member Expectations"). Each screen has a Continue
// button; the last info page reads "I agree, continue to registration".
test.describe('issue-242 kit-driven onboarding welcome + info pages', () => {
  test('walks welcome → info pages → profile form', async ({ freshPage, snap }) => {
    const page = freshPage;
    await page.goto('/');

    // Splash → register
    await expect(page.getByRole('button', { name: /join now/i })).toBeVisible({
      timeout: 30_000,
    });
    await snap(page, 'splash');
    await page.getByRole('button', { name: /join now/i }).click();

    // Kit welcome screen (heading from KIT.onboarding.welcome.heading)
    await expect(page.getByRole('heading', { name: /join mātou/i })).toBeVisible({
      timeout: 10_000,
    });
    await snap(page, 'kit-welcome');
    await page.getByRole('button', { name: /^continue$/i }).click();

    // Info page 1
    await expect(page.getByRole('heading', { name: /about mātou/i })).toBeVisible({
      timeout: 10_000,
    });
    await snap(page, 'info-page-1-about');
    await page.getByRole('button', { name: /^continue$/i }).click();

    // Info page 2
    await expect(page.getByRole('heading', { name: /community goals/i })).toBeVisible({
      timeout: 10_000,
    });
    await snap(page, 'info-page-2-goals');
    await page.getByRole('button', { name: /^continue$/i }).click();

    // Info page 3 (last — "I agree, continue to registration")
    await expect(page.getByRole('heading', { name: /member expectations/i })).toBeVisible({
      timeout: 10_000,
    });
    await snap(page, 'info-page-3-expectations');
    await page.getByRole('button', { name: /continue to registration/i }).click();

    // Profile form
    await expect(page.getByRole('heading', { name: /create your profile/i })).toBeVisible({
      timeout: 10_000,
    });
    await snap(page, 'profile-form');
  });
});
