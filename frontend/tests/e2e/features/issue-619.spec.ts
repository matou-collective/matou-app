import { test, expect } from './fixtures';

// Feature (#619): Governance Tokens and Transaction Tokens are stock Mātou's
// roadmap placeholders. A Coa-built community app never chose a token economy,
// so its wallet shows only Credentials. This e2e runs against the stock Mātou
// test build (kit slug 'matou'), so it demonstrates the UNCHANGED stock case —
// all three sidebar entries present with the "Coming soon" placeholders. The
// Coa-build hiding is proven by the unit test (wallet-page-tokens.test.ts),
// which mounts WalletPage under a non-matou kit.

test.describe('wallet token tabs by kit (#619)', () => {
  test('stock Mātou wallet still shows Credentials plus the token placeholders', async ({
    adminPage,
    snap,
  }) => {
    test.setTimeout(120_000);

    await adminPage.goto('/#/dashboard/wallet');

    // Credentials entry is always present.
    await expect(adminPage.getByText('Credentials', { exact: true })).toBeVisible({
      timeout: 20_000,
    });

    // Stock Mātou keeps the two token placeholders and their "Coming soon" rows.
    await expect(adminPage.getByText('Governance Tokens', { exact: true })).toBeVisible();
    await expect(adminPage.getByText('Transaction Tokens', { exact: true })).toBeVisible();
    await expect(adminPage.getByText('Coming soon').first()).toBeVisible();

    // The subtitle names community tokens in a stock build.
    await expect(adminPage.getByText('community tokens', { exact: false })).toBeVisible();

    await snap(adminPage, 'stock-matou-wallet-all-three-entries');
  });
});
