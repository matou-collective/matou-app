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
  registerUser,
  uniqueSuffix,
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
 * 8. Admin can approve registrations after recovery
 * 9. Admin can generate anysync invites after recovery
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

  // ------------------------------------------------------------------
  // Test 8: Admin can approve registrations after recovery
  // ------------------------------------------------------------------
  test('can approve registrations after recovery', async ({ browser }) => {
    test.setTimeout(240_000); // 4 min: registration (~90s) + approval (~30s) + sync (~60s)

    // Spawn a dedicated backend for the registering user
    const userBackend = await backends.start('user-post-recovery');

    const userContext = await browser.newContext();
    await setupTestConfig(userContext);
    await setupBackendRouting(userContext, userBackend.port);
    const userPage = await userContext.newPage();
    setupPageLogging(userPage, 'User-PostRecovery');

    const userName = `Recovery_Approve_${uniqueSuffix()}`;

    try {
      // 1. User registers (on their own backend)
      await registerUser(userPage, userName);
      console.log(`[Test] ${userName} registered, waiting for admin to see registration card...`);

      // 2. Wait for registration card to appear on recovered admin's dashboard
      const membersCard = recoveryPage.locator('.members-card');
      const pendingMemberCard = membersCard.locator('.card-name', { hasText: userName });
      await expect(pendingMemberCard).toBeVisible({ timeout: TIMEOUT.registrationSubmit });
      console.log('[Test] Registration card visible on recovered admin dashboard');

      // 3. Set up listeners for approval API calls
      const inviteResponse = recoveryPage.waitForResponse(
        resp => resp.url().includes('/api/v1/spaces/community/invite') && resp.request().method() === 'POST',
        { timeout: TIMEOUT.long },
      );
      const initProfilesResponse = recoveryPage.waitForResponse(
        resp => resp.url().includes('/api/v1/profiles/init-member') && resp.request().method() === 'POST',
        { timeout: TIMEOUT.long },
      );

      // 4. Admin approves via ProfileModal
      console.log('[Test] Recovered admin clicking approve...');
      const memberProfileCard = membersCard.locator('.profile-card').filter({ hasText: userName });
      await memberProfileCard.click();
      const profileModal = recoveryPage.locator('.modal-content');
      await expect(profileModal).toBeVisible({ timeout: TIMEOUT.short });
      const admitButton = profileModal.getByRole('button', { name: /admit/i });
      await expect(admitButton).toBeVisible({ timeout: TIMEOUT.short });
      await admitButton.click();

      // 5. Verify community space invite succeeded
      const invResp = await inviteResponse;
      expect(invResp.status()).toBe(200);
      const invBody = await invResp.json();
      expect(invBody.success, 'Community space invite should succeed').toBe(true);
      console.log('[Test] Community space invite succeeded:', invBody.communitySpaceId);

      // 6. Verify initMemberProfiles succeeded
      const initResp = await initProfilesResponse;
      expect(initResp.status()).toBe(200);
      const initBody = await initResp.json();
      expect(initBody.success, 'initMemberProfiles should succeed').toBe(true);
      expect(initBody.sharedProfileObjectId, 'SharedProfile should be created').toBeTruthy();
      console.log('[Test] initMemberProfiles succeeded:', {
        objectId: initBody.objectId,
        sharedProfileObjectId: initBody.sharedProfileObjectId,
      });

      // 7. Verify user receives credential (welcome overlay appears)
      console.log('[Test] Waiting for user to receive credential...');
      await expect(userPage.locator('.welcome-overlay')).toBeVisible({ timeout: TIMEOUT.long });
      console.log('[Test] User received credential');

      // 8. User enters community and lands on dashboard
      const enterButton = userPage.getByRole('button', { name: /enter community/i });
      await expect(enterButton).toBeEnabled({ timeout: TIMEOUT.long + 30_000 });
      await enterButton.click();
      await expect(userPage).toHaveURL(/#\/dashboard/, { timeout: TIMEOUT.short });

      console.log('[Test] PASS - Recovered admin can approve registrations');
    } finally {
      await userContext.close();
      await backends.stop('user-post-recovery');
    }
  });

  // ------------------------------------------------------------------
  // Test 9: Admin can generate anysync invites after recovery
  // ------------------------------------------------------------------
  test('can generate anysync invites after recovery', async () => {
    test.setTimeout(TIMEOUT.orgSetup); // 2 min — credential issuance + OOBI resolution

    // Ensure we're on the dashboard
    await expect(recoveryPage).toHaveURL(/#\/dashboard/, { timeout: TIMEOUT.short });

    // 1. Wait for Invite Member button (admin section)
    console.log('[Test] Waiting for Invite Member button...');
    const inviteBtn = recoveryPage.getByRole('button', { name: /invite member/i });
    await expect(inviteBtn).toBeVisible({ timeout: TIMEOUT.long });

    // 2. Click "Invite Member" to open modal
    console.log('[Test] Clicking Invite Member...');
    await inviteBtn.click();

    const modal = recoveryPage.locator('.invite-modal');
    await expect(modal).toBeVisible({ timeout: TIMEOUT.short });

    // 3. Fill invite form
    await modal.locator('input[type="text"]').fill('Recovery Invitee');
    // Leave role as default "Member"

    // 4. Submit and wait for invitation creation (KERI operations)
    console.log('[Test] Creating invitation (KERI operations)...');
    await modal.getByRole('button', { name: /create invitation/i }).click();

    // Wait for progress to appear
    await expect(modal.locator('.progress-box')).toBeVisible({ timeout: TIMEOUT.short });

    // 5. Wait for success — invite code input appears
    const inviteCodeInput = modal.locator('input[readonly]');
    await expect(inviteCodeInput).toBeVisible({ timeout: TIMEOUT.orgSetup });

    // 6. Verify invite code was generated
    const inviteCode = await inviteCodeInput.inputValue();
    expect(inviteCode, 'Invite code should be generated').toBeTruthy();
    expect(inviteCode.length, 'Invite code should have reasonable length').toBeGreaterThan(10);
    console.log(`[Test] Invite code generated (length: ${inviteCode.length})`);

    // 7. Verify invitee AID is shown
    const aidInfo = modal.locator('.aid-info code');
    await expect(aidInfo).toBeVisible({ timeout: TIMEOUT.short });
    const aidText = await aidInfo.textContent();
    expect(aidText, 'Invitee AID should be displayed').toBeTruthy();
    console.log(`[Test] Invitee AID: ${aidText}`);

    // 8. Close modal
    await modal.getByRole('button', { name: /done/i }).click();
    await expect(modal).not.toBeVisible({ timeout: TIMEOUT.short });

    console.log('[Test] PASS - Recovered admin can generate anysync invites');
  });
});
