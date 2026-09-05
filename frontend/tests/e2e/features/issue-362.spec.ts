import { test, expect } from './fixtures';

// #362 — since the kit chain fixes the organisation, the setup screen only
// collects the first admin's profile, so the submit button now reads
// "Launch App" (keeping the Rocket icon) rather than "Create Organization".
// The progress-step labels that narrate the machinery are left unchanged.
test.describe('issue-362 setup submit button reads "Launch App"', () => {
  test('setup screen submit button says Launch App', async ({ freshPage, snap }) => {
    const page = freshPage;

    // The setup route renders OrgSetupScreen directly (no redirect guard).
    await page.goto('/#/setup');

    await expect(page.getByRole('heading', { name: /set up mātou/i })).toBeVisible({
      timeout: 30_000,
    });

    const submit = page.getByRole('button', { name: /launch app/i });
    await expect(submit).toBeVisible({ timeout: 10_000 });

    // The old label must be gone.
    await expect(page.getByRole('button', { name: /create organization/i })).toHaveCount(0);

    await snap(page, 'setup-launch-app-button');
  });
});
