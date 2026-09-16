import { test, expect } from './fixtures';

// #362 — since the kit chain fixes the organisation, the setup screen only
// collects the first admin's profile, so the submit button now reads
// "Launch App" (keeping the Rocket icon) rather than "Create Organization".
// The progress-step labels that narrate the machinery are left unchanged.
test.describe('issue-362 setup submit button reads "Launch App"', () => {
  test('setup screen submit button says Launch App', async ({ freshPage, snap }) => {
    const page = freshPage;

    // The features project runs after org-setup, so the org IS configured and
    // the guard redirects /setup → splash (`isConfigured && to.path==='/setup'`,
    // boot/keri.ts). Make the app see an unconfigured org by 404-ing both config
    // sources (backend then config server, src/api/config.ts) so `needsSetup`
    // is true and the /setup route renders OrgSetupScreen.
    await page.route('**/api/v1/org/config', (route) =>
      route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }),
    );
    await page.route('**/api/config', (route) =>
      route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }),
    );

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
