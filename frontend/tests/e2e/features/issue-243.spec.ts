import { test, expect } from './fixtures';

// #243 — the register profile form is driven by the kit (coa-kit plan Task 7):
// which built-in fields show, the participation-interest choices and any custom
// questions all come from KIT.onboarding.profile. The default `matou` kit keeps
// every field on, ships its seven interest labels and defines no custom
// questions, so the form here reproduces today's registration screen while
// sourcing its content from the kit.
test.describe('issue-243 kit-driven profile form fields + interests', () => {
  test('profile form shows the kit fields and interest options', async ({ freshPage, snap }) => {
    const page = freshPage;
    await page.goto('/');

    // Splash → register
    await expect(page.getByRole('button', { name: /join now/i })).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole('button', { name: /join now/i }).click();

    // Kit welcome → walk the three info pages to the form.
    await expect(page.getByRole('heading', { name: /join mātou/i })).toBeVisible({
      timeout: 10_000,
    });
    await page.getByRole('button', { name: /^continue$/i }).click();
    await page.getByRole('button', { name: /^continue$/i }).click(); // About Matou
    await page.getByRole('button', { name: /^continue$/i }).click(); // Community Goals
    await page.getByRole('button', { name: /continue to registration/i }).click(); // Member Expectations

    // Profile form
    await expect(page.getByRole('heading', { name: /create your profile/i })).toBeVisible({
      timeout: 10_000,
    });

    // Built-in fields the default kit leaves on are present.
    await expect(page.locator('#name')).toBeVisible();
    await expect(page.locator('#email')).toBeVisible();
    await expect(page.locator('#bio')).toBeVisible();
    await expect(page.locator('#location')).toBeVisible();

    // Interest options come from the kit's labels.
    await expect(page.getByText('Research and Knowledge')).toBeVisible();
    await expect(page.getByText('Art and Designs')).toBeVisible();
    await expect(page.getByText('Cultural Oversight')).toBeVisible();

    await snap(page, 'profile-form-kit-fields');

    // The default kit defines no custom questions, so no "questions from" block.
    await expect(page.getByText(/A few questions from/i)).toHaveCount(0);
  });
});
