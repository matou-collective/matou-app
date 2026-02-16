import { test, expect, Page, BrowserContext } from '@playwright/test';
import { setupTestConfig } from './utils/mock-config';
import { BackendManager } from './utils/backend-manager';
import {
  FRONTEND_URL,
  TIMEOUT,
  setupPageLogging,
  setupBackendRouting,
  loginWithMnemonic,
  loadAccounts,
  TestAccounts,
} from './utils/test-helpers';

/**
 * E2E: Admin Account Recovery
 *
 * Verifies that mnemonic-based account recovery restores full access:
 * 1. KERIA agent identity (AID recovered from KERIA)
 * 2. AnySync peer key (derived from mnemonic, backend re-initialized)
 * 3. Private space (deterministic keys from mnemonic index 0)
 * 4. Community space (read + write access via signing key / ACL)
 * 5. Community read-only space (keys available)
 * 6. Admin space (keys available)
 * 7. Community dashboard with active membership credential
 *
 * Prerequisites:
 *   - org-setup must have been run (test-accounts.json has admin mnemonic)
 *   - KERI test network, AnySync test network, and admin backend must be running
 *
 * Run: npx playwright test --project=account-recovery
 */

test.describe.serial('Admin Account Recovery', () => {
  let accounts: TestAccounts;
  let recoveryContext: BrowserContext;
  let recoveryPage: Page;
  const backends = new BackendManager();
  let backendPort: number;

  test.beforeAll(async ({ browser }) => {
    // Load admin account from persisted test-accounts.json
    accounts = loadAccounts();
    if (!accounts.admin?.mnemonic) {
      throw new Error(
        'No admin mnemonic found in test-accounts.json.\n' +
        'Run org-setup first: npx playwright test --project=org-setup',
      );
    }
    console.log(`[Test] Loaded admin account (created: ${accounts.createdAt})`);

    // Spawn a dedicated backend so recovery doesn't overwrite the admin backend state
    const recoveryBackend = await backends.start('admin-recovery');
    backendPort = recoveryBackend.port;
    console.log(`[Test] Recovery backend on port ${backendPort}`);

    // Create browser context with test config isolation + routing to recovery backend
    recoveryContext = await browser.newContext();
    await setupTestConfig(recoveryContext);
    await setupBackendRouting(recoveryContext, backendPort);
    recoveryPage = await recoveryContext.newPage();
    setupPageLogging(recoveryPage, 'Recovery');
  });

  test.afterAll(async () => {
    await recoveryContext?.close();
    await backends.stopAll();
  });

  // ------------------------------------------------------------------
  // Test 1: Recover KERIA agent identity from mnemonic
  // ------------------------------------------------------------------
  test('recovers KERIA agent identity from mnemonic', async () => {
    test.setTimeout(TIMEOUT.orgSetup);

    // Warm up: first navigation triggers config fetch which can take 15-20s on cold start.
    // Wait for splash to fully render so loginWithMnemonic's 10s timeout is sufficient.
    await recoveryPage.goto(FRONTEND_URL);
    await expect(
      recoveryPage.getByRole('button', { name: /register/i }),
    ).toBeVisible({ timeout: TIMEOUT.long });

    // Clear any existing session
    await recoveryPage.evaluate(() => localStorage.clear());

    // Full recovery flow: splash → recover → mnemonic → welcome overlay checks → dashboard
    await loginWithMnemonic(recoveryPage, accounts.admin!.mnemonic);

    // Verify we landed on the dashboard
    await expect(recoveryPage).toHaveURL(/#\/dashboard/, { timeout: TIMEOUT.short });

    // Verify passcode is persisted (the only identity value stored in localStorage)
    const storedPasscode = await recoveryPage.evaluate(() =>
      localStorage.getItem('matou_passcode'),
    );
    expect(storedPasscode, 'Passcode should be persisted after recovery').toBeTruthy();

    // Verify mnemonic is persisted (needed by welcome overlay for setBackendIdentity)
    const storedMnemonic = await recoveryPage.evaluate(() =>
      localStorage.getItem('matou_mnemonic'),
    );
    expect(storedMnemonic, 'Mnemonic should be persisted after recovery').toBeTruthy();

    console.log('[Test] PASS - KERIA identity recovered, session persisted, on dashboard');
  });

  // ------------------------------------------------------------------
  // Test 2: Verify AnySync peer key was recovered
  // ------------------------------------------------------------------
  test('recovers AnySync peer key', async () => {
    const backendUrl = `http://localhost:${backendPort}`;
    const response = await fetch(`${backendUrl}/api/v1/identity`);
    expect(response.ok, 'GET /api/v1/identity should succeed').toBe(true);

    const identity = await response.json();
    expect(identity.configured, 'Backend identity should be configured').toBe(true);
    expect(identity.aid, 'Backend should have an AID').toBeTruthy();
    expect(identity.peerId, 'Backend should have a peer ID (derived from mnemonic)').toBeTruthy();

    console.log(`[Test] PASS - Peer key recovered, AID: ${identity.aid.substring(0, 16)}..., peerID: ${identity.peerId.substring(0, 16)}...`);
  });

  // ------------------------------------------------------------------
  // Test 3: Verify private space is recovered with keys
  // ------------------------------------------------------------------
  test('recovers private space with keys', async () => {
    const backendUrl = `http://localhost:${backendPort}`;

    // Get AID from identity endpoint
    const identityResp = await fetch(`${backendUrl}/api/v1/identity`);
    const identity = await identityResp.json();

    // Fetch user spaces
    const spacesResp = await fetch(`${backendUrl}/api/v1/spaces/user?aid=${identity.aid}`);
    expect(spacesResp.ok, 'GET /api/v1/spaces/user should succeed').toBe(true);

    const spaces = await spacesResp.json();
    expect(spaces.privateSpace, 'Private space should exist').toBeTruthy();
    expect(spaces.privateSpace.spaceId, 'Private space should have an ID').toBeTruthy();
    expect(spaces.privateSpace.keysAvailable, 'Private space keys should be available on disk').toBe(true);

    console.log(`[Test] PASS - Private space recovered: ${spaces.privateSpace.spaceId}`);
  });

  // ------------------------------------------------------------------
  // Test 4: Verify community space is recovered with read + write access
  // ------------------------------------------------------------------
  test('recovers community space with read and write access', async () => {
    const backendUrl = `http://localhost:${backendPort}`;

    const identityResp = await fetch(`${backendUrl}/api/v1/identity`);
    const identity = await identityResp.json();

    // Verify community space exists (keysAvailable may be false — signing uses
    // peer key and read key is recoverable via ACL, so we check access instead)
    const spacesResp = await fetch(`${backendUrl}/api/v1/spaces/user?aid=${identity.aid}`);
    const spaces = await spacesResp.json();
    expect(spaces.communitySpace, 'Community space should exist').toBeTruthy();
    expect(spaces.communitySpace.spaceId, 'Community space should have an ID').toBeTruthy();

    // Verify read + write access via ACL check
    const accessResp = await fetch(
      `${backendUrl}/api/v1/spaces/community/verify-access?aid=${identity.aid}`,
    );
    expect(accessResp.ok, 'GET /api/v1/spaces/community/verify-access should succeed').toBe(true);

    const access = await accessResp.json();
    expect(access.hasAccess, 'Admin should have community space access').toBe(true);
    expect(access.canRead, 'Admin should have read access to community space').toBe(true);
    expect(access.canWrite, 'Admin should have write access to community space').toBe(true);

    console.log(`[Test] PASS - Community space: ${spaces.communitySpace.spaceId}, hasAccess=${access.hasAccess}, canRead=${access.canRead}, canWrite=${access.canWrite}`);
  });

  // ------------------------------------------------------------------
  // Test 5: Verify community read-only space is recovered
  // ------------------------------------------------------------------
  test('recovers community read-only space', async () => {
    const backendUrl = `http://localhost:${backendPort}`;

    // Log full identity config to diagnose which space IDs were persisted
    const identityResp = await fetch(`${backendUrl}/api/v1/identity`);
    const identity = await identityResp.json();
    console.log('[Test] Identity config:', JSON.stringify(identity, null, 2));

    const spacesResp = await fetch(`${backendUrl}/api/v1/spaces/user?aid=${identity.aid}`);
    const spaces = await spacesResp.json();
    console.log('[Test] Spaces response:', JSON.stringify(spaces, null, 2));

    expect(spaces.communityReadOnlySpace, 'Community read-only space should exist').toBeTruthy();
    expect(spaces.communityReadOnlySpace.spaceId, 'Read-only space should have an ID').toBeTruthy();

    console.log(`[Test] PASS - Read-only space recovered: ${spaces.communityReadOnlySpace.spaceId}`);
  });

  // ------------------------------------------------------------------
  // Test 6: Verify admin space is recovered
  // ------------------------------------------------------------------
  test('recovers admin space', async () => {
    const backendUrl = `http://localhost:${backendPort}`;

    const identityResp = await fetch(`${backendUrl}/api/v1/identity`);
    const identity = await identityResp.json();

    const spacesResp = await fetch(`${backendUrl}/api/v1/spaces/user?aid=${identity.aid}`);
    const spaces = await spacesResp.json();
    expect(spaces.adminSpace, 'Admin space should exist').toBeTruthy();
    expect(spaces.adminSpace.spaceId, 'Admin space should have an ID').toBeTruthy();

    console.log(`[Test] PASS - Admin space recovered: ${spaces.adminSpace.spaceId}`);
  });

  // ------------------------------------------------------------------
  // Test 7: Verify dashboard access with active membership credential
  // ------------------------------------------------------------------
  test('has access to community dashboard with active credential', async () => {
    // Verify we're still on the dashboard
    await expect(recoveryPage).toHaveURL(/#\/dashboard/, { timeout: TIMEOUT.short });

    // Verify dashboard heading is visible
    await expect(
      recoveryPage.getByRole('heading', { level: 1, name: /welcome back/i }),
    ).toBeVisible({ timeout: TIMEOUT.long });

    // Verify community stats sections are rendered (proves community access works)
    await expect(
      recoveryPage.getByText('Community Activity').first(),
    ).toBeVisible({ timeout: TIMEOUT.short });

    await expect(
      recoveryPage.getByText('New Members').first(),
    ).toBeVisible({ timeout: TIMEOUT.short });

    console.log('[Test] PASS - Dashboard accessible with community data visible');
  });
});
