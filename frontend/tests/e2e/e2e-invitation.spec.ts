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
  performOrgSetup,
  TestAccounts,
} from './utils/test-helpers';

/**
 * E2E: Pre-Created Identity Invitation Flow
 *
 * Tests the full invitation lifecycle:
 * 1. Admin creates a pre-configured invitation from the dashboard
 * 2. Invitee enters invite code on splash, goes through welcome + profile + processing
 * 3. Invitee reaches the dashboard
 *
 * Multi-backend: Admin uses the default backend on port 9080. The invitee gets
 * a dedicated backend instance so their identity/set call doesn't overwrite
 * the admin's identity. Recovery test (test 4) gets its own backend too.
 *
 * Self-sufficient: if org-setup hasn't been run yet, performs it automatically.
 *
 * Run: npx playwright test --project=invitation
 */

test.describe.serial('Pre-Created Identity Invitation', () => {
  let accounts: TestAccounts;
  let adminContext: BrowserContext;
  let adminPage: Page;
  let inviteCode: string;
  let claimedMnemonic: string[];
  const backends = new BackendManager();

  test.beforeAll(async ({ browser, request }) => {
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
    await backends.stopAll();
    await adminContext?.close();
  });

  // ------------------------------------------------------------------
  // Test 1: Admin creates invitation from dashboard
  // ------------------------------------------------------------------
  test('admin creates invitation', async () => {
    test.setTimeout(TIMEOUT.orgSetup); // 2 min — credential issuance + OOBI resolution

    // After fresh org setup the admin lands on pending-approval screen.
    // Credential polling finds the self-issued credential and shows a welcome overlay.
    // After mnemonic login (existing org), admin goes directly to dashboard.
    const onDashboard = adminPage.url().includes('#/dashboard');
    if (!onDashboard) {
      const enterBtn = adminPage.getByRole('button', { name: /enter community/i });
      await expect(enterBtn).toBeVisible({ timeout: TIMEOUT.orgSetup });
      await enterBtn.click();
    }
    await expect(adminPage).toHaveURL(/#\/dashboard/, { timeout: TIMEOUT.short });

    // Wait for admin section to render (admin check runs in onMounted)
    console.log('[Test] Waiting for Invite Member button...');
    const inviteBtn = adminPage.getByRole('button', { name: /invite member/i });
    await expect(inviteBtn).toBeVisible({ timeout: TIMEOUT.long });

    // Click "Invite Member" button
    console.log('[Test] Clicking Invite Member...');
    await inviteBtn.click();

    // Fill invite form in modal
    const modal = adminPage.locator('.invite-modal');
    await expect(modal).toBeVisible({ timeout: TIMEOUT.short });

    await modal.locator('input[type="text"]').fill('Test Invitee');
    // Leave role as default "Member"

    // Fill in optional email field
    await modal.locator('input[type="email"]').fill('ben@matou.nz');

    // Submit and wait for invitation creation
    console.log('[Test] Creating invitation (this involves KERI operations)...');
    await modal.getByRole('button', { name: /create invitation/i }).click();

    // Wait for progress to appear, then for invite code to appear
    await expect(modal.locator('.progress-box')).toBeVisible({ timeout: TIMEOUT.short });

    // Wait for success — invite code input appears
    const inviteCodeInput = modal.locator('input[readonly]');
    await expect(inviteCodeInput).toBeVisible({ timeout: TIMEOUT.orgSetup });

    // Extract invite code
    inviteCode = await inviteCodeInput.inputValue();
    console.log(`[Test] Invite code generated (length: ${inviteCode.length})`);
    expect(inviteCode).toBeTruthy();
    expect(inviteCode.length).toBeGreaterThan(10);

    // Verify invitee AID is shown
    const aidInfo = modal.locator('.aid-info code');
    await expect(aidInfo).toBeVisible({ timeout: TIMEOUT.short });
    const aidText = await aidInfo.textContent();
    expect(aidText).toBeTruthy();
    console.log(`[Test] Invitee AID: ${aidText}`);

    // Try to send invite email (may fail if SMTP not configured in test env)
    console.log('[Test] Attempting to send invite email to ben@matou.nz...');
    const emailBtn = modal.getByRole('button', { name: /email invite/i });
    await expect(emailBtn).toBeVisible({ timeout: TIMEOUT.short });
    await emailBtn.click();

    // Wait for either success or error (SMTP may not be available in test env)
    const emailResult = await Promise.race([
      modal.getByText(/invite emailed to ben@matou\.nz/i)
        .waitFor({ state: 'visible', timeout: TIMEOUT.short })
        .then(() => 'sent'),
      modal.getByText(/failed to send email/i)
        .waitFor({ state: 'visible', timeout: TIMEOUT.short })
        .then(() => 'failed'),
    ]);

    if (emailResult === 'sent') {
      console.log('[Test] Invite email sent successfully');
    } else {
      console.log('[Test] Email sending failed (SMTP not configured) - continuing with invite code');
    }

    // Close modal
    await modal.getByRole('button', { name: /done/i }).click();
    await expect(modal).not.toBeVisible({ timeout: TIMEOUT.short });
    console.log('[Test] PASS - Invitation created successfully');
  });

  // ------------------------------------------------------------------
  // Test 2: Invitee claims identity via invite code flow
  // ------------------------------------------------------------------
  test('invitee claims identity via invite code', async ({ browser }) => {
    test.setTimeout(TIMEOUT.orgSetup); // 2 min — AID key rotation + OOBI resolution

    expect(inviteCode, 'Invite code must exist from previous test').toBeTruthy();

    // Spawn a dedicated backend for the invitee
    const inviteeBackend = await backends.start('invitee-claim');

    // Create fresh browser context for the invitee (no existing session)
    const inviteeContext = await browser.newContext();
    await setupTestConfig(inviteeContext);
    await setupBackendRouting(inviteeContext, inviteeBackend.port);
    const inviteePage = await inviteeContext.newPage();
    setupPageLogging(inviteePage, 'Invitee');

    try {
      // Clear any existing session and navigate to splash
      await inviteePage.goto(FRONTEND_URL);
      await inviteePage.evaluate(() => localStorage.clear());
      await inviteePage.goto(FRONTEND_URL);
      await inviteePage.waitForLoadState('networkidle');

      // --- Splash Screen: Click "I have an invite code" ---
      console.log('[Test] On splash screen, clicking invite code button...');
      const inviteCodeBtn = inviteePage.locator('button', { hasText: /invite code/i });
      await expect(inviteCodeBtn).toBeVisible({ timeout: TIMEOUT.long });
      await inviteCodeBtn.click();

      // --- Invite Code Screen: Paste the raw passcode ---
      console.log('[Test] Pasting invite code...');
      const codeInput = inviteePage.locator('#inviteCode input');
      await expect(codeInput).toBeVisible({ timeout: TIMEOUT.short });
      await codeInput.fill(inviteCode);

      // Click Continue to validate against KERIA
      await inviteePage.getByRole('button', { name: /continue/i }).click();

      // --- Claim Welcome Screen ---
      console.log('[Test] Waiting for claim welcome screen...');
      await expect(
        inviteePage.getByRole('heading', { name: /welcome/i }),
      ).toBeVisible({ timeout: TIMEOUT.long });

      // Verify identity preview is shown
      const identityCard = inviteePage.locator('.identity-card');
      await expect(identityCard).toBeVisible({ timeout: TIMEOUT.short });
      console.log('[Test] Claim welcome screen loaded with identity preview');

      // Click "I agree, accept invitation"
      await inviteePage.getByRole('button', { name: /I agree, accept invitation/i }).click();

      // --- Profile Form Screen ---
      console.log('[Test] Filling in profile form...');
      await expect(
        inviteePage.getByRole('heading', { name: /claim your profile/i }),
      ).toBeVisible({ timeout: TIMEOUT.short });

      // Fill in display name
      await inviteePage.locator('#name input').fill('Test Invitee');

      // Agree to terms
      const termsCheckbox = inviteePage.locator('input[type="checkbox"]').last();
      await termsCheckbox.check();

      // Submit profile form
      await inviteePage.getByRole('button', { name: /continue/i }).click();

      // --- Claim Processing Screen ---
      console.log('[Test] Claim processing started...');

      // Wait for processing to complete — "Invitation Claimed!" in the success box
      await expect(
        inviteePage.getByRole('heading', { name: /invitation claimed/i }),
      ).toBeVisible({ timeout: TIMEOUT.orgSetup });
      console.log('[Test] Invitation claimed successfully');

      // Click "Continue" (now goes to profile-confirmation, not dashboard)
      await inviteePage.getByRole('button', { name: /continue/i }).click();

      // --- Profile Confirmation Screen: Save Your Recovery Phrase ---
      console.log('[Test] Waiting for recovery phrase screen...');
      await expect(
        inviteePage.getByRole('heading', { level: 1, name: /save your recovery phrase/i }),
      ).toBeVisible({ timeout: TIMEOUT.long });

      // Read 12 mnemonic words from the word cards
      const wordCards = inviteePage.locator('.word-card');
      await expect(wordCards.first()).toBeVisible({ timeout: TIMEOUT.short });
      const wordCount = await wordCards.count();
      expect(wordCount).toBe(12);

      const mnemonicWords: string[] = [];
      for (let i = 0; i < wordCount; i++) {
        const text = await wordCards.nth(i).locator('.font-mono').textContent();
        mnemonicWords.push(text!.trim());
      }
      claimedMnemonic = mnemonicWords;
      console.log(`[Test] Captured ${mnemonicWords.length} mnemonic words`);

      // Check the "I have written down..." checkbox
      const writtenCheckbox = inviteePage.locator('input[type="checkbox"]');
      await writtenCheckbox.check();

      // Click "Continue to Verification"
      await inviteePage.getByRole('button', { name: /continue to verification/i }).click();

      // --- Mnemonic Verification Screen ---
      console.log('[Test] Waiting for mnemonic verification screen...');
      await expect(
        inviteePage.getByRole('heading', { name: /verify your recovery phrase/i }),
      ).toBeVisible({ timeout: TIMEOUT.short });

      // Read which 3 word indices are requested and fill them in
      const wordInputs = inviteePage.locator('.word-input-group');
      const inputCount = await wordInputs.count();
      expect(inputCount).toBe(3);

      for (let i = 0; i < inputCount; i++) {
        const group = wordInputs.nth(i);
        const label = await group.locator('label').textContent();
        // Extract word number from label like "Word #3"
        const match = label!.match(/(\d+)/);
        const wordIndex = parseInt(match![1], 10) - 1; // 0-based
        const input = group.locator('input');
        await input.fill(mnemonicWords[wordIndex]);
      }

      // Click "Verify and Continue"
      await inviteePage.getByRole('button', { name: /verify and continue/i }).click();

      // --- Welcome Overlay Screen ---
      console.log('[Test] Waiting for welcome overlay...');
      await expect(
        inviteePage.getByRole('heading', { name: /welcome to matou/i }),
      ).toBeVisible({ timeout: TIMEOUT.long });
      console.log('[Test] Welcome overlay shown');

      // Click "Continue to Dashboard"
      await inviteePage.getByRole('button', { name: /continue to dashboard/i }).click();

      // --- Should navigate to dashboard ---
      console.log('[Test] Waiting for dashboard...');
      await expect(inviteePage).toHaveURL(/#\/dashboard/, { timeout: TIMEOUT.long });
      console.log('[Test] PASS - Invitee on dashboard after claiming identity');

      // --- Verify session persisted with passcode derived from the mnemonic ---
      // The invite code is base64url-encoded mnemonic entropy, NOT the raw passcode.
      // The stored passcode is derived from the mnemonic via PBKDF2.
      const storedPasscode = await inviteePage.evaluate(() => {
        return localStorage.getItem('matou_passcode');
      });
      expect(storedPasscode, 'Passcode should be persisted in localStorage').toBeTruthy();
      expect(storedPasscode, 'Stored passcode should differ from invite code (invite code encodes mnemonic, not passcode)').not.toBe(inviteCode);
    } finally {
      await inviteeContext.close();
      await backends.stop('invitee-claim');
    }
  });

  // ------------------------------------------------------------------
  // Test 3: Old claim link no longer works after claiming
  // ------------------------------------------------------------------
  test('claimed invite code is invalid after use', async ({ browser }) => {
    test.setTimeout(TIMEOUT.long);

    expect(inviteCode, 'Invite code must exist from previous test').toBeTruthy();

    // This test doesn't need its own backend — it just validates the invite code
    // against KERIA (no identity/set call happens since the code is rejected).
    const freshContext = await browser.newContext();
    await setupTestConfig(freshContext);
    const freshPage = await freshContext.newPage();
    setupPageLogging(freshPage, 'Reuse');

    try {
      await freshPage.goto(FRONTEND_URL);
      await freshPage.evaluate(() => localStorage.clear());
      await freshPage.goto(FRONTEND_URL);
      await freshPage.waitForLoadState('networkidle');

      // Click "I have an invite code"
      const inviteCodeBtn = freshPage.locator('button', { hasText: /invite code/i });
      await expect(inviteCodeBtn).toBeVisible({ timeout: TIMEOUT.long });
      await inviteCodeBtn.click();

      // Paste the already-used invite code
      const codeInput = freshPage.locator('#inviteCode input');
      await expect(codeInput).toBeVisible({ timeout: TIMEOUT.short });
      await codeInput.fill(inviteCode);
      await freshPage.getByRole('button', { name: /continue/i }).click();

      // Should show error — the AID keys were rotated during claim, so
      // validate() detects key state s > 0 and rejects the invite code.
      console.log('[Test] Waiting for invalid/already-used invite code error...');
      await expect(
        freshPage.getByText(/invalid|already.used|failed/i).first(),
      ).toBeVisible({ timeout: TIMEOUT.long });
      console.log('[Test] PASS - Old invite code correctly rejected');
    } finally {
      await freshContext.close();
    }
  });

  // ------------------------------------------------------------------
  // Test 4: Invitee recovers identity with mnemonic
  // ------------------------------------------------------------------
  test('invitee recovers identity with mnemonic', async ({ browser }) => {
    test.setTimeout(TIMEOUT.orgSetup);

    expect(claimedMnemonic, 'Mnemonic must exist from test 2').toBeTruthy();
    expect(claimedMnemonic).toHaveLength(12);

    // Spawn a backend for the recovery session
    const recoveryBackend = await backends.start('invitee-recovery');

    // Fresh browser context — no existing session
    const recoveryContext = await browser.newContext();
    await setupTestConfig(recoveryContext);
    await setupBackendRouting(recoveryContext, recoveryBackend.port);
    const recoveryPage = await recoveryContext.newPage();
    setupPageLogging(recoveryPage, 'Recovery');

    try {
      // Clear any existing session
      await recoveryPage.goto(FRONTEND_URL);
      await recoveryPage.evaluate(() => localStorage.clear());
      await recoveryPage.goto(FRONTEND_URL);
      await recoveryPage.waitForLoadState('networkidle');

      // Use the existing loginWithMnemonic helper
      await loginWithMnemonic(recoveryPage, claimedMnemonic);

      // Verify on dashboard
      console.log('[Test] Recovery: on dashboard, checking credential...');

      // Verify membership card is visible with credential status
      const membershipCard = recoveryPage.locator('.membership-card');
      await expect(membershipCard).toBeVisible({ timeout: TIMEOUT.long });

      // Check "Verified" badge and "Credential Active" subtitle
      await expect(membershipCard.locator('.verified-badge'))
        .toHaveText('Verified', { timeout: TIMEOUT.short });
      await expect(membershipCard.locator('.membership-subtitle'))
        .toHaveText('Credential Active', { timeout: TIMEOUT.short });

      console.log('[Test] PASS - Identity recovered, credential still active');
    } finally {
      await recoveryContext.close();
      await backends.stop('invitee-recovery');
    }
  });
});
