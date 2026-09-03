import { test, expect } from './fixtures';

// #244 — the kit's approval mode now drives the copy the applicant sees. The
// kit welcome screen's approval sentence is rendered by `approvalWords`
// (src/kit/approval.ts) from KIT.onboarding.approval, and the pending screen's
// requirement grid is computed from `requirementsFor(...)`. The default `matou`
// kit is `endorsements+session{required:1, admin:true}`, so the welcome
// sentence names one endorsement, a whakawhanaungatanga session and an admin
// confirmation — reproducing today's three requirements.
test.describe('issue-244 kit approval mode drives the welcome copy', () => {
  test('welcome screen shows the endorsements+session approval sentence', async ({
    freshPage,
    snap,
  }) => {
    const page = freshPage;
    await page.goto('/');

    // Splash → register
    await expect(page.getByRole('button', { name: /join now/i })).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole('button', { name: /join now/i }).click();

    // Kit welcome screen (heading from KIT.onboarding.welcome.heading)
    await expect(page.getByRole('heading', { name: /join mātou/i })).toBeVisible({
      timeout: 10_000,
    });

    // The approval sentence for the default endorsements+session kit — one
    // endorsement, a session, then an admin confirms.
    await expect(
      page.getByText(
        /need 1 endorsement and attend a whakawhanaungatanga session before an admin confirms them/i,
      ),
    ).toBeVisible({ timeout: 10_000 });
    await snap(page, 'kit-welcome-approval-sentence');
  });
});
