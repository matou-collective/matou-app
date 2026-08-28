import { test, expect, Page } from './fixtures';

// Feature (#122): when the external maramataka moon-phase host is unreachable
// (the Android WebView blocks it via cleartext / network-security-config, and
// it also fails on the test stack), the Home header must NOT sit on a permanent
// "Loading moon phase..." string. It fails quietly to a hidden state: the moon
// line is simply absent, while the "Kia ora" greeting still renders.

const DASHBOARD_URL = '/#/dashboard';

// Block every request to the external moon-phase host so the fetch rejects,
// reproducing the Android WebView / test-stack failure.
async function blockMaramataka(page: Page) {
  await page.route('**maramataka-api.matou.nz**', (route) => route.abort());
}

test.describe('moon-phase header fails quietly (#122)', () => {
  test('a blocked moon-phase host hides the moon line without a permanent loading string', async ({
    adminPage,
    snap,
  }) => {
    test.setTimeout(120_000);

    await blockMaramataka(adminPage);
    await adminPage.goto(DASHBOARD_URL);

    // The greeting still renders normally.
    await expect(adminPage.locator('.greeting')).toHaveText('Kia ora', { timeout: 20_000 });

    // Give the failed fetch time to settle, then assert the header never sits
    // on the permanent loading placeholder and shows no moon display.
    await expect(adminPage.locator('.moon-phase-loading')).toHaveCount(0, { timeout: 15_000 });
    await expect(adminPage.getByText('Loading moon phase...')).toHaveCount(0);
    await expect(adminPage.locator('.moon-phase-display')).toHaveCount(0);

    await snap(adminPage, 'moon-line-hidden-on-failure');
  });
});
