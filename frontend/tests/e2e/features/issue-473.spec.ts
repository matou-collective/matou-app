/**
 * #473 — mobile linked-device sign-in: the "Sign in with your computer" landing
 * button and the LinkDeviceScanScreen paste fallback (spec §1, §2 "Frontend").
 *
 * The scan screen lives inside the Capacitor shell, so this stubs
 * `window.Capacitor` (making `isCapacitor()` true and pointing the embedded
 * backend at the test backend on 9080) and drives the **paste fallback** — the
 * path emulators, e2e and dev use, since the camera scanner is device-only.
 * The pairing protocol itself is route-mocked here so the screen's outcome
 * rendering is deterministic and needs no live config-server mailbox; the full
 * two-backend handshake ending on welcome-overlay is exercised by the S9
 * two-client feature specs, and the real camera scan by device acceptance
 * (#476).
 */
import { test, expect } from './fixtures';

// Injected before any app script runs, so isCapacitor() is true from boot. The
// MatouBackend plugin points at the test backend already listening on 9080; the
// SecureStorage plugin is a tiny in-memory map; BarcodeScanner is deliberately
// absent so the screen offers the paste fallback (no camera in CI).
const CAPACITOR_SHIM = `
  (function () {
    const store = {};
    window.Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
      Plugins: {
        MatouBackend: { getInfo: async () => ({ port: 9080, token: 'matou-dev' }) },
        SecureStorage: {
          getItem: async ({ key }) => ({ value: key in store ? store[key] : null }),
          setItem: async ({ key, value }) => { store[key] = value; },
          removeItem: async ({ key }) => { delete store[key]; },
        },
      },
    };
  })();
`;

const PASTE_PAYLOAD = 'matou://pair?v=1&id=abc&pk=pk&s=s&cs=http://localhost:4904';

test('landing button + scan screen paste fallback (desktop-to-phone)', async ({ freshPage, snap }) => {
  const page = freshPage;
  await page.addInitScript(CAPACITOR_SHIM);

  await page.goto('/');

  // Splash entry options render once the app is ready.
  const linkButton = page.getByRole('button', { name: 'Sign in with your computer' });
  const joinButton = page.getByRole('button', { name: 'Join Now' });
  await expect(linkButton).toBeVisible();
  await expect(joinButton).toBeVisible();
  await expect(
    page.getByText('Already a member on your computer? Sign in here instead of joining again.'),
  ).toBeVisible();

  // Spec §1: the linked-device button sits ABOVE "Join Now".
  const linkBox = await linkButton.boundingBox();
  const joinBox = await joinButton.boundingBox();
  expect(linkBox && joinBox && linkBox.y < joinBox.y).toBeTruthy();
  await snap(page, 'splash-sign-in-with-computer');

  // Route-mock the pairing protocol: a fresh phone scanning a holding desktop.
  await page.route('**/api/v1/pairing/scan', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sessionId: 'sess-473',
        outcome: 'desktop-to-phone',
        code: '482913',
        peerDeviceName: 'Test Laptop',
      }),
    });
  });
  // Status polling stays in a pre-approval state so the waiting UI holds.
  await page.route('**/api/v1/pairing/sessions/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ state: 'acked', outcome: 'desktop-to-phone', code: '482913' }),
    });
  });

  await linkButton.click();

  // Scan screen: the paste fallback is offered.
  await expect(page.getByText('Scan the code on your computer')).toBeVisible();
  const pasteField = page.locator('#paste-code');
  await expect(pasteField).toBeVisible();
  await snap(page, 'scan-screen-paste-fallback');

  // Paste the code and continue → the waiting-for-approval state with the code.
  await pasteField.fill(PASTE_PAYLOAD);
  await page.locator('.paste-box').getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByTestId('sas-code')).toHaveText('482913');
  await expect(page.getByText('Waiting for approval on your other device')).toBeVisible();
  await snap(page, 'waiting-for-approval');
});

test('holder phone shows the approve prompt (phone-to-desktop)', async ({ freshPage, snap }) => {
  const page = freshPage;
  await page.addInitScript(CAPACITOR_SHIM);
  await page.goto('/');

  const linkButton = page.getByRole('button', { name: 'Sign in with your computer' });
  await expect(linkButton).toBeVisible();

  await page.route('**/api/v1/pairing/scan', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sessionId: 'sess-hold',
        outcome: 'phone-to-desktop',
        code: '044175', // leading zero must survive as a string
        peerDeviceName: 'Work Desktop',
      }),
    });
  });

  await linkButton.click();
  await page.locator('#paste-code').fill(PASTE_PAYLOAD);
  await page.locator('.paste-box').getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByText('Work Desktop')).toBeVisible();
  await expect(page.getByTestId('sas-code')).toHaveText('044175');
  await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await snap(page, 'holder-approve-prompt');
});
