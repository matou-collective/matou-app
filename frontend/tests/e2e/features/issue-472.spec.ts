import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { BackendManager } from '../utils/backend-manager';

/**
 * #472 (slice S5 of #466) — desktop "Sign in with your phone" linked-device
 * sign-in, driven against the REAL pairing routes (backend #484) and the real
 * mailbox on the test config server.
 *
 * The landing button is Electron-only, so the test stubs window.electronAPI
 * (isElectron + the IPC surface platform/secureStorage/titlebar use) before the
 * app boots, pointing the page at the default admin backend (127.0.0.1:9080).
 *
 * The backend keeps at most ONE pairing session per process (a new session or
 * scan replaces — cancels — the current one), so the "phone" must be a second
 * backend: BackendManager spawns one with a fresh data dir (no identity), and
 * the test acts as the phone's UI by calling that backend's
 * `POST /api/v1/pairing/scan` (the S6 paste fallback) and `GET …/identity`.
 *
 * The admin backend on 9080 already holds the org-setup identity, so the
 * desktop is the HOLDER: the screen must show the SAS code + the phone's
 * device name + Approve / Cancel, must NOT approve on its own, and only after
 * Approve may the phone read the identity — exactly once.
 */

const ADMIN_BACKEND = 'http://127.0.0.1:9080';
const AUTH = { Authorization: 'Bearer matou-dev', 'Content-Type': 'application/json' };

interface Status {
  state: string;
  outcome?: string;
  code?: string;
  peerDeviceName?: string;
  error?: string;
}

/** Stub a minimal Electron shell so isElectron() is true and IPC calls resolve. */
async function stubElectron(page: Page): Promise<void> {
  await page.addInitScript((backendPort: number) => {
    const store: Record<string, string> = {};
    const noop = () => undefined;
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
      // Titlebar / update banner / notifications call these on mount.
      windowMinimize: async () => undefined,
      windowMaximize: async () => undefined,
      windowClose: async () => undefined,
      windowIsMaximized: async () => false,
      onUpdateDownloaded: noop,
      installUpdate: async () => undefined,
      notify: async () => undefined,
      onNotificationClicked: noop,
    };
  }, 9080);
}

async function getStatus(page: Page, base: string, sessionId: string): Promise<Status> {
  const res = await page.request.get(`${base}/api/v1/pairing/sessions/${sessionId}`, { headers: AUTH });
  return (await res.json()) as Status;
}

async function waitForState(
  page: Page,
  base: string,
  sessionId: string,
  states: string[],
  timeoutMs = 60_000,
): Promise<Status> {
  const deadline = Date.now() + timeoutMs;
  let last: Status = { state: '?' };
  while (Date.now() < deadline) {
    last = await getStatus(page, base, sessionId);
    if (states.includes(last.state)) return last;
    await page.waitForTimeout(500);
  }
  throw new Error(`session ${sessionId} on ${base} never reached ${states.join('/')}: ${JSON.stringify(last)}`);
}

/**
 * From the landing screen: click "Sign in with your phone", capture the
 * session the SCREEN created (from the backend response — the same payload it
 * renders as the QR), and assert the waiting state renders.
 */
async function openQrScreen(page: Page): Promise<{ sessionId: string; qrPayload: string }> {
  const linkButton = page.getByRole('button', { name: /sign in with your phone/i });
  await expect(linkButton).toBeVisible({ timeout: 30_000 });

  const created = page.waitForResponse(
    (r) => r.url().endsWith('/api/v1/pairing/sessions') && r.request().method() === 'POST',
    { timeout: 20_000 },
  );
  await linkButton.click();
  const body = (await (await created).json()) as { sessionId: string; qrPayload: string };
  expect(body.sessionId).toBeTruthy();
  expect(body.qrPayload).toMatch(/^matou:\/\/pair\?/);

  await expect(
    page.getByRole('heading', { name: /scan this with the matou app on your phone/i }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('pairing-qr')).toBeVisible({ timeout: 15_000 });
  // Session countdown (m:ss) from the backend's expiresAt.
  await expect(page.getByText(/this code expires in \d+:\d\d/i)).toBeVisible();
  return body;
}

test.describe('issue-472 desktop linked-device sign-in', () => {
  test('landing shows the button; the QR screen renders the session and Back cancels it', async ({
    freshPage,
    snap,
  }) => {
    const page = freshPage;
    await stubElectron(page);
    await page.goto('/');

    await expect(page.getByRole('button', { name: /sign in with your phone/i })).toBeVisible({
      timeout: 30_000,
    });
    await snap(page, 'landing-with-link-button');

    const { sessionId } = await openQrScreen(page);
    expect((await getStatus(page, ADMIN_BACKEND, sessionId)).state).toBe('created');
    await snap(page, 'qr-screen-waiting');

    // Back tears the backend session down and returns to the landing screen.
    await page.locator('.back-btn').click();
    await expect(page.getByRole('button', { name: /join now/i })).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(async () => (await getStatus(page, ADMIN_BACKEND, sessionId)).state, { timeout: 10_000 })
      .toBe('cancelled');
  });

  test('desktop holds: the phone scan shows the code + Approve, and only Approve releases the identity once', async ({
    freshPage,
    snap,
  }) => {
    test.setTimeout(180_000);
    const page = freshPage;
    await stubElectron(page);

    // The admin backend is the holder (org-setup configured its identity).
    const identityRes = await page.request.get(`${ADMIN_BACKEND}/api/v1/identity`);
    const adminIdentity = (await identityRes.json()) as { configured: boolean; aid?: string };
    expect(adminIdentity.configured, 'admin backend must hold an identity (org-setup)').toBe(true);

    await page.goto('/');
    const { sessionId: desktopSession, qrPayload } = await openQrScreen(page);

    const backends = new BackendManager();
    try {
      const phone = await backends.start('issue-472-phone');

      // The "phone" (fresh backend) scans the on-screen payload.
      const scanRes = await page.request.post(`${phone.url}/api/v1/pairing/scan`, {
        headers: AUTH,
        data: { qrPayload, deviceName: 'Test phone' },
        timeout: 90_000,
      });
      expect(scanRes.ok(), `scan failed: ${scanRes.status()} ${await scanRes.text()}`).toBeTruthy();
      const scan = (await scanRes.json()) as { sessionId: string; outcome: string; code: string; peerDeviceName: string };
      expect(scan.outcome).toBe('desktop-to-phone');
      expect(typeof scan.code).toBe('string');
      expect(scan.code).toHaveLength(6);
      // The phone sees the desktop's device name (from the ack), not "This device".
      expect(scan.peerDeviceName).toBe('Linux computer');

      // Desktop screen: code (string-equal, leading zeros intact), phone's
      // name, Approve / Cancel — and nothing has been approved yet.
      await expect(page.getByRole('heading', { name: /sign in on test phone\?/i })).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByTestId('pairing-code')).toHaveText(scan.code);
      const approve = page.getByRole('button', { name: /^approve$/i });
      await expect(approve).toBeVisible();
      await expect(page.getByRole('button', { name: /^cancel$/i })).toBeVisible();
      await snap(page, 'holder-approve');

      expect((await getStatus(page, phone.url, scan.sessionId)).state).toBe('acked');
      expect((await getStatus(page, ADMIN_BACKEND, desktopSession)).state).toBe('acked');
      // Identity must not be readable before Approve.
      const early = await page.request.get(`${phone.url}/api/v1/pairing/sessions/${scan.sessionId}/identity`, {
        headers: AUTH,
      });
      expect(early.status()).toBe(404);

      // Approve on the desktop → the identity travels to the phone.
      await approve.click();
      const phoneState = await waitForState(page, phone.url, scan.sessionId, ['identity-received', 'done']);
      expect(phoneState.error ?? '').toBe('');

      const idRes = await page.request.get(`${phone.url}/api/v1/pairing/sessions/${scan.sessionId}/identity`, {
        headers: AUTH,
      });
      expect(idRes.ok(), `identity fetch failed: ${idRes.status()}`).toBeTruthy();
      const received = (await idRes.json()) as { mnemonic: string; aid: string };
      // Never print the mnemonic; only check its shape and that it is the admin's identity.
      expect(received.mnemonic.trim().split(/\s+/)).toHaveLength(12);
      expect(received.aid).toBe(adminIdentity.aid);

      // Exactly once: a second read is refused.
      const again = await page.request.get(`${phone.url}/api/v1/pairing/sessions/${scan.sessionId}/identity`, {
        headers: AUTH,
      });
      expect(again.status()).toBe(404);

      // The desktop shows Linked only once the phone's done{ok} arrived.
      await expect(page.getByRole('heading', { name: /^linked$/i })).toBeVisible({ timeout: 60_000 });
      const finalDesktop = await getStatus(page, ADMIN_BACKEND, desktopSession);
      expect(finalDesktop.state).toBe('done');
      await snap(page, 'holder-linked');

      await page.getByRole('button', { name: /^done$/i }).click();
      await expect(page.getByRole('button', { name: /join now/i })).toBeVisible({ timeout: 15_000 });
    } finally {
      await backends.stopAll();
    }
  });
});
