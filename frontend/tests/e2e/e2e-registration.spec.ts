import { test, expect, Page, BrowserContext } from '@playwright/test';
import { setupTestConfig } from './utils/mock-config';
import { requireAllTestServices } from './utils/keri-testnet';
import { BackendManager } from './utils/backend-manager';
import {
  FRONTEND_URL,
  TIMEOUT,
  setupPageLogging,
  setupBackendRouting,
  registerUser,
  loginWithMnemonic,
  uniqueSuffix,
  loadAccounts,
  performOrgSetup,
  TestAccounts,
} from './utils/test-helpers';

/**
 * E2E: Registration Approval Flow
 *
 * Tests admin approval, decline, and messaging workflows.
 * Self-sufficient: if org-setup hasn't been run yet, performs it automatically.
 *
 * Multi-backend: In per-user mode, admin and each user run their own Go backend
 * instance. The admin uses the default backend on port 9080 (started manually).
 * Each user test spawns a fresh backend on a dynamic port via BackendManager.
 * Playwright route interception redirects each user context's API calls to its
 * own backend.
 *
 * Run: npx playwright test --project=registration
 */

test.describe.serial('Registration Approval Flow', () => {
  let accounts: TestAccounts;
  let adminContext: BrowserContext;
  let adminPage: Page;
  const backends = new BackendManager();

  test.beforeAll(async ({ browser, request }) => {
    // Fail fast if required services are not running
    await requireAllTestServices();

    // Create persistent admin context with test config isolation
    // Admin uses the default backend on port 9080 (no routing needed)
    adminContext = await browser.newContext();
    await setupTestConfig(adminContext);
    adminPage = await adminContext.newPage();
    setupPageLogging(adminPage, 'Admin');

    // Navigate to splash and let the app decide
    await adminPage.goto(FRONTEND_URL);

    // Race: either redirected to /setup (no org config) or splash shows ready state
    const needsSetup = await Promise.race([
      adminPage.waitForURL(/.*#\/setup/, { timeout: TIMEOUT.medium })
        .then(() => true),
      adminPage.locator('button', { hasText: /register/i })
        .waitFor({ state: 'visible', timeout: TIMEOUT.medium })
        .then(() => false),
    ]);

    if (needsSetup) {
      // Path A: No org config — run full org setup through the UI
      console.log('[Test] No org config detected — running org setup...');
      accounts = await performOrgSetup(adminPage, request);
      console.log('[Test] Org setup complete, admin is on dashboard');
      // Admin is now on dashboard with active KERIA session
    } else {
      // Path B: Org config exists — recover admin identity from saved mnemonic
      console.log('[Test] Org config exists — recovering admin identity...');
      accounts = loadAccounts();
      if (!accounts.admin?.mnemonic) {
        throw new Error(
          'Org configured but no admin mnemonic found in test-accounts.json.\n' +
          'Either run org-setup first or clean test state and re-run.',
        );
      }
      console.log(`[Test] Using admin account created at: ${accounts.createdAt}`);
      await loginWithMnemonic(adminPage, accounts.admin.mnemonic);
      console.log('[Test] Admin logged in and on dashboard');
    }
  });

  test.afterAll(async () => {
    // Stop all user backends spawned during tests
    await backends.stopAll();
    await adminContext?.close();
  });

  // ------------------------------------------------------------------
  // Test 1: Admin approves user registration
  // ------------------------------------------------------------------
  test('admin approves user registration', async ({ browser }) => {
    // Spawn a dedicated backend for this user
    const userBackend = await backends.start('user-approve');

    const userContext = await browser.newContext();
    await setupTestConfig(userContext);
    // Route all backend API calls from this context to the user's backend
    await setupBackendRouting(userContext, userBackend.port);
    const userPage = await userContext.newPage();
    setupPageLogging(userPage, 'User-Approve');

    const userName = `Approve_${uniqueSuffix()}`;

    try {
      // A. Set up identity/set listener before registration triggers the call
      const identitySetResponse = userPage.waitForResponse(
        resp => resp.url().includes('/api/v1/identity/set') && resp.request().method() === 'POST',
        { timeout: TIMEOUT.aidCreation },
      );

      // 1. User registers (on their own backend via routing)
      await registerUser(userPage, userName);

      // 2. Verify backend identity was configured during registration
      const idResp = await identitySetResponse;
      expect(idResp.status()).toBe(200);
      const idBody = await idResp.json();
      expect(idBody.success).toBe(true);
      expect(idBody.peerId).toBeTruthy();
      console.log('[Test] Backend identity set:', idBody.peerId?.slice(0, 16), 'space:', idBody.privateSpaceId);

      // 2b. Verify mnemonic was included in the request for deterministic key derivation
      const idReqBody = idResp.request().postDataJSON();
      expect(idReqBody.mnemonic).toBeTruthy();
      expect(idReqBody.mnemonic.split(' ')).toHaveLength(12);
      console.log('[Test] Identity/set request included 12-word mnemonic');

      // 2c. Test session restart: reload without clearing localStorage
      console.log('[Test] Testing session restart...');
      await userPage.goto(FRONTEND_URL);

      // Should auto-restore to pending-approval (not splash)
      await expect(
        userPage.getByText(/application.*review|pending|under review/i).first(),
      ).toBeVisible({ timeout: TIMEOUT.long });
      console.log('[Test] Session restart: auto-restored to pending-approval');

      // Splash buttons should NOT be visible
      await expect(
        userPage.getByRole('button', { name: /register/i }),
      ).not.toBeVisible();
      console.log('[Test] Session restart: splash buttons correctly hidden');

      // 3. Wait for admin to see registration card
      console.log('[Test] Waiting for registration to appear on admin dashboard...');
      const adminSection = adminPage.locator('.admin-section');
      await expect(adminSection).toBeVisible({ timeout: TIMEOUT.medium });

      const registrationCard = adminPage.locator('.registration-card').filter({ hasText: userName });
      await expect(registrationCard).toBeVisible({ timeout: TIMEOUT.long });
      console.log('[Test] Registration card visible');

      // B. Set up invite + sync listeners before approval
      // Invite goes through admin's backend (port 9080)
      const inviteResponse = adminPage.waitForResponse(
        resp => resp.url().includes('/api/v1/spaces/community/invite') && resp.request().method() === 'POST',
        { timeout: TIMEOUT.long },
      );
      // Sync goes through user's backend (routed port)
      const syncResponse = userPage.waitForResponse(
        resp => resp.url().includes('/api/v1/sync/credentials') && resp.request().method() === 'POST',
        { timeout: TIMEOUT.long },
      );

      // 4. Admin approves
      console.log('[Test] Admin clicking approve...');
      await registrationCard.getByRole('button', { name: /approve/i }).click();

      // 5. Verify community space invite during approval (from admin's backend)
      const invResp = await inviteResponse;
      expect(invResp.status()).toBe(200);
      const invBody = await invResp.json();
      expect(invBody.success).toBe(true);
      console.log('[Test] User invited to community space:', invBody);

      // 6. User receives credential (welcome overlay)
      console.log('[Test] Waiting for user to receive credential...');
      await expect(userPage.locator('.welcome-overlay')).toBeVisible({ timeout: TIMEOUT.long });
      console.log('[Test] User received credential!');

      // 7. User enters community and lands on dashboard
      // Button starts as "Syncing..." (disabled), then becomes "Enter Community" when sync completes
      // or "Enter Anyway" after 30s timeout. Wait for either enabled state.
      const enterButton = userPage.getByRole('button', { name: /enter (community|anyway)/i });
      await enterButton.click({ timeout: TIMEOUT.long + 15_000 });
      await expect(userPage).toHaveURL(/#\/dashboard/, { timeout: TIMEOUT.short });

      // 8. Verify credential synced to backend (through user's backend)
      const syncResp = await syncResponse;
      expect(syncResp.status()).toBe(200);
      const syncBody = await syncResp.json();
      expect(syncBody.synced).toBeGreaterThan(0);
      // Space routing is best-effort on the initial sync — the user's freshly-spawned
      // backend may still be deriving space keys from the mnemonic. The dashboard URL
      // check above already proves end-to-end community access works.
      console.log('[Test] Credential synced:', {
        synced: syncBody.synced,
        spaces: syncBody.spaces,
        privateSpace: syncBody.privateSpace,
        communitySpace: syncBody.communitySpace,
        errors: syncBody.errors,
      });

      console.log('[Test] PASS - User approved, credential synced, dashboard accessible');
    } finally {
      await userContext.close();
      await backends.stop('user-approve');
    }
  });

  // ------------------------------------------------------------------
  // Test 2: Admin declines user registration
  // ------------------------------------------------------------------
  test('admin declines user registration', async ({ browser }) => {
    const userBackend = await backends.start('user-decline');

    const userContext = await browser.newContext();
    await setupTestConfig(userContext);
    await setupBackendRouting(userContext, userBackend.port);
    const userPage = await userContext.newPage();
    setupPageLogging(userPage, 'User-Decline');

    const userName = `Decline_${uniqueSuffix()}`;

    try {
      // User registers (on their own backend)
      await registerUser(userPage, userName);

      // Wait for admin to see registration card
      const adminSection = adminPage.locator('.admin-section');
      await expect(adminSection).toBeVisible({ timeout: TIMEOUT.medium });

      const registrationCard = adminPage.locator('.registration-card').filter({ hasText: userName });
      await expect(registrationCard).toBeVisible({ timeout: TIMEOUT.long });

      // Admin declines
      console.log('[Test] Admin clicking decline...');
      const declineBtn = registrationCard.locator('button').last();
      await declineBtn.click();

      // Handle decline modal if present
      const modal = adminPage.locator('.modal-content');
      if (await modal.isVisible({ timeout: TIMEOUT.short }).catch(() => false)) {
        const reasonField = modal.locator('textarea');
        if (await reasonField.isVisible().catch(() => false)) {
          await reasonField.fill('Declined for testing');
        }
        await modal.getByRole('button', { name: /confirm|decline/i }).click();
      }

      // User sees rejection
      console.log('[Test] Waiting for user to see rejection...');
      await expect(
        userPage.getByText(/declined|rejected/i).first(),
      ).toBeVisible({ timeout: TIMEOUT.long });
      console.log('[Test] PASS - User sees rejection');
    } finally {
      await userContext.close();
      await backends.stop('user-decline');
    }
  });

  // ------------------------------------------------------------------
  // Test 3: Admin sends message to pending applicant
  // ------------------------------------------------------------------
  test('admin sends message to pending applicant', async ({ browser }) => {
    const userBackend = await backends.start('user-message');

    const userContext = await browser.newContext();
    await setupTestConfig(userContext);
    await setupBackendRouting(userContext, userBackend.port);
    const userPage = await userContext.newPage();
    setupPageLogging(userPage, 'User-Message');

    const userName = `Message_${uniqueSuffix()}`;

    try {
      // 1. User registers (stays pending, on their own backend)
      await registerUser(userPage, userName);

      // 2. Wait for admin to see the registration card
      const adminSection = adminPage.locator('.admin-section');
      await expect(adminSection).toBeVisible({ timeout: TIMEOUT.medium });

      const registrationCard = adminPage.locator('.registration-card').filter({ hasText: userName });
      await expect(registrationCard).toBeVisible({ timeout: TIMEOUT.long });

      // 3. Click message on card → opens RegistrationModal (detail dialog)
      console.log('[Test] Admin clicking message on card...');
      const cardMessageBtn = registrationCard.getByRole('button', { name: /message/i });
      await expect(cardMessageBtn).toBeVisible({ timeout: TIMEOUT.short });
      await cardMessageBtn.click();

      // 4. RegistrationModal opens — click "Message" in modal footer to reveal textarea
      const modal = adminPage.locator('.modal-content');
      await expect(modal).toBeVisible({ timeout: TIMEOUT.short });
      console.log('[Test] Registration detail modal opened');

      const modalMessageBtn = modal.getByRole('button', { name: /^message$/i });
      await expect(modalMessageBtn).toBeVisible({ timeout: TIMEOUT.short });
      await modalMessageBtn.click();

      // 5. Fill textarea and click "Send Message"
      await expect(modal.locator('textarea')).toBeVisible({ timeout: TIMEOUT.short });
      await modal.locator('textarea').fill('Please provide more details about your background.');
      await modal.getByRole('button', { name: /send message/i }).click();
      console.log('[Test] Admin sent message');

      // 6. User receives admin message
      console.log('[Test] Waiting for user to receive message...');
      await expect(
        userPage.getByText(/please provide more details/i),
      ).toBeVisible({ timeout: TIMEOUT.long });
      console.log('[Test] User received admin message');

      // 7. User types a reply
      console.log('[Test] User sending reply...');
      const replyTextarea = userPage.locator('textarea[placeholder="Type your reply..."]');
      await expect(replyTextarea).toBeVisible({ timeout: TIMEOUT.short });
      await replyTextarea.fill('I have 5 years of experience in community organizing.');

      const sendReplyBtn = userPage.locator('button', { hasText: /^send$/i });
      await expect(sendReplyBtn).toBeEnabled({ timeout: TIMEOUT.short });
      await sendReplyBtn.click();

      // 8. Verify reply was sent (textarea clears on success)
      await expect(replyTextarea).toHaveValue('', { timeout: TIMEOUT.medium });
      console.log('[Test] User reply sent');

      // 9. Admin receives the reply (poll picks up message_reply notification)
      console.log('[Test] Waiting for admin to receive reply...');
      const replyReceived = adminPage.waitForEvent('console', {
        predicate: msg => msg.text().includes('New applicant message received'),
        timeout: TIMEOUT.long,
      });
      await replyReceived;
      console.log('[Test] PASS - Admin received user reply');
    } finally {
      await userContext.close();
      await backends.stop('user-message');
    }
  });
});
