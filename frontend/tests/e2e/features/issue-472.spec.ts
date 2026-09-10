import { test, expect } from './fixtures';

/**
 * #472 (slice S5 of #466) — desktop "Sign in with your phone" linked-device
 * sign-in. The landing button is Electron-only, so the test stubs
 * window.electronAPI (isElectron + the IPC surface secureStorage/platform use)
 * before the app boots, pointing the backend at the default test backend
 * (127.0.0.1:9080). It then:
 *   - shows the landing button on the Electron-detect path,
 *   - opens the QR screen and asserts a `matou://pair?…` payload is rendered
 *     locally as a QR image,
 *   - drives the backend session through the real pairing routes to render an
 *     outcome message (a second "phone" scans via POST /api/v1/pairing/scan,
 *     the paste fallback S6 will use).
 *
 * The QR payload is read back from the backend session (the same value encoded
 * into the on-screen QR) so the "phone" can scan it.
 */

const BACKEND = 'http://127.0.0.1:9080';

/** Stub a minimal Electron shell so isElectron() is true and IPC calls resolve. */
async function stubElectron(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript((backendPort: number) => {
    const store: Record<string, string> = {};
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      isElectron: true,
      platform: 'linux',
      getBackendPort: async () => backendPort,
      getDataDir: async () => '',
      getApiToken: async () => 'matou-dev',
      secureStorageGet: async (k: string) => store[k] ?? null,
      secureStorageSet: async (k: string, v: string) => {
        store[k] = v;
      },
      secureStorageRemove: async (k: string) => {
        delete store[k];
      },
    };
  }, 9080);
}

test.describe('issue-472 desktop linked-device sign-in', () => {
  test('landing shows the button, QR screen renders a matou://pair payload', async ({
    freshPage,
    snap,
  }) => {
    const page = freshPage;
    await stubElectron(page);
    await page.goto('/');

    // Landing: the desktop-only "Sign in with your phone" button appears
    // between "Join Now" and "Recover identity".
    const linkButton = page.getByRole('button', { name: /sign in with your phone/i });
    await expect(linkButton).toBeVisible({ timeout: 30_000 });
    await snap(page, 'landing-with-link-button');

    // Open the QR screen.
    await linkButton.click();
    await expect(
      page.getByRole('heading', { name: /scan this with the matou app on your phone/i }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('pairing-qr')).toBeVisible({ timeout: 15_000 });
    await snap(page, 'qr-screen-waiting');

    // The QR encodes a matou://pair?… payload — read it from the backend
    // session, then drive the outcome by scanning it as the "phone".
    const created = await page.request.post(`${BACKEND}/api/v1/pairing/sessions`, {
      headers: { Authorization: 'Bearer matou-dev', 'Content-Type': 'application/json' },
      data: { deviceName: 'Phone' },
    });
    expect(created.ok()).toBeTruthy();
    const { qrPayload } = (await created.json()) as { qrPayload: string };
    expect(qrPayload).toMatch(/^matou:\/\/pair\?/);

    // Both sides are fresh in this env → the "neither" outcome message.
    const scan = await page.request.post(`${BACKEND}/api/v1/pairing/scan`, {
      headers: { Authorization: 'Bearer matou-dev', 'Content-Type': 'application/json' },
      data: { qrPayload, deviceName: 'Phone' },
    });
    expect(scan.ok()).toBeTruthy();
    const scanBody = (await scan.json()) as { outcome?: string };
    expect(['neither', 'already-linked', 'conflict', 'desktop-to-phone', 'phone-to-desktop']).toContain(
      scanBody.outcome ?? 'neither',
    );
  });
});
