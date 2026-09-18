import { test, expect, Page, BrowserContext } from '@playwright/test';
import { setupTestConfig } from './utils/mock-config';
import { requireAllTestServices } from './utils/keri-testnet';
import { BackendManager } from './utils/backend-manager';
import { startAndroidApp, cleanupAndroidApp, type AndroidApp } from './utils/android-device';
import {
  BACKEND_URL,
  setupPageLogging,
  setupBackendRouting,
  loginWithMnemonic,
  loadAccounts,
  type TestAccounts,
} from './utils/test-helpers';

/**
 * E2E: Linked-device sign-in on a REAL Android build (#466 / acceptance #476)
 *
 * The S9 spec (features/issue-475) proves the pairing protocol between two
 * browser contexts with a stubbed Capacitor shell. This spec swaps the stub for
 * the real thing: the debug APK (gomobile-embedded Go backend + Capacitor
 * WebView) installed fresh on an emulator or USB device, driven through
 * Playwright's Android WebView bridge. The only concession is the QR itself —
 * an emulator has no camera to point at the desktop, so the phone uses the scan
 * screen's own "paste the code" fallback with the exact payload the QR encodes.
 *
 * Story (one serial run, after org-setup + member registration):
 *  1. The app is installed fresh and offers "Sign in with your computer".
 *  2. The admin, signed in on the desktop, opens Settings → Devices → "Link
 *     another device"; the phone pastes the code; both show the same 6-char
 *     code; the admin approves on the desktop; the phone lands on the dashboard
 *     holding the SAME AID.
 *  3. The admin renames themselves on the PHONE → the desktop shows the new name.
 *  4. member1 posts in a channel → the admin sees it on the desktop AND the phone.
 *  5. The admin replies on the DESKTOP → the reply shows up on the phone.
 *
 * Needs: the live test network, the admin backend on 9080, an attached device
 * or the `matou` AVD, and a TEST-mode APK — see utils/android-device.ts.
 *
 * Run:  npx playwright test --project=linked-device-android
 */

const CHAT_HASH = '#/dashboard/chat';
const SETTINGS_HASH = '#/dashboard/settings';
const SYNC_BUDGET_MS = 240_000;

test.describe.serial('Linked-device sign-in on Android', () => {
  let accounts: TestAccounts;
  let phone: AndroidApp;
  let adminContext: BrowserContext;
  let desktop: Page;
  let memberContext: BrowserContext;
  let member: Page;
  let adminAid = ''; // as the DESKTOP backend reports it; test-accounts.json may not carry it
  const backends = new BackendManager();

  const suffix = Date.now().toString(36).slice(-5);
  const channelName = `linked-${suffix}`;
  const memberMessage = `Kia ora admin, from member1 ${suffix}`;
  const adminReply = `Reply from the desktop ${suffix}`;

  // --- helpers ---------------------------------------------------------------

  async function shot(page: Page, label: string): Promise<void> {
    const file = test.info().outputPath(`${label}.png`);
    await page.screenshot({ path: file }).catch(() => undefined);
    await test.info().attach(label, { path: file, contentType: 'image/png' }).catch(() => undefined);
  }

  /** Hash-route navigation that works on both surfaces: the WebView page has no
   *  baseURL (its origin is https://localhost inside the APK). Bounces through
   *  the dashboard when already on the target so the page really remounts. */
  async function goHash(page: Page, hash: string): Promise<void> {
    await page.evaluate((h) => {
      if (window.location.hash === h) window.location.hash = '#/dashboard';
    }, hash);
    await page.evaluate((h) => {
      window.location.hash = h;
    }, hash);
  }

  /** Identity as the phone's EMBEDDED backend reports it, asked from inside the
   *  WebView (the port is per-launch and only reachable on the device). */
  async function phoneIdentity(): Promise<{ configured: boolean; aid?: string }> {
    return phone.page.evaluate(async () => {
      const cap = (window as unknown as {
        Capacitor: {
          Plugins: { MatouBackend: { getInfo: () => Promise<{ port: number; token: string }> } };
        };
      }).Capacitor;
      const { port, token } = await cap.Plugins.MatouBackend.getInfo();
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/identity`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return (await res.json()) as { configured: boolean; aid?: string };
    });
  }

  /** Link mode never forks a space, so the welcome overlay can park on "Waiting
   *  for your data to sync…" with a manual Retry (see issue-475's
   *  enterCommunityToDashboard). Drive it the way a user would, bounded. */
  async function enterCommunityOnPhone(): Promise<void> {
    const page = phone.page;
    const enter = page.getByRole('button', { name: /enter community/i });
    const retry = page.getByRole('button', { name: /^retry$/i });
    const deadline = Date.now() + 420_000;
    let retries = 0;
    while (Date.now() < deadline) {
      if (/#\/dashboard/.test(page.url())) return;
      if (await enter.isVisible().catch(() => false)) {
        await expect(enter).toBeEnabled({ timeout: 120_000 });
        await enter.click();
        await expect(page).toHaveURL(/#\/dashboard/, { timeout: 60_000 });
        return;
      }
      if (await retry.isVisible().catch(() => false)) {
        retries++;
        await retry.click();
      }
      await page.waitForTimeout(3_000);
    }
    await shot(page, 'phone-never-reached-dashboard');
    throw new Error(
      `phone never reached the dashboard (${retries} Retry click(s) in 7 min).\n` +
        `Embedded backend log tail:\n${phone.backendLog().slice(-4000)}`,
    );
  }

  /** Open `channel` in the chat page. Desktop is two-pane; the phone is
   *  single-pane, so the channel list may already be replaced by the channel. */
  async function openChannel(page: Page, channel: string): Promise<boolean> {
    await goHash(page, CHAT_HASH);
    const item = page.locator('.channel-item').filter({ hasText: channel });
    const header = page.locator('.channel-header .channel-name').filter({ hasText: channel });
    await expect(item.or(header).first()).toBeVisible({ timeout: 20_000 }).catch(() => undefined);
    if (await header.isVisible().catch(() => false)) return true;
    if (!(await item.isVisible().catch(() => false))) return false;
    await item.click();
    await expect(header).toBeVisible({ timeout: 10_000 });
    return true;
  }

  /** Wait for `text` to show in `channel`. First leaves the open channel alone
   *  so a LIVE update (SSE push) gets a fair chance; only then falls back to
   *  re-entering chat. Which path delivered is recorded on the test report. */
  async function expectMessage(
    page: Page,
    channel: string,
    text: string,
    who: string,
  ): Promise<void> {
    const body = page.locator('.message-body').filter({ hasText: text });
    const opened = await openChannel(page, channel);
    if (opened) {
      const live = await body
        .first()
        .waitFor({ state: 'visible', timeout: 60_000 })
        .then(() => true)
        .catch(() => false);
      if (live) {
        test.info().annotations.push({ type: 'delivery', description: `${who}: live` });
        return;
      }
    }
    await expect
      .poll(
        async () => {
          if (!(await openChannel(page, channel))) return false;
          return body.first().isVisible().catch(() => false);
        },
        { timeout: SYNC_BUDGET_MS, intervals: [5_000] },
      )
      .toBe(true);
    test.info().annotations.push({ type: 'delivery', description: `${who}: after re-entering chat` });
  }

  async function sendMessage(page: Page, text: string): Promise<void> {
    await page.locator('.message-input').fill(text);
    await page.locator('.send-btn').click();
    await expect(page.locator('.message-input')).toHaveValue('');
    await expect(page.locator('.message-body').filter({ hasText: text }).first()).toBeVisible({
      timeout: 15_000,
    });
  }

  const nameInput = (page: Page) => page.locator('input[placeholder="Your display name"]');

  // --- lifecycle -------------------------------------------------------------

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(900_000); // emulator cold boot + APK install + admin recovery
    await requireAllTestServices();

    accounts = loadAccounts();
    if (!accounts.admin?.mnemonic || !accounts.member?.mnemonic) {
      throw new Error(
        'test-accounts.json needs an admin and a member — run via ' +
          '`--project=linked-device-android` so org-setup + registration-member bootstrap first.',
      );
    }

    phone = await startAndroidApp();
    setupPageLogging(phone.page, 'Phone');

    adminContext = await browser.newContext();
    await setupTestConfig(adminContext);
    desktop = await adminContext.newPage();
    setupPageLogging(desktop, 'Desktop');
  });

  test.afterAll(async () => {
    // The phone goes last but must always go: this is what removes the mirrored
    // org and kills an emulator the harness booted — also when beforeAll timed
    // out inside startAndroidApp and `phone` was never assigned.
    try {
      await memberContext?.close().catch(() => undefined);
      await adminContext?.close().catch(() => undefined);
      await backends.stopAll();
    } finally {
      await cleanupAndroidApp();
    }
  });

  // --- 1 ---------------------------------------------------------------------

  test('the freshly installed app offers "Sign in with your computer"', async () => {
    test.setTimeout(300_000);
    // Cold boot: the embedded backend starts, fetches client config through the
    // tunnel, and the splash only renders its entries once the org is known.
    await expect(
      phone.page.getByRole('button', { name: 'Sign in with your computer' }),
    ).toBeVisible({ timeout: 240_000 });
    expect((await phoneIdentity()).configured, 'fresh install holds no identity').toBeFalsy();
    await shot(phone.page, '1-phone-splash');
  });

  // --- 2 ---------------------------------------------------------------------

  test('admin links the phone from desktop Settings → same identity on both', async () => {
    test.setTimeout(900_000);

    // The admin is signed in on the desktop (admin backend, port 9080).
    await loginWithMnemonic(desktop, accounts.admin!.mnemonic);

    // Desktop: Settings → Devices → Link another device → the QR screen. The
    // createSession response is the very payload the QR encodes.
    await desktop.goto(`/${SETTINGS_HASH}`);
    await expect(desktop.locator('[data-test="devices-section"]')).toBeVisible({ timeout: 30_000 });
    const created = desktop.waitForResponse(
      (r) => r.url().endsWith('/api/v1/pairing/sessions') && r.request().method() === 'POST',
      { timeout: 30_000 },
    );
    await desktop.locator('[data-test="link-device-btn"]').click();
    const { qrPayload } = (await (await created).json()) as { qrPayload: string };
    expect(qrPayload).toMatch(/^matou:\/\/pair\?/);
    await expect(desktop.locator('[data-testid="pairing-qr"]')).toBeVisible({ timeout: 15_000 });
    await shot(desktop, '2-desktop-qr');

    // Phone: Sign in with your computer → paste the code.
    await phone.page.getByRole('button', { name: 'Sign in with your computer' }).click();
    const paste = phone.page.locator('#paste-code');
    await expect(paste).toBeVisible({ timeout: 15_000 });
    await paste.fill(qrPayload);
    await phone.page.locator('.paste-box').getByRole('button', { name: 'Continue' }).click();

    // The holder (desktop) gets Approve + the code; the phone shows the same code.
    const approve = desktop.getByRole('button', { name: /^approve$/i });
    await expect(approve).toBeVisible({ timeout: 90_000 });
    const code = (await desktop.getByTestId('pairing-code').textContent())?.trim() ?? '';
    expect(code).toHaveLength(6);
    await expect(phone.page.getByTestId('sas-code')).toHaveText(code, { timeout: 30_000 });
    await shot(desktop, '2-desktop-approve');
    await shot(phone.page, '2-phone-code');

    // Approve on the desktop → the identity travels → the phone recovers in link mode.
    await approve.click();
    await enterCommunityOnPhone();
    await shot(phone.page, '2-phone-dashboard');
    await expect(desktop.getByRole('heading', { name: /^linked$/i })).toBeVisible({
      timeout: 90_000,
    });
    await shot(desktop, '2-desktop-linked');

    // One identity, two devices.
    const onDesktop = (await (await fetch(`${BACKEND_URL}/api/v1/identity`)).json()) as {
      aid?: string;
    };
    adminAid = onDesktop.aid ?? '';
    expect(adminAid, 'desktop backend holds the admin identity').toBeTruthy();
    const onPhone = await phoneIdentity();
    expect(onPhone.configured).toBeTruthy();
    expect(onPhone.aid).toBe(adminAid);

    // Back out of the link dialog so the desktop is usable for the next steps.
    const dialog = desktop.locator('.link-device-host');
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toBeHidden({ timeout: 10_000 });
  });

  // --- 3 ---------------------------------------------------------------------

  test('a profile change on the phone shows up on the desktop', async () => {
    test.setTimeout(420_000);
    const newName = `Admin on phone ${suffix}`;

    // Make sure the desktop is showing the OLD name before the edit.
    await desktop.goto('/#/dashboard');
    await desktop.goto(`/${SETTINGS_HASH}`);
    await expect(nameInput(desktop)).not.toHaveValue('', { timeout: 30_000 });
    expect(await nameInput(desktop).inputValue()).not.toBe(newName);

    // Edit on the phone. A just-linked device may still be pulling the profile,
    // so wait for the current name to load before overwriting it.
    await goHash(phone.page, SETTINGS_HASH);
    await expect(nameInput(phone.page)).toBeVisible({ timeout: 60_000 });
    await expect(nameInput(phone.page)).not.toHaveValue('', { timeout: 120_000 });
    await nameInput(phone.page).fill(newName);
    await phone.page.getByRole('button', { name: /save changes/i }).click();
    await expect(phone.page.locator('.save-success')).toBeVisible({ timeout: 30_000 });
    await shot(phone.page, '3-phone-renamed');

    // The desktop picks it up with no action from the user beyond looking.
    await expect
      .poll(
        async () => {
          await desktop.goto('/#/dashboard');
          await desktop.goto(`/${SETTINGS_HASH}`);
          await expect(nameInput(desktop)).not.toHaveValue('', { timeout: 20_000 }).catch(() => {});
          return nameInput(desktop).inputValue().catch(() => '');
        },
        { timeout: SYNC_BUDGET_MS, intervals: [5_000] },
      )
      .toBe(newName);
    await shot(desktop, '3-desktop-sees-new-name');

    // And the admin backend serves exactly one SharedProfile for this AID —
    // the linked device edited the profile, it did not fork a second one.
    const res = await fetch(`${BACKEND_URL}/api/v1/profiles`);
    expect(res.ok, `GET /api/v1/profiles failed: ${res.status}`).toBeTruthy();
    const profiles = (await res.json()) as {
      SharedProfile?: { data?: { aid?: string; displayName?: string } }[];
    };
    const mine = (profiles.SharedProfile ?? []).filter((p) => p.data?.aid === adminAid);
    expect(mine).toHaveLength(1);
    expect(mine[0].data?.displayName).toBe(newName);
  });

  // --- 4 ---------------------------------------------------------------------

  test("member1's message reaches the admin on the desktop and the phone", async ({ browser }) => {
    test.setTimeout(900_000);

    // The admin opens a channel from the desktop.
    await desktop.goto(`/${CHAT_HASH}`);
    await expect(desktop.locator('.create-btn')).toBeVisible({ timeout: 30_000 });
    await desktop.locator('.create-btn').click();
    await desktop.locator('#name').fill(channelName);
    await desktop.locator('#description').fill('Linked-device e2e');
    await desktop.locator('.modal-content .btn-primary').click();
    await expect(desktop.locator('.channel-item').filter({ hasText: channelName })).toBeVisible({
      timeout: 30_000,
    });

    // member1 signs in on their own backend.
    const { retry } = test.info();
    const memberBackend = await backends.start(retry > 0 ? `lda-member-r${retry}` : 'lda-member');
    memberContext = await browser.newContext();
    await setupTestConfig(memberContext);
    await setupBackendRouting(memberContext, memberBackend.port);
    member = await memberContext.newPage();
    setupPageLogging(member, 'Member1');
    await loginWithMnemonic(member, accounts.member!.mnemonic);

    // member1 finds the channel (P2P sync) and writes to the admin.
    await expect
      .poll(() => openChannel(member, channelName), { timeout: SYNC_BUDGET_MS, intervals: [5_000] })
      .toBe(true);
    await sendMessage(member, memberMessage);
    await shot(member, '4-member-sent');

    // The admin receives it on BOTH devices.
    await expectMessage(desktop, channelName, memberMessage, 'desktop ← member1');
    await shot(desktop, '4-desktop-received');
    await expectMessage(phone.page, channelName, memberMessage, 'phone ← member1');
    await shot(phone.page, '4-phone-received');
  });

  // --- 5 ---------------------------------------------------------------------

  test("the admin's reply on the desktop syncs to the phone", async () => {
    test.setTimeout(600_000);

    expect(await openChannel(desktop, channelName)).toBeTruthy();
    await sendMessage(desktop, adminReply);
    await shot(desktop, '5-desktop-replied');

    await expectMessage(phone.page, channelName, adminReply, 'phone ← desktop reply');
    await shot(phone.page, '5-phone-sees-reply');

    // The conversation closes the loop: member1 gets the reply too.
    await expectMessage(member, channelName, adminReply, 'member1 ← desktop reply');
  });
});
