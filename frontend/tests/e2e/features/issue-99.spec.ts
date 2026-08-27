import { test, expect, Page } from './fixtures';

/**
 * Feature (#99): on Capacitor (Android) the WebView blocks the frontend's
 * cleartext fetch to the remote config server, so `fetchClientConfig()` now
 * sources the client config from the embedded backend's loopback API
 * (`/api/v1/client-config`) instead. Electron and browser builds are
 * unaffected — they keep hitting the remote config server directly.
 *
 * The Capacitor path itself cannot run in this browser-based Playwright harness
 * (no embedded Go backend / MatouBackend plugin in a browser) — it needs live
 * Android verification. What IS testable here is the acceptance criterion
 * "Electron and browser builds are unaffected": the app must still boot past
 * the splash and reach the community with client config loaded, i.e. no
 * "Connection Error" from the config fetch.
 */

// Dismiss the welcome splash if present so we land on the community view.
async function enterCommunity(page: Page) {
  await page
    .getByRole('button', { name: /enter community/i })
    .click({ timeout: 15_000 })
    .catch(() => {});
}

test.describe('client config fetch unaffected on browser (#99)', () => {
  test('app boots with client config loaded and no Connection Error', async ({ adminPage, snap }) => {
    test.setTimeout(120_000);

    // Reaching a logged-in adminPage already means the browser config fetch
    // (the unchanged, non-Capacitor path) succeeded — the splash's
    // "Connection Error — cannot connect to config server" never fired.
    await expect(adminPage.getByText(/connection error/i)).toHaveCount(0);
    await snap(adminPage, 'booted-config-loaded');

    await enterCommunity(adminPage);
    await snap(adminPage, 'community-reached');
  });
});
