import path from 'path';
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
 * E2E: Pre-Created Identity Invitation Flow (Endorsement + Membership)
 *
 * Tests the full invitation lifecycle:
 * 1. Admin creates an endorsement invitation from the dashboard
 * 2. Invitee claims identity, completes profile, goes through pending-approval
 *    where admin approves membership → welcome overlay → dashboard
 * 3. Used invite code is rejected
 * 4. Invitee recovers identity with mnemonic
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

    // Fill endorsement reason (required textarea)
    await modal.locator('textarea').fill('Active community contributor and governance participant');

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
  // Test 2: Invitee claims identity and admin approves membership
  //
  // After mnemonic verification, invitee lands on pending-approval.
  // The 3 membership requirements are shown. Admin approves from dashboard.
  // Invitee receives credential + space invite → welcome overlay → dashboard.
  //
  // Also verifies three onboarding bug fixes:
  // - Bug 1: Form data persists when navigating to Community Guidelines and back
  // - Bug 2: Claim processing shows checkmarks (not spinner) on completion and auto-continues
  // - Bug 3: All profile fields (bio, location, social links, etc.) persist to SharedProfile
  // ------------------------------------------------------------------
  test('invitee claims identity and admin approves membership', async ({ browser }) => {
    test.setTimeout(240_000); // 4 min — includes credential issuance + OOBI resolution + admin approval

    expect(inviteCode, 'Invite code must exist from previous test').toBeTruthy();

    // Profile data used across Bug 1/3 verification
    const profileData = {
      name: 'Test Invitee',
      email: 'test-invitee@matou.nz',
      bio: 'E2E test bio for verification',
      location: 'Auckland, New Zealand',
      indigenousCommunity: 'Ngāti Whātua',
      joinReason: 'Testing the Matou platform',
      facebookUrl: 'https://facebook.com/testinvitee',
      linkedinUrl: 'https://linkedin.com/in/testinvitee',
      twitterUrl: 'https://x.com/testinvitee',
      instagramUrl: 'https://instagram.com/testinvitee',
      githubUrl: 'https://github.com/testinvitee',
      gitlabUrl: 'https://gitlab.com/testinvitee',
      customInterests: 'Digital identity, community building',
    };

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
      console.log('[Test] Filling in profile form with all fields...');
      await expect(
        inviteePage.getByRole('heading', { name: /claim your profile/i }),
      ).toBeVisible({ timeout: TIMEOUT.short });

      // Fill in all profile fields
      await inviteePage.locator('#name input').fill(profileData.name);
      await inviteePage.locator('#email input').fill(profileData.email);
      await inviteePage.locator('#bio').fill(profileData.bio);
      await inviteePage.locator('#location input').fill(profileData.location);
      await inviteePage.locator('#indigenousCommunity input').fill(profileData.indigenousCommunity);
      await inviteePage.locator('#joinReason').fill(profileData.joinReason);
      await inviteePage.locator('#facebookUrl input').fill(profileData.facebookUrl);
      await inviteePage.locator('#linkedinUrl input').fill(profileData.linkedinUrl);
      await inviteePage.locator('#twitterUrl input').fill(profileData.twitterUrl);
      await inviteePage.locator('#instagramUrl input').fill(profileData.instagramUrl);
      await inviteePage.locator('#githubUrl input').fill(profileData.githubUrl);
      await inviteePage.locator('#gitlabUrl input').fill(profileData.gitlabUrl);
      await inviteePage.locator('#customInterests').fill(profileData.customInterests);

      // Upload avatar image
      const avatarPath = path.resolve(__dirname, 'fixtures/test-avatar.png');
      const fileInput = inviteePage.locator('input[type="file"][accept="image/*"]');
      await fileInput.setInputFiles(avatarPath);
      await expect(inviteePage.locator('img[alt="Profile preview"]')).toBeVisible({ timeout: TIMEOUT.short });
      console.log('[Test] Avatar uploaded and preview visible');

      // --- Bug 1: Verify form data persists across Community Guidelines navigation ---
      console.log('[Test] Bug 1: Clicking Community Guidelines link...');
      await inviteePage.getByText('Community Guidelines').click();
      await expect(inviteePage).toHaveURL(/#\/community-guidelines/, { timeout: TIMEOUT.short });

      // Navigate back to the profile form
      await inviteePage.goBack();
      await expect(
        inviteePage.getByRole('heading', { name: /claim your profile/i }),
      ).toBeVisible({ timeout: TIMEOUT.short });

      // Verify all form fields are preserved
      await expect(inviteePage.locator('#name input')).toHaveValue(profileData.name);
      await expect(inviteePage.locator('#email input')).toHaveValue(profileData.email);
      await expect(inviteePage.locator('#bio')).toHaveValue(profileData.bio);
      await expect(inviteePage.locator('#location input')).toHaveValue(profileData.location);
      await expect(inviteePage.locator('#indigenousCommunity input')).toHaveValue(profileData.indigenousCommunity);
      await expect(inviteePage.locator('#joinReason')).toHaveValue(profileData.joinReason);
      await expect(inviteePage.locator('#facebookUrl input')).toHaveValue(profileData.facebookUrl);
      await expect(inviteePage.locator('#linkedinUrl input')).toHaveValue(profileData.linkedinUrl);
      await expect(inviteePage.locator('#twitterUrl input')).toHaveValue(profileData.twitterUrl);
      await expect(inviteePage.locator('#instagramUrl input')).toHaveValue(profileData.instagramUrl);
      await expect(inviteePage.locator('#githubUrl input')).toHaveValue(profileData.githubUrl);
      await expect(inviteePage.locator('#gitlabUrl input')).toHaveValue(profileData.gitlabUrl);
      await expect(inviteePage.locator('#customInterests')).toHaveValue(profileData.customInterests);
      await expect(inviteePage.locator('img[alt="Profile preview"]')).toBeVisible({ timeout: TIMEOUT.short });
      console.log('[Test] Bug 1: PASS - All form fields (including avatar) preserved after Community Guidelines navigation');

      // Agree to terms (checkbox state is also preserved, but re-check to be safe)
      const termsCheckbox = inviteePage.locator('input[type="checkbox"]').last();
      if (!await termsCheckbox.isChecked()) {
        await termsCheckbox.check();
      }

      // Submit profile form
      await inviteePage.getByRole('button', { name: /continue/i }).click();

      // --- Claim Processing Screen ---
      console.log('[Test] Claim processing started...');

      // Wait for processing to complete — "Invitation Claimed!" in the success box
      await expect(
        inviteePage.getByRole('heading', { name: /invitation claimed/i }),
      ).toBeVisible({ timeout: TIMEOUT.orgSetup });
      console.log('[Test] Invitation claimed successfully');

      // --- Bug 2: Verify all steps show checkmarks (no spinners) when done ---
      await expect(inviteePage.locator('.steps-container .animate-spin')).toHaveCount(0);
      console.log('[Test] Bug 2: PASS - All steps show checkmarks, no spinners on completion');

      // Bug 2: Auto-continue fires after 1.5s — wait for recovery phrase screen
      // instead of clicking "Continue" manually
      console.log('[Test] Bug 2: Waiting for auto-continue to recovery phrase screen...');

      // --- Profile Confirmation Screen: Save Your Recovery Phrase ---
      await expect(
        inviteePage.getByRole('heading', { level: 1, name: /save your recovery phrase/i }),
      ).toBeVisible({ timeout: TIMEOUT.long });
      console.log('[Test] Bug 2: PASS - Auto-continued to recovery phrase screen');

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

      // Click "Verify and Continue" — submits registration (apply EXN) and navigates to pending-approval
      console.log('[Test] Clicking verify and continue (triggers registration submission)...');
      await inviteePage.getByRole('button', { name: /verify and continue/i }).click();

      // --- Pending Approval Screen ---
      console.log('[Test] Waiting for pending approval screen...');
      await expect(
        inviteePage.getByText(/application.*review|pending|under review/i).first(),
      ).toBeVisible({ timeout: TIMEOUT.registrationSubmit });
      console.log('[Test] On pending approval screen');

      // --- Verify 3 membership requirement cards are visible ---
      console.log('[Test] Verifying 3 requirement cards...');
      const requirementCards = inviteePage.locator('.requirement-card');
      await expect(requirementCards).toHaveCount(3, { timeout: TIMEOUT.short });

      // Verify requirement titles (use exact match within requirement cards)
      await expect(requirementCards.filter({ hasText: 'Endorsement' }).first()).toBeVisible();
      await expect(requirementCards.filter({ hasText: 'Confirmation' })).toBeVisible();
      await expect(requirementCards.filter({ hasText: 'Attendance' })).toBeVisible();
      console.log('[Test] PASS - All 3 requirement cards visible');

      // Check Confirmation requirement is met (admin issued the endorsement via invite)
      const confirmationCard = requirementCards.filter({ hasText: 'Confirmation' }).first();
      await expect(confirmationCard).toHaveClass(/requirement-met/, { timeout: TIMEOUT.long });
      console.log('[Test] Confirmation requirement card is marked as met (admin endorsement)');

      // --- Admin approves from dashboard ---
      console.log('[Test] Admin: Looking for pending registration...');

      // Navigate admin to dashboard to see pending registrations
      await adminPage.goto(`${FRONTEND_URL}/#/dashboard`);
      await expect(adminPage).toHaveURL(/#\/dashboard/, { timeout: TIMEOUT.short });

      // Wait for the pending profile card for "Test Invitee"
      // The Pending section uses ProfileCard components; click to open ProfileModal
      const pendingSection = adminPage.locator('.members-card');
      const pendingCard = pendingSection.locator('.profile-card').filter({ hasText: 'Test Invitee' }).first();
      await expect(pendingCard).toBeVisible({ timeout: TIMEOUT.long });
      console.log('[Test] Admin: Found pending registration for Test Invitee');

      // Click the profile card to open the modal
      await pendingCard.click();

      // ProfileModal opens — verify endorsement already detected, then mark attendance
      const modal = adminPage.locator('.modal-content');
      await expect(modal).toBeVisible({ timeout: TIMEOUT.short });
      console.log('[Test] Admin: ProfileModal opened');

      // Verify the admin's endorsement from the invite flow is already detected.
      // The "Endorse" button should be replaced by a disabled "Endorsed" button.
      // Check BEFORE clicking Onboarded, because once both conditions are met
      // requirementsMet becomes true and the Endorsed button disappears.
      const endorsedBtn = modal.getByRole('button', { name: /^endorsed$/i });
      await expect(endorsedBtn).toBeVisible({ timeout: TIMEOUT.long });
      await expect(endorsedBtn).toBeDisabled();
      console.log('[Test] Admin: Endorse button shows "Endorsed" (already issued via invite)');

      // Click "Onboarded" to satisfy attendance requirement
      const onboardedBtn = modal.getByRole('button', { name: /onboarded/i });
      await expect(onboardedBtn).toBeVisible({ timeout: TIMEOUT.short });
      await onboardedBtn.click();
      console.log('[Test] Admin: Clicked Onboarded');

      // Wait for KERI credential operations to complete.
      // Both endorsement (already detected) and attendance (just issued) satisfy
      // requirementsMet, so the Approve button should appear.
      console.log('[Test] Admin: Waiting for KERI operations to complete...');
      await adminPage.waitForTimeout(5000);

      // Set up response listener for init-member (approval triggers credential issuance)
      const initMemberPromise = adminPage.waitForResponse(
        (r) => r.url().includes('/init-member') && r.status() === 200,
        { timeout: TIMEOUT.orgSetup },
      );

      // Wait for "Approve" button to appear (requirements now met via reactive props)
      const approveBtn = modal.getByRole('button', { name: /approve/i });
      await expect(approveBtn).toBeVisible({ timeout: TIMEOUT.long });
      await approveBtn.click();
      console.log('[Test] Admin: Clicked Approve, waiting for init-member...');

      // Wait for init-member to complete (credential issuance + space invite)
      await initMemberPromise;
      console.log('[Test] Admin: init-member complete');

      // --- Invitee: Welcome overlay after approval ---
      console.log('[Test] Invitee: Waiting for welcome overlay...');
      await expect(
        inviteePage.locator('.welcome-overlay'),
      ).toBeVisible({ timeout: TIMEOUT.aidCreation });
      console.log('[Test] Welcome overlay shown');

      // Click "Enter Community"
      const enterBtn = inviteePage.getByRole('button', { name: /enter community|enter anyway/i });
      await expect(enterBtn).toBeEnabled({ timeout: TIMEOUT.long });
      await enterBtn.click();

      // --- Should navigate to dashboard ---
      console.log('[Test] Waiting for dashboard...');
      await expect(inviteePage).toHaveURL(/#\/dashboard/, { timeout: TIMEOUT.long });
      console.log('[Test] PASS - Invitee on dashboard after admin approval');

      // --- Bug 3: Verify profile data persisted to Account Settings ---
      console.log('[Test] Bug 3: Checking Account Settings for profile data (with sync retries)...');

      let profileSynced = false;
      for (let attempt = 1; attempt <= 8; attempt++) {
        await inviteePage.goto(`${FRONTEND_URL}/#/dashboard/settings`);
        await expect(inviteePage.locator('.header-title')).toContainText('Account Settings', { timeout: TIMEOUT.short });
        await expect(inviteePage.locator('.settings-content')).toBeVisible({ timeout: TIMEOUT.short });

        const displayName = await inviteePage.locator('input[placeholder="Your display name"]').inputValue();
        if (displayName && displayName !== '') {
          console.log(`[Test] SharedProfile synced on attempt ${attempt} — display name: "${displayName}"`);
          profileSynced = true;
          break;
        }

        console.log(`[Test] SharedProfile not synced yet (attempt ${attempt}/8), retrying in 5s...`);
        await inviteePage.waitForTimeout(5000);
      }

      expect(profileSynced, 'SharedProfile should sync to user backend within 40s').toBe(true);

      await expect(inviteePage.locator('input[placeholder="Your display name"]')).toHaveValue(profileData.name);
      await expect(inviteePage.locator('input[placeholder="Your public email"]')).toHaveValue(profileData.email);
      await expect(inviteePage.locator('textarea[placeholder="Tell us about yourself"]')).toHaveValue(profileData.bio);
      await expect(inviteePage.locator('input[placeholder="Village, City, Country"]')).toHaveValue(profileData.location);
      await expect(inviteePage.locator('input[placeholder="Your community, people"]')).toHaveValue(profileData.indigenousCommunity);
      await expect(inviteePage.locator('textarea[placeholder="Why you joined"]')).toHaveValue(profileData.joinReason);

      const avatarImg = inviteePage.locator('.avatar-img');
      await expect(avatarImg).toBeVisible({ timeout: TIMEOUT.short });
      const avatarSrc = await avatarImg.getAttribute('src');
      expect(avatarSrc).toContain('/api/v1/files/');
      console.log('[Test] Avatar image visible with fileRef:', avatarSrc);

      await expect(inviteePage.locator('.social-link-url').filter({ hasText: 'facebook.com' })).toBeVisible();
      await expect(inviteePage.locator('.social-link-url').filter({ hasText: 'linkedin.com' })).toBeVisible();
      await expect(inviteePage.locator('.social-link-url').filter({ hasText: 'x.com' })).toBeVisible();
      await expect(inviteePage.locator('.social-link-url').filter({ hasText: 'instagram.com' })).toBeVisible();
      await expect(inviteePage.locator('.social-link-url').filter({ hasText: 'github.com' })).toBeVisible();
      await expect(inviteePage.locator('.social-link-url').filter({ hasText: 'gitlab.com' })).toBeVisible();
      console.log('[Test] Bug 3: PASS - All profile data (including avatar) persisted to Account Settings');

      // Verify session persisted with passcode derived from the mnemonic
      const storedPasscode = await inviteePage.evaluate(() => {
        return localStorage.getItem('matou_passcode');
      });
      expect(storedPasscode, 'Passcode should be persisted in localStorage').toBeTruthy();
      expect(storedPasscode, 'Stored passcode should differ from invite code').not.toBe(inviteCode);
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
      console.log('[Test] Recovery: on dashboard, checking community data...');

      // Verify dashboard heading and community sections are visible
      await expect(
        recoveryPage.getByRole('heading', { level: 1, name: /welcome back/i }),
      ).toBeVisible({ timeout: TIMEOUT.long });

      await expect(
        recoveryPage.getByText('Community Activity').first(),
      ).toBeVisible({ timeout: TIMEOUT.short });

      console.log('[Test] PASS - Identity recovered, dashboard accessible');
    } finally {
      await recoveryContext.close();
      await backends.stop('invitee-recovery');
    }
  });
});
