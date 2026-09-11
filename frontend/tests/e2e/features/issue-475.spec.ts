/**
 * #475 (slice S9 of #466) — two-client end-to-end coverage of linked-device
 * sign-in (spec `docs/superpowers/specs/2026-09-08-linked-device-sign-in-design.md`
 * §4). Builds on the desktop QR screen (#472) and the mobile scan screen (#473)
 * and drives the REAL pairing routes (backend #484) against the test config
 * server's mailbox — no protocol mocking.
 *
 * Pattern: two backends (BackendManager, ports 9280+, per-name data dirs), two
 * Playwright contexts, one org (the `features` project's org-setup +
 * registration-member bootstrap persist tests/e2e/test-accounts.json). The
 * "phone" stubs `window.Capacitor` (isCapacitor() → true) and uses the paste
 * fallback; the "desktop" stubs `window.electronAPI` (isElectron() → true).
 * Both browser contexts start with fresh localStorage, so a backend that already
 * holds an identity still shows the splash entry — the app's client session
 * (localStorage) and the backend's identity.json are independent (see #472
 * test 2, which drives a fresh splash against the holder admin backend).
 *
 * Scenarios (one test() each, spec §4 / the issue's list):
 *   1. desktop fresh ← phone holds        — link + adopt, no space create
 *   2. desktop holds → phone fresh        — mirror of 1, approval on the desktop
 *   3. both fresh                         — the "neither" message, no identity set
 *   4. both hold, different AIDs          — conflict, identity.json unchanged
 *   5. profile converges                  — display-name edit converges; one SharedProfile
 *   6. code-mismatch defence              — tampered `s=` → the displayer's hello
 *                                          fails to authenticate; session ends failed
 *
 * This spec needs the live test network (KERI + any-sync + the config-server
 * mailbox); it cannot run in the authoring sandbox. Scenarios 1/2/5 recover a
 * real registered identity (member/admin) through the recovery UI, so they carry
 * the same live-infra dependency and timing budget as e2e-account-recovery.
 *
 * NOTE ON IMPORTS: per the spec this slice reuses BackendManager and the
 * multi-backend helpers (e2e-multi-backend / e2e-account-recovery patterns), so
 * unlike a single-context feature spec it imports from ../utils in addition to
 * ./fixtures (which itself is built on those same utils). `test`/`expect`/`snap`
 * still come from ./fixtures so it runs under the `features` project bootstrap.
 */
import { test, expect } from './fixtures';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { BackendManager, BackendInstance } from '../utils/backend-manager';
import { setupTestConfig } from '../utils/mock-config';
import {
  setupBackendRouting,
  loginWithMnemonic,
  loadAccounts,
  CONFIG_SERVER_URL,
} from '../utils/test-helpers';

// Well-known BIP39 test mnemonic (passes validation) used to give a backend a
// *cheap* identity.json for the conflict/tamper scenarios, which only need
// identity presence + a distinct AID, not a live KERIA session (mirrors
// e2e-multi-backend.spec.ts).
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// The private-space creation breadcrumb (backend/internal/anysync/sdk_client.go).
// Link mode must NEVER create the private space, so this line must be ABSENT
// from the receiving backend's log across the whole link.
const PRIVATE_SPACE_CREATED = /Created space with keys:.*\(type: private\)/;

// Backends and browser contexts created across the serial run; torn down in
// afterAll. Scenario 5 reuses the linked pair established by scenario 1.
const backends = new BackendManager();
const contexts: BrowserContext[] = [];
const s1: {
  done?: boolean;
  phone?: BackendInstance;
  desktop?: BackendInstance;
  deskPage?: Page; // desktop, linked, on the dashboard
  phoneDashPage?: Page; // phone holder, on the dashboard
} = {};

test.afterAll(async () => {
  for (const ctx of contexts) await ctx.close().catch(() => undefined);
  await backends.stopAll();
});

// --- platform stubs (verbatim from issue-472 / issue-473) ---------------------

/** Stub a minimal Electron shell so isElectron() is true and IPC calls resolve.
 *
 *  `backendPort` MUST be this device's own BackendManager port, not 9080:
 *  src/lib/platform.ts:getBackendUrl() builds `http://127.0.0.1:<port>` from
 *  it, and setupBackendRouting only intercepts `http://localhost:9080/**`, so a
 *  127.0.0.1 URL is never rewritten. Reporting 9080 here silently pointed every
 *  context in this spec at the shared admin backend instead of its own. */
async function stubElectron(page: Page, backendPort: number): Promise<void> {
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
      windowMinimize: async () => undefined,
      windowMaximize: async () => undefined,
      windowClose: async () => undefined,
      windowIsMaximized: async () => false,
      onUpdateDownloaded: noop,
      installUpdate: async () => undefined,
      notify: async () => undefined,
      onNotificationClicked: noop,
    };
  }, backendPort);
}

// isCapacitor() true; BarcodeScanner is deliberately absent so the screen offers
// the paste fallback (no camera in CI). MatouBackend reports this device's own
// BackendManager port for the same reason as stubElectron above.
const capacitorShim = (backendPort: number): string => `
  (function () {
    const store = {};
    window.Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
      Plugins: {
        MatouBackend: { getInfo: async () => ({ port: ${backendPort}, token: 'matou-dev' }) },
        SecureStorage: {
          getItem: async ({ key }) => ({ value: key in store ? store[key] : null }),
          setItem: async ({ key, value }) => { store[key] = value; },
          removeItem: async ({ key }) => { delete store[key]; },
        },
      },
    };
  })();
`;

type Platform = 'electron' | 'capacitor';

/**
 * Serve the TEST client config on a Capacitor context.
 *
 * src/lib/clientConfig.ts:resolveConfigFetchUrl() sources client config from
 * `<backend>/api/v1/client-config` when isCapacitor() is true (#99/#368), but a
 * BackendManager backend never populates that endpoint: app.go only fetches (and
 * SetRaw's) when `backend/config/client-test.yml` is missing, and the admin
 * backend has already written it by the time these spawn — so it answers 503,
 * doFetchConfig() falls back to getDefaultConfig(), and the page ends up on the
 * DEV KERI ports (3901-3903) which no test network serves. That is the
 * "Failed to fetch" on the recovery screen in this PR's pr-e2e captures.
 *
 * Fulfilling the request from the test config server gives the Capacitor
 * contexts exactly the KERI URLs every other e2e spec uses. The on-device
 * loopback-proxy path this bypasses is #368's, not this slice's, and is covered
 * by device acceptance (#476).
 */
async function serveTestClientConfig(ctx: BrowserContext): Promise<void> {
  await ctx.route('**/api/v1/client-config', async (route) => {
    const upstream = await fetch(`${CONFIG_SERVER_URL}/api/client-config`, {
      headers: { 'X-Test-Config': 'true' },
    });
    await route.fulfill({
      status: upstream.status,
      contentType: 'application/json',
      body: await upstream.text(),
    });
  });
}

/** A fresh browser context routed to `backend`, with the platform stub installed
 *  before the app boots. localStorage starts empty → the splash renders. */
async function newDevice(
  browser: Browser,
  backend: BackendInstance,
  platform: Platform,
): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext();
  contexts.push(ctx);
  await setupTestConfig(ctx);
  // Belt and braces: the platform stubs point the app straight at
  // backend.port over 127.0.0.1, but getBackendUrlSync() (Electron, before
  // getBackendUrl() has resolved) still returns VITE_BACKEND_URL —
  // http://localhost:9080 — so keep the rewrite for those callers.
  await setupBackendRouting(ctx, backend.port);
  const page = await ctx.newPage();
  if (platform === 'electron') await stubElectron(page, backend.port);
  else {
    await serveTestClientConfig(ctx);
    await page.addInitScript(capacitorShim(backend.port));
  }
  return { ctx, page };
}

/** Recover a real registered identity onto `backend` through the recovery UI,
 *  leaving that context signed in on the dashboard (the backend's identity.json
 *  + spaces are now fully configured). Used to make a device the HOLDER. */
async function recoverDevice(
  browser: Browser,
  backend: BackendInstance,
  mnemonic: string[],
  platform: Platform,
): Promise<{ ctx: BrowserContext; page: Page }> {
  const dev = await newDevice(browser, backend, platform);
  await loginWithMnemonic(dev.page, mnemonic); // goes to '/', recovers, dashboard
  return dev;
}

// --- backend API helpers (direct, bypassing browser routing) ------------------

async function getIdentity(backend: BackendInstance): Promise<{
  configured: boolean;
  aid?: string;
  privateSpaceId?: string;
}> {
  const res = await fetch(`${backend.url}/api/v1/identity`);
  return (await res.json()) as { configured: boolean; aid?: string; privateSpaceId?: string };
}

/** Read one pairing session's status straight off a backend. */
async function getSessionStatus(
  backend: BackendInstance,
  sessionId: string,
): Promise<{ state: string; outcome?: string; code?: string; error?: string }> {
  const res = await fetch(`${backend.url}/api/v1/pairing/sessions/${sessionId}`);
  return (await res.json()) as { state: string; outcome?: string; code?: string; error?: string };
}

/** Give a backend a cheap identity.json with a specific AID (no live KERIA). */
async function setFakeIdentity(backend: BackendInstance, aid: string): Promise<void> {
  const res = await fetch(`${backend.url}/api/v1/identity/set`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ aid, mnemonic: TEST_MNEMONIC }),
  });
  expect(res.ok, `identity/set (${aid}) failed: ${res.status}`).toBeTruthy();
}

/** Accumulate a spawned backend's stderr (Go's `log` writes there) so a test can
 *  assert the ABSENCE of the private-space-create line. Node allows multiple
 *  listeners, so this does not conflict with BackendManager's own. Attach right
 *  after start(), before any link runs. */
function captureStderr(backend: BackendInstance): () => string {
  let buf = '';
  backend.process.stderr?.on('data', (d: Buffer) => {
    buf += d.toString();
  });
  return () => buf;
}

/**
 * Backend name scoped to the current attempt.
 *
 * `backends` is module-level and BackendManager.start() returns the cached
 * instance for a name it already holds, while test.afterAll runs once per
 * worker — so on a describe.serial retry the whole group would otherwise
 * re-run against the PREVIOUS attempt's half-written data dirs (the #502
 * failure mode: a stale identity turns a flake into a deterministic red).
 * Suffixing by retry index gives every attempt clean backends.
 */
function backendName(base: string): string {
  const { retry } = test.info();
  return retry > 0 ? `${base}-r${retry}` : base;
}

// --- UI drivers ---------------------------------------------------------------

/** Desktop: click "Sign in with your phone", capture the session the screen
 *  created (from the createSession response — the same payload it renders as the
 *  QR), and confirm the waiting state renders. */
async function openDesktopQr(page: Page): Promise<{ sessionId: string; qrPayload: string }> {
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
  return body;
}

/** Phone: open the scan screen and drive the paste fallback with `qrPayload`. */
async function pasteOnPhone(page: Page, qrPayload: string): Promise<void> {
  const linkButton = page.getByRole('button', { name: 'Sign in with your computer' });
  await expect(linkButton).toBeVisible({ timeout: 30_000 });
  await linkButton.click();
  const paste = page.locator('#paste-code');
  await expect(paste).toBeVisible({ timeout: 15_000 });
  await paste.fill(qrPayload);
  await page.locator('.paste-box').getByRole('button', { name: 'Continue' }).click();
}

/** Walk the welcome-overlay → dashboard hand-off the receiving side runs after a
 *  link-mode recovery (identical to the recovery flow). */
async function enterCommunityToDashboard(page: Page): Promise<void> {
  const enter = page.getByRole('button', { name: /enter community/i });
  try {
    await enter.waitFor({ state: 'visible', timeout: 180_000 });
    await expect(enter).toBeEnabled({ timeout: 120_000 });
    await enter.click();
  } catch {
    // Already routed straight to the dashboard.
  }
  await expect(page).toHaveURL(/#\/dashboard/, { timeout: 60_000 });
}

function tamperSecret(qrPayload: string): string {
  const params = new URLSearchParams(qrPayload.slice('matou://pair?'.length));
  const s = params.get('s') ?? '';
  // Flip the first character to a different base64url char — still a valid-shape
  // payload (id/pk/s present), but a wrong pairSecret → a different K.
  const flipped = (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
  params.set('s', flipped);
  return `matou://pair?${params.toString()}`;
}

// -----------------------------------------------------------------------------

test.describe.serial('issue-475 two-client linked-device sign-in', () => {
  // 1. desktop fresh ← phone holds -------------------------------------------
  test('1) desktop fresh ← phone holds: identity adopted, no private space created', async ({
    browser,
    snap,
  }) => {
    test.setTimeout(420_000);
    const accounts = loadAccounts();
    expect(accounts.member?.mnemonic, 'registration-member bootstrap persists a member').toBeTruthy();

    const phone = await backends.start(backendName('i475-s1-phone'));
    const desktop = await backends.start(backendName('i475-s1-desktop'));
    const desktopStderr = captureStderr(desktop);

    // Phone holds a real member identity (recovery UI → dashboard).
    const phoneDash = await recoverDevice(browser, phone, accounts.member!.mnemonic, 'capacitor');
    await snap(phoneDash.page, 's1-phone-holder-dashboard');

    // Desktop is fresh: open the QR and capture its payload.
    const desk = await newDevice(browser, desktop, 'electron');
    await desk.page.goto('/');
    const { qrPayload } = await openDesktopQr(desk.page);
    await snap(desk.page, 's1-desktop-qr-waiting');

    // Phone (fresh splash context on the SAME holder backend) scans by paste.
    const phoneScan = await newDevice(browser, phone, 'capacitor');
    await phoneScan.page.goto('/');
    await pasteOnPhone(phoneScan.page, qrPayload);

    // Holder phone shows Approve + the SAS code; the fresh desktop shows the
    // same code and waits for approval on the phone.
    await expect(phoneScan.page.getByRole('button', { name: 'Approve' })).toBeVisible({
      timeout: 60_000,
    });
    const code = (await phoneScan.page.getByTestId('sas-code').textContent())?.trim() ?? '';
    expect(code).toHaveLength(6);
    await expect(desk.page.getByTestId('pairing-code')).toHaveText(code, { timeout: 30_000 });
    await snap(phoneScan.page, 's1-phone-approve');
    await snap(desk.page, 's1-desktop-awaiting-approval');

    // Approve on the phone → identity travels → desktop recovers in link mode.
    await phoneScan.page.getByRole('button', { name: 'Approve' }).click();
    await enterCommunityToDashboard(desk.page);
    await snap(desk.page, 's1-desktop-dashboard');
    await expect(phoneScan.page.getByRole('heading', { name: /^linked$/i })).toBeVisible({
      timeout: 60_000,
    });

    // Both backends report the same identity + private space.
    const deskId = await getIdentity(desktop);
    const phoneId = await getIdentity(phone);
    expect(deskId.configured && phoneId.configured).toBeTruthy();
    expect(deskId.aid).toBe(phoneId.aid);
    expect(deskId.privateSpaceId).toBeTruthy();
    expect(deskId.privateSpaceId).toBe(phoneId.privateSpaceId);

    // Link mode adopted the private space; it never created one.
    // Positive control first: an absence assertion over a silent (detached,
    // renamed, or never-attached) stderr buffer would pass against anything.
    const deskLog = desktopStderr();
    expect(deskLog.length, 'desktop backend stderr was captured').toBeGreaterThan(0);
    expect(deskLog).not.toMatch(PRIVATE_SPACE_CREATED);

    // Hand the linked pair to scenario 5.
    s1.phone = phone;
    s1.desktop = desktop;
    s1.deskPage = desk.page;
    s1.phoneDashPage = phoneDash.page;
    s1.done = true;
  });

  // 2. desktop holds → phone fresh -------------------------------------------
  test('2) desktop holds → phone fresh: identity adopted, no private space created', async ({
    browser,
    snap,
  }) => {
    test.setTimeout(420_000);
    const accounts = loadAccounts();
    expect(accounts.admin?.mnemonic, 'org-setup persists the admin').toBeTruthy();

    const desktop = await backends.start(backendName('i475-s2-desktop'));
    const phone = await backends.start(backendName('i475-s2-phone'));
    const phoneStderr = captureStderr(phone);

    // Desktop holds a real admin identity (recovery UI → dashboard).
    const deskDash = await recoverDevice(browser, desktop, accounts.admin!.mnemonic, 'electron');
    await snap(deskDash.page, 's2-desktop-holder-dashboard');

    // Desktop opens the QR from a fresh splash context on the SAME holder backend.
    const deskLink = await newDevice(browser, desktop, 'electron');
    await deskLink.page.goto('/');
    const { qrPayload } = await openDesktopQr(deskLink.page);

    // Phone is fresh: scan by paste.
    const phoneDev = await newDevice(browser, phone, 'capacitor');
    await phoneDev.page.goto('/');
    await pasteOnPhone(phoneDev.page, qrPayload);

    // Holder desktop shows Approve + code; fresh phone waits with the same code.
    await expect(deskLink.page.getByRole('button', { name: /^approve$/i })).toBeVisible({
      timeout: 60_000,
    });
    const code = (await deskLink.page.getByTestId('pairing-code').textContent())?.trim() ?? '';
    expect(code).toHaveLength(6);
    await expect(phoneDev.page.getByTestId('sas-code')).toHaveText(code, { timeout: 30_000 });
    await snap(deskLink.page, 's2-desktop-approve');
    await snap(phoneDev.page, 's2-phone-waiting-approval');

    // Approve on the desktop → identity travels → phone recovers in link mode.
    await deskLink.page.getByRole('button', { name: /^approve$/i }).click();
    await enterCommunityToDashboard(phoneDev.page);
    await snap(phoneDev.page, 's2-phone-dashboard');

    const deskId = await getIdentity(desktop);
    const phoneId = await getIdentity(phone);
    expect(deskId.configured && phoneId.configured).toBeTruthy();
    expect(phoneId.aid).toBe(deskId.aid);
    expect(phoneId.privateSpaceId).toBeTruthy();
    expect(phoneId.privateSpaceId).toBe(deskId.privateSpaceId);
    const phoneLog = phoneStderr();
    expect(phoneLog.length, 'phone backend stderr was captured').toBeGreaterThan(0);
    expect(phoneLog).not.toMatch(PRIVATE_SPACE_CREATED);
    // The desktop holder only reports Linked once the phone's done{ok} lands.
    await expect(deskLink.page.getByRole('heading', { name: /^linked$/i })).toBeVisible({
      timeout: 60_000,
    });
  });

  // 3. both fresh -------------------------------------------------------------
  test('3) both fresh: the "neither" message, neither backend gets an identity', async ({
    browser,
    snap,
  }) => {
    test.setTimeout(180_000);
    const desktop = await backends.start(backendName('i475-s3-desktop'));
    const phone = await backends.start(backendName('i475-s3-phone'));

    const desk = await newDevice(browser, desktop, 'electron');
    await desk.page.goto('/');
    const { qrPayload } = await openDesktopQr(desk.page);

    const phoneDev = await newDevice(browser, phone, 'capacitor');
    await phoneDev.page.goto('/');
    await pasteOnPhone(phoneDev.page, qrPayload);

    // Both sides show the "neither" refusal. The phone's blocked card puts the
    // title in an <h4> and repeats the phrase in the body copy, so match the
    // heading by role — getByText(/…/) would match two nodes and blow up on
    // Playwright's strict mode before it ever reached the product behaviour.
    await expect(
      phoneDev.page.getByRole('heading', { name: 'Nothing to sign in with' }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(
      phoneDev.page.getByText('Neither device has an identity yet. Create or recover one first.'),
    ).toBeVisible();
    await expect(
      desk.page.getByRole('heading', { name: /neither device has an identity/i }),
    ).toBeVisible({ timeout: 60_000 });
    await snap(phoneDev.page, 's3-phone-neither');
    await snap(desk.page, 's3-desktop-neither');

    expect((await getIdentity(desktop)).configured).toBeFalsy();
    expect((await getIdentity(phone)).configured).toBeFalsy();

    // Nothing later in the serial run needs these two; free the ports and the
    // any-sync clients rather than holding them until afterAll.
    await backends.stop(desktop.name);
    await backends.stop(phone.name);
  });

  // 4. both hold, different AIDs ---------------------------------------------
  test('4) both hold different AIDs: conflict, neither identity.json changes', async ({
    browser,
    snap,
  }) => {
    test.setTimeout(180_000);
    const desktop = await backends.start(backendName('i475-s4-desktop'));
    const phone = await backends.start(backendName('i475-s4-phone'));

    // Both hold — with DIFFERENT AIDs (cheap identity.json, no live KERIA).
    await setFakeIdentity(desktop, 'EDesktopHolder475s4000000000000000000000000');
    await setFakeIdentity(phone, 'EPhoneHolder475s4000000000000000000000000000');
    const before = {
      desktop: (await getIdentity(desktop)).aid,
      phone: (await getIdentity(phone)).aid,
    };
    expect(before.desktop).toBeTruthy();
    expect(before.phone).toBeTruthy();
    expect(before.desktop).not.toBe(before.phone);

    const desk = await newDevice(browser, desktop, 'electron');
    await desk.page.goto('/');
    const { qrPayload } = await openDesktopQr(desk.page);

    const phoneDev = await newDevice(browser, phone, 'capacitor');
    await phoneDev.page.goto('/');
    await pasteOnPhone(phoneDev.page, qrPayload);

    // Both sides refuse with the "different identities" copy. Match the phone's
    // heading by role: its <h4> title ("Different identities") and its body copy
    // ("These devices hold different identities. …") both match a loose
    // getByText(/different identities/i), which is a strict-mode violation.
    await expect(
      phoneDev.page.getByRole('heading', { name: 'Different identities' }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(
      desk.page.getByRole('heading', { name: /different identities/i }),
    ).toBeVisible({ timeout: 60_000 });
    await snap(phoneDev.page, 's4-phone-conflict');
    await snap(desk.page, 's4-desktop-conflict');

    // Linking never overwrites: both identities are unchanged.
    expect((await getIdentity(desktop)).aid).toBe(before.desktop);
    expect((await getIdentity(phone)).aid).toBe(before.phone);

    await backends.stop(desktop.name);
    await backends.stop(phone.name);
  });

  // 5. profile converges ------------------------------------------------------
  test('5) profile edits converge across the linked pair; one SharedProfile', async ({ snap }) => {
    test.setTimeout(240_000);
    expect(s1.done, 'scenario 1 established the linked member pair').toBeTruthy();
    const desktop = s1.deskPage!; // desktop, linked member, dashboard
    const phone = s1.phoneDashPage!; // phone holder member, dashboard

    const settingsInput = (page: Page) => page.locator('input[placeholder="Your display name"]');

    async function editName(page: Page, name: string): Promise<void> {
      await page.goto('/#/dashboard/settings');
      const input = settingsInput(page);
      await expect(input).toBeVisible({ timeout: 30_000 });
      await input.fill(name);
      await page.getByRole('button', { name: /save changes/i }).click();
      await expect(page.getByText('Saved')).toBeVisible({ timeout: 30_000 });
    }

    async function expectNameConverges(page: Page, name: string): Promise<void> {
      // Reload to pull the latest SharedProfile the backend synced from any-sync.
      await expect
        .poll(
          async () => {
            await page.goto('/#/dashboard/settings');
            return settingsInput(page)
              .inputValue()
              .catch(() => '');
          },
          { timeout: 150_000, intervals: [5_000] },
        )
        .toBe(name);
    }

    // Edit on the desktop → converges on the phone.
    const nameA = `Converge A ${Date.now().toString(36).slice(-5)}`;
    await editName(desktop, nameA);
    await snap(desktop, 's5-edited-on-desktop');
    await expectNameConverges(phone, nameA);
    await snap(phone, 's5-converged-on-phone');

    // …and vice-versa: edit on the phone → converges on the desktop.
    const nameB = `Converge B ${Date.now().toString(36).slice(-5)}`;
    await editName(phone, nameB);
    await expectNameConverges(desktop, nameB);

    // Exactly one SharedProfile object per member — no SharedProfile-{aid} fork.
    const res = await fetch(`${s1.phone!.url}/api/v1/profiles`);
    expect(res.ok, `GET /api/v1/profiles failed: ${res.status}`).toBeTruthy();
    const profiles = (await res.json()) as { SharedProfile?: unknown[] };
    expect(Array.isArray(profiles.SharedProfile)).toBeTruthy();
    expect(profiles.SharedProfile).toHaveLength(1);
  });

  // 6. code-mismatch defence --------------------------------------------------
  test('6) tampered s= param: the displayer cannot authenticate the hello and the session fails', async ({
    browser,
    snap,
  }) => {
    test.setTimeout(180_000);
    const desktop = await backends.start(backendName('i475-s6-desktop'));
    const phone = await backends.start(backendName('i475-s6-phone'));
    // Phone holds so the untampered outcome would have been phone-to-desktop.
    await setFakeIdentity(phone, 'EPhoneHolder475s6000000000000000000000000000');

    const desk = await newDevice(browser, desktop, 'electron');
    await desk.page.goto('/');
    const { sessionId, qrPayload } = await openDesktopQr(desk.page);

    const tampered = tamperSecret(qrPayload);
    expect(tampered).not.toBe(qrPayload);

    const phoneDev = await newDevice(browser, phone, 'capacitor');
    await phoneDev.page.goto('/');
    await pasteOnPhone(phoneDev.page, tampered);

    // POSITIVE signal first, so this test cannot pass by nothing happening: the
    // tampered `s=` gives the scanner a different K, the displayer's
    // open(K, hello) fails its AEAD tag, and driveDisplayer
    // (backend/internal/pairing/driver.go) marks the session FAILED with
    // "hello did not authenticate". Waiting for that state proves the tampered
    // hello really was delivered and really was rejected — a fixed sleep plus
    // "the screen didn't change" would look identical if the paste had simply
    // never been submitted.
    await expect
      .poll(async () => (await getSessionStatus(desktop, sessionId)).state, {
        timeout: 90_000,
        intervals: [1_000],
      })
      .toBe('failed');
    const failed = await getSessionStatus(desktop, sessionId);
    expect(failed.error).toMatch(/did not authenticate/i);
    // No SAS code was ever derived on either side (K never agreed).
    expect(failed.code ?? '').toBe('');

    // NOTE: the issue text says "the displayer never leaves waiting for scan",
    // but the implementation is stricter — LinkDeviceQrScreen.handleTerminal()
    // routes state 'failed' to the "Pairing failed" message. Assert what the
    // code does; failing loudly is the better behaviour here.
    await expect(desk.page.getByRole('heading', { name: 'Pairing failed' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(desk.page.getByTestId('pairing-code')).toHaveCount(0);
    // The scanner never reached approve/waiting: its own session is still
    // blocked on an ack that can never come, so no code is on screen.
    await expect(phoneDev.page.getByTestId('sas-code')).toHaveCount(0);
    await snap(desk.page, 's6-desktop-pairing-failed');
    await snap(phoneDev.page, 's6-phone-scan-rejected');

    // No identity moved.
    expect((await getIdentity(desktop)).configured).toBeFalsy();

    await backends.stop(desktop.name);
    await backends.stop(phone.name);
  });
});
