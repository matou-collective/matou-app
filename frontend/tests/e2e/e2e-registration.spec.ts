import path from 'path';
import { ChildProcess, spawn, execSync } from 'child_process';
import * as fs from 'fs';
import { test, expect, Page, BrowserContext, request } from '@playwright/test';
import { setupTestConfig } from './utils/mock-config';
import { requireAllTestServices } from './utils/keri-testnet';
import { BackendManager } from './utils/backend-manager';
import {
  FRONTEND_URL,
  TIMEOUT,
  setupPageLogging,
  setupBackendRouting,
  registerUser,
  navigateToProfileForm,
  captureMnemonicWords,
  completeMnemonicVerification,
  loginWithMnemonic,
  uniqueSuffix,
  loadAccounts,
  saveAccounts,
  performOrgSetup,
  TestAccounts,
} from './utils/test-helpers';

/**
 * Restart the admin backend on port 9080.
 * Kills the current process, re-spawns with the same data directory,
 * and waits for the health endpoint to respond.
 * Returns the new child process (caller is responsible for cleanup).
 */
async function restartAdminBackend(): Promise<ChildProcess> {
  const backendDir = path.resolve(__dirname, '..', '..', '..', 'backend');
  const dataDir = path.join(backendDir, 'data-test');

  // Kill the LISTENING process on port 9080 (the server binary).
  // IMPORTANT: Use -sTCP:LISTEN to avoid killing Chromium or other clients
  // that have open connections to port 9080.
  console.log('[AdminBackend] Stopping admin backend on port 9080...');
  try {
    const pids = execSync('lsof -ti :9080 -sTCP:LISTEN 2>/dev/null', { encoding: 'utf-8' }).trim();
    if (pids) {
      for (const pid of pids.split('\n')) {
        try { process.kill(Number(pid), 'SIGTERM'); } catch { /* already dead */ }
      }
      // Wait for process to exit
      await new Promise(r => setTimeout(r, 2000));
      // Force kill if still alive
      try {
        const remaining = execSync('lsof -ti :9080 -sTCP:LISTEN 2>/dev/null', { encoding: 'utf-8' }).trim();
        if (remaining) {
          for (const pid of remaining.split('\n')) {
            try { process.kill(Number(pid), 'SIGKILL'); } catch { /* ok */ }
          }
        }
      } catch { /* no process left */ }
    }
  } catch { /* no process found */ }

  // Wait a moment for port to be released
  await new Promise(r => setTimeout(r, 1000));

  // Prefer pre-built binary
  const binaryPath = path.join(backendDir, 'bin', 'server');
  const useGoBuild = fs.existsSync(binaryPath);
  const cmd = useGoBuild ? binaryPath : 'go';
  const args = useGoBuild ? [] : ['run', './cmd/server'];

  console.log(`[AdminBackend] Restarting on port 9080 (${useGoBuild ? 'binary' : 'go run'})...`);
  const logFile = fs.openSync('/tmp/matou-test-backend.log', 'a');
  const proc = spawn(cmd, args, {
    cwd: backendDir,
    env: {
      ...process.env,
      MATOU_ENV: 'test',
      MATOU_DATA_DIR: dataDir,
      MATOU_SMTP_PORT: '3525',
    },
    stdio: ['ignore', logFile, logFile],
    detached: true,
  });
  // Detach so the process survives test exit — this is the replacement
  // admin backend on port 9080 and must keep running for subsequent tests.
  proc.unref();

  // Wait for health
  for (let i = 0; i < 60; i++) {
    try {
      const resp = await fetch('http://localhost:9080/health');
      if (resp.ok) {
        console.log('[AdminBackend] Restarted and healthy');
        return proc;
      }
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('Admin backend did not become healthy within 30s after restart');
}

/**
 * E2E: Registration Approval Flow
 *
 * Tests admin approval, full credential chain, decline, and Whakawhānaunga
 * session booking workflows.
 * Self-sufficient: if org-setup hasn't been run yet, performs it automatically.
 *
 * Test 1: Admin approves first member (steward endorsement + attendance + approval)
 * Test 2: Role upgrade enables member to approve — User1 endorses User2 as Member
 *         (no admin buttons), admin upgrades User1 to Community Steward, User1
 *         can now see Approve button and approves User2.
 * Test 3: Admin declines a user registration
 * Test 4: User books a Whakawhānaunga session while pending
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
  let adminBackendProc: ChildProcess | null = null; // tracks restarted admin backend
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
    // NOTE: Do NOT kill adminBackendProc here. If we restarted the admin
    // backend during tests, the spawned process is the new admin backend
    // on port 9080. Killing it would leave no backend for subsequent runs.
    // Detach so it keeps running after the test process exits.
    if (adminBackendProc) {
      adminBackendProc.unref();
      adminBackendProc = null;
    }
    await adminContext?.close();
  });

  // ------------------------------------------------------------------
  // Test 1: Admin approves first member registration
  // ------------------------------------------------------------------
  test('admin approves user registration', async ({ browser }) => {
    test.setTimeout(360_000); // 6 min: registration (~90s) + endorsement (~60s) + approval (~30s) + sync (~60s)

    // Spawn a dedicated backend for this user
    const userBackend = await backends.start('user-approve');

    const userContext = await browser.newContext();
    await setupTestConfig(userContext);
    // Route all backend API calls from this context to the user's backend
    await setupBackendRouting(userContext, userBackend.port);
    const userPage = await userContext.newPage();
    setupPageLogging(userPage, 'User-Approve');

    const userName = `Approve_${uniqueSuffix()}`;

    // Profile data used for registration form and Account Settings verification
    const profileData = {
      name: userName,
      email: 'approve-test@matou.nz',
      bio: 'E2E registration approval test bio',
      location: 'Wellington, New Zealand',
      indigenousCommunity: 'Ngāti Toa Rangatira',
      joinReason: 'Testing the registration approval flow',
      facebookUrl: 'https://facebook.com/approvetest',
      linkedinUrl: 'https://linkedin.com/in/approvetest',
      twitterUrl: 'https://x.com/approvetest',
      instagramUrl: 'https://instagram.com/approvetest',
      githubUrl: 'https://github.com/approvetest',
      gitlabUrl: 'https://gitlab.com/approvetest',
      customInterests: 'Indigenous governance, digital identity',
    };

    try {
      // A. Set up identity/set listener before registration triggers the call
      const identitySetResponse = userPage.waitForResponse(
        resp => resp.url().includes('/api/v1/identity/set') && resp.request().method() === 'POST',
        { timeout: TIMEOUT.aidCreation },
      );

      // 1. User registers with ALL profile fields filled
      //    (inline instead of registerUser() which only fills name/bio)
      await userPage.goto(FRONTEND_URL);
      await navigateToProfileForm(userPage);

      // Fill all profile fields
      console.log('[Test] Filling registration form with all profile fields...');
      await userPage.locator('#name input').fill(profileData.name);
      await userPage.locator('#email input').fill(profileData.email);
      await userPage.locator('#bio').fill(profileData.bio);
      await userPage.locator('#location input').fill(profileData.location);
      await userPage.locator('#indigenousCommunity input').fill(profileData.indigenousCommunity);
      await userPage.locator('#joinReason').fill(profileData.joinReason);
      await userPage.locator('#facebookUrl input').fill(profileData.facebookUrl);
      await userPage.locator('#linkedinUrl input').fill(profileData.linkedinUrl);
      await userPage.locator('#twitterUrl input').fill(profileData.twitterUrl);
      await userPage.locator('#instagramUrl input').fill(profileData.instagramUrl);
      await userPage.locator('#githubUrl input').fill(profileData.githubUrl);
      await userPage.locator('#gitlabUrl input').fill(profileData.gitlabUrl);
      await userPage.locator('#customInterests').fill(profileData.customInterests);

      // Upload avatar image
      const avatarPath = path.resolve(__dirname, 'fixtures/test-avatar.png');
      const fileInput = userPage.locator('input[type="file"][accept="image/*"]');
      await fileInput.setInputFiles(avatarPath);
      // Wait for the preview to appear (FileReader processes the image)
      await expect(userPage.locator('img[alt="Profile preview"]')).toBeVisible({ timeout: TIMEOUT.short });
      console.log('[Test] Avatar uploaded and preview visible');

      // Select an interest if available
      const interest = userPage.locator('label').filter({ hasText: 'Governance' }).first();
      if (await interest.isVisible()) await interest.click();

      // Agree to terms
      await userPage.locator('input[type="checkbox"]').last().check();

      // Submit - creates AID (witness-backed AIDs can take up to 3 minutes)
      await userPage.getByRole('button', { name: /continue/i }).click();
      console.log(`[${userName}] Creating identity...`);
      await expect(
        userPage.getByText(/identity created successfully/i),
      ).toBeVisible({ timeout: TIMEOUT.aidCreation });

      // Capture mnemonic
      const mnemonic = await captureMnemonicWords(userPage);

      // Confirm and proceed to verification
      await userPage.locator('.confirm-box input[type="checkbox"]').check();
      await userPage.getByRole('button', { name: /continue to verification/i }).click();

      // Complete verification
      await completeMnemonicVerification(userPage, mnemonic, /verify and continue/i);

      // Wait for pending screen (submission includes OOBI resolution + EXN + IPEX)
      await expect(
        userPage.getByText(/application.*review|pending|under review/i).first(),
      ).toBeVisible({ timeout: TIMEOUT.registrationSubmit });
      console.log(`[${userName}] Registration submitted, on pending screen`);

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

      // 3. Wait for admin to see pending member in New Members card
      // KERIA message delivery through witness network can take 30-60s
      // Registration polling auto-creates a SharedProfile with status "pending"
      // when it detects the registration notification. The dashboard's liveMembers
      // computed reads from communityProfiles which includes pending profiles.
      console.log('[Test] Waiting for pending member to appear in New Members card...');
      const membersCard = adminPage.locator('.members-card');
      const pendingMemberCard = membersCard.locator('.card-name', { hasText: userName });
      await expect(pendingMemberCard).toBeVisible({ timeout: TIMEOUT.medium });
      console.log('[Test] Pending member visible in New Members card before approval');

      // Verify the profile has "pending" status via the admin backend API
      const pendingProfilesResp = await adminPage.request.get('http://localhost:9080/api/v1/profiles/SharedProfile');
      const pendingProfiles = await pendingProfilesResp.json();
      const pendingProfileList = (pendingProfiles.profiles ?? []) as Array<{ id: string; data: Record<string, unknown> }>;
      const pendingProfile = pendingProfileList.find(p => (p.data?.displayName as string) === userName);
      expect(pendingProfile, `SharedProfile for ${userName} should exist before approval`).toBeTruthy();
      expect(pendingProfile!.data.status, 'SharedProfile status should be "pending" before approval').toBe('pending');
      console.log(`[Test] Confirmed SharedProfile status is "pending" for ${userName}`);

      // ================================================================
      // 3c. ENDORSEMENT: Admin endorses the pending applicant
      // ================================================================
      console.log('[Test] --- Starting endorsement flow ---');

      // Click on the pending member card in New Members to open ProfileModal
      const memberProfileCard = membersCard.locator('.profile-card').filter({ hasText: userName });
      await memberProfileCard.click();

      // Verify ProfileModal opens and shows the pending member
      const profileModal = adminPage.locator('.modal-content');
      await expect(profileModal).toBeVisible({ timeout: TIMEOUT.short });
      await expect(profileModal.locator('h4').first()).toContainText(userName, { timeout: TIMEOUT.short });
      console.log('[Test] ProfileModal opened for pending member');

      // Verify "Endorse" button is visible (admin is steward, so should see Endorse + Decline)
      // "Approve" button is hidden until requirements are met (2 endorsements + 1 attendance)
      const endorseBtn = profileModal.getByRole('button', { name: /^Endorse$/i });
      await expect(endorseBtn).toBeVisible({ timeout: TIMEOUT.short });
      const approveBtn = profileModal.getByRole('button', { name: /approve/i });
      await expect(approveBtn).not.toBeVisible();
      console.log('[Test] Endorse button visible, Approve button hidden (requirements not met)');

      // Click "Endorse" to show the endorsement message textarea
      await endorseBtn.click();
      const endorseTextarea = profileModal.locator('textarea[placeholder="Why do you endorse this person?"]');
      await expect(endorseTextarea).toBeVisible({ timeout: TIMEOUT.short });

      // Fill an optional endorsement message
      const endorseMessage = 'I endorse this applicant for E2E testing';
      await endorseTextarea.fill(endorseMessage);

      // Click "Confirm Endorsement" and wait for credential issuance
      // This involves: registry creation, schema OOBI resolution, OOBI resolution, credential issuance, IPEX grant
      const confirmEndorseBtn = profileModal.getByRole('button', { name: /confirm endorsement/i });
      await expect(confirmEndorseBtn).toBeEnabled({ timeout: TIMEOUT.short });
      await confirmEndorseBtn.click();
      console.log('[Test] Clicked Confirm Endorsement — waiting for credential issuance...');

      // Wait for "Endorsed" (disabled) button to appear — indicates endorsement succeeded
      // Endorsement involves: registry creation, schema OOBI, applicant OOBI, credential issuance, IPEX grant
      const endorsedBtn = profileModal.getByRole('button', { name: /^Endorsed$/i });
      await expect(endorsedBtn).toBeVisible({ timeout: TIMEOUT.registrationSubmit });
      console.log('[Test] Endorsement succeeded — "Endorsed" button visible');

      // Verify endorsement appears in the modal's endorsements section
      const endorsementItem = profileModal.locator('.endorsement-item');
      await expect(endorsementItem).toBeVisible({ timeout: TIMEOUT.short });
      console.log('[Test] Endorsement item visible in ProfileModal');

      // Close the modal
      await profileModal.locator('button').filter({ has: adminPage.locator('svg') }).first().click();
      await expect(profileModal).not.toBeVisible({ timeout: TIMEOUT.short });

      // 3d. Verify endorsement badge appears on the ProfileCard in New Members
      const endorsementBadge = membersCard.locator('.profile-card').filter({ hasText: userName }).locator('.card-endorsements');
      await expect(endorsementBadge).toBeVisible({ timeout: TIMEOUT.short });
      await expect(endorsementBadge).toContainText('1');
      console.log('[Test] Endorsement badge visible on ProfileCard (1 endorsement)');

      // 3e. Verify applicant's PendingApprovalScreen shows endorsement in requirement cards
      // The applicant's credential poller should detect the endorsement grant and auto-admit it
      console.log('[Test] Waiting for endorsement to appear in requirement cards...');
      const requirementsGrid = userPage.locator('.requirements-grid');
      await expect(requirementsGrid).toBeVisible({ timeout: TIMEOUT.short });

      // Admin is a steward — their endorsement should turn the "Confirmation" card green
      const confirmationCard = requirementsGrid.locator('.requirement-card', { hasText: 'Confirmation' });
      await expect(confirmationCard).toHaveClass(/requirement-met/, { timeout: TIMEOUT.long });
      console.log('[Test] Confirmation requirement card turned green after steward endorsement');

      // Only steward endorsement — "Endorsement" card (req 1) should still be pending (needs a non-steward member)
      const memberEndorsementCard = requirementsGrid.locator('.requirement-card', { hasText: 'Endorsement' });
      await expect(memberEndorsementCard).toHaveClass(/requirement-pending/);
      console.log('[Test] Member endorsement card still pending (needs a member endorsement)');

      console.log('[Test] --- Endorsement flow complete ---');

      // ================================================================
      // 3f. EVENT ATTENDANCE: Admin marks applicant as attended
      // ================================================================
      console.log('[Test] --- Starting event attendance flow ---');

      // Re-open ProfileModal for the pending member
      const memberCardForAttendance = membersCard.locator('.profile-card').filter({ hasText: userName });
      await memberCardForAttendance.click();
      const attendanceModal = adminPage.locator('.modal-content');
      await expect(attendanceModal).toBeVisible({ timeout: TIMEOUT.short });
      await expect(attendanceModal.locator('h4').first()).toContainText(userName, { timeout: TIMEOUT.short });
      console.log('[Test] ProfileModal re-opened for event attendance');

      // Verify "Onboarded" button is visible (admin is steward)
      const onboardedBtn = attendanceModal.getByRole('button', { name: /onboarded/i });
      await expect(onboardedBtn).toBeVisible({ timeout: TIMEOUT.short });
      console.log('[Test] Onboarded button visible');

      // Click "Onboarded" — issues event attendance credential
      // This involves: registry lookup, schema OOBI resolution, applicant OOBI resolution, credential issuance, IPEX grant
      await onboardedBtn.click();
      console.log('[Test] Clicked Onboarded — waiting for credential issuance...');

      // Wait for disabled "Onboarded" button to appear — indicates issuance succeeded
      const onboardedDoneBtn = attendanceModal.locator('button:disabled', { hasText: /onboarded/i });
      await expect(onboardedDoneBtn).toBeVisible({ timeout: TIMEOUT.registrationSubmit });
      console.log('[Test] Event attendance succeeded — "Onboarded" button disabled');

      // Close the modal
      await attendanceModal.locator('button').filter({ has: adminPage.locator('svg') }).first().click();
      await expect(attendanceModal).not.toBeVisible({ timeout: TIMEOUT.short });

      // 3g. Verify applicant's PendingApprovalScreen shows attendance in requirement cards
      // The applicant's credential poller should detect the event attendance grant and auto-admit it
      console.log('[Test] Waiting for session attendance to appear in requirement cards...');
      const whakawhanaunga = requirementsGrid.locator('.requirement-card', { hasText: 'Whakawhanaunga' });
      await expect(whakawhanaunga).toHaveClass(/requirement-met/, { timeout: TIMEOUT.long });
      console.log('[Test] Whakawhanaunga requirement card turned green after event attendance');

      console.log('[Test] --- Event attendance flow complete ---');

      // B. Set up invite + sync + initMemberProfiles listeners before approval
      // initMemberProfiles creates SharedProfile + CommunityProfile on admin's backend
      const initProfilesResponse = adminPage.waitForResponse(
        resp => resp.url().includes('/api/v1/profiles/init-member') && resp.request().method() === 'POST',
        { timeout: TIMEOUT.long },
      );
      // Invite goes through admin's backend (port 9080)
      const inviteResponse = adminPage.waitForResponse(
        resp => resp.url().includes('/api/v1/spaces/community/invite') && resp.request().method() === 'POST',
        { timeout: TIMEOUT.long },
      );
      // Community join goes through user's backend (routed port)
      // Longer timeout: admission involves credential issuance (~12s) + IPEX grant (~10s)
      // + KERIA delivery (~10s) + user poll/admit/sync (~20s) = ~50s total
      const joinResponse = userPage.waitForResponse(
        resp => resp.url().includes('/api/v1/spaces/community/join') && resp.request().method() === 'POST',
        { timeout: TIMEOUT.aidCreation },
      );
      // Sync goes through user's backend (routed port)
      const syncResponse = userPage.waitForResponse(
        resp => resp.url().includes('/api/v1/sync/credentials') && resp.request().method() === 'POST',
        { timeout: TIMEOUT.aidCreation },
      );

      // 4. Admin approves — re-open ProfileModal and click "Admit"
      console.log('[Test] Opening ProfileModal to admit member...');
      const memberCardForAdmit = membersCard.locator('.profile-card').filter({ hasText: userName });
      await memberCardForAdmit.click();
      const admitModal = adminPage.locator('.modal-content');
      await expect(admitModal).toBeVisible({ timeout: TIMEOUT.short });
      const approveButton = admitModal.getByRole('button', { name: /approve/i });
      await expect(approveButton).toBeVisible({ timeout: TIMEOUT.short });
      console.log('[Test] Admin clicking Approve...');
      await approveButton.click();

      // 5. Verify community space invite during approval (from admin's backend)
      const invResp = await inviteResponse;
      expect(invResp.status()).toBe(200);
      const invBody = await invResp.json();
      expect(invBody.success).toBe(true);
      expect(invBody.communitySpaceId, 'Invite should include communitySpaceId').toBeTruthy();
      expect(invBody.inviteKey, 'Invite should include community invite key').toBeTruthy();
      expect(invBody.readOnlyInviteKey, 'Invite should include readOnlyInviteKey').toBeTruthy();
      expect(invBody.readOnlySpaceId, 'Invite should include readOnlySpaceId').toBeTruthy();
      console.log('[Test] Invite includes readonly keys:', {
        communitySpaceId: invBody.communitySpaceId?.slice(0, 16) + '...',
        readOnlySpaceId: invBody.readOnlySpaceId?.slice(0, 16) + '...',
        hasInviteKey: !!invBody.inviteKey,
        hasReadOnlyInviteKey: !!invBody.readOnlyInviteKey,
      });

      // 5b. Verify initMemberProfiles succeeded (SharedProfile + CommunityProfile created)
      const initResp = await initProfilesResponse;
      expect(initResp.status()).toBe(200);
      const initBody = await initResp.json();
      expect(initBody.success).toBe(true);
      expect(initBody.sharedProfileObjectId).toBeTruthy();
      expect(initBody.sharedProfileSpaceId).toBeTruthy();
      console.log('[Test] initMemberProfiles succeeded:', {
        objectId: initBody.objectId,
        sharedProfileObjectId: initBody.sharedProfileObjectId,
      });

      // 5b2. Query admin backend directly — verify the SharedProfile is readable and status is "approved"
      const adminProfilesResp = await adminPage.request.get('http://localhost:9080/api/v1/profiles/SharedProfile');
      const adminProfiles = await adminProfilesResp.json();
      const adminProfileList = (adminProfiles.profiles ?? []) as Array<{ id: string; data: Record<string, unknown> }>;
      console.log(`[Test] Admin backend SharedProfiles (${adminProfileList.length}):`);
      for (const p of adminProfileList) {
        console.log(`  - ${p.id} aid=${p.data?.aid} name=${p.data?.displayName} status=${p.data?.status}`);
      }
      const userProfileOnAdmin = adminProfileList.find(p => p.id === initBody.sharedProfileObjectId);
      expect(userProfileOnAdmin, `Admin should have SharedProfile ${initBody.sharedProfileObjectId}`).toBeTruthy();
      expect(userProfileOnAdmin!.data.status, 'SharedProfile status should be "approved" after approval').toBe('approved');

      // 5b3. Verify member still appears in the New Members card after approval.
      // The member was already visible as "pending" (step 3b); after approval the
      // backend emits a profile:updated SSE event which refreshes the list.
      console.log('[Test] Verifying member still visible in New Members card after approval...');
      await expect(pendingMemberCard).toBeVisible({ timeout: TIMEOUT.medium });
      console.log('[Test] Member still visible in New Members card after approval');

      // 5c. Verify user's backend joined the community space
      const joinResp = await joinResponse;
      const joinBody = await joinResp.json();
      console.log('[Test] Community join response:', { status: joinResp.status(), body: joinBody });
      expect(joinResp.status()).toBe(200);
      expect(joinBody.success).toBe(true);

      // 6. User receives credential (welcome overlay)
      console.log('[Test] Waiting for user to receive credential...');
      await expect(userPage.locator('.welcome-overlay')).toBeVisible({ timeout: TIMEOUT.long });
      console.log('[Test] User received credential!');

      // 7. User enters community and lands on dashboard
      // Button starts as "Syncing..." (disabled), becomes "Enter Community" when profile sync completes.
      // No timeout fallback — sync must complete before entering.
      const enterButton = userPage.getByRole('button', { name: /enter community/i });
      await expect(enterButton).toBeEnabled({ timeout: TIMEOUT.long + 30_000 });
      console.log('[Test] Enter Community button enabled — profile sync confirmed');
      await enterButton.click();
      await expect(userPage).toHaveURL(/#\/dashboard/, { timeout: TIMEOUT.short });

      // 8. Save member credentials for downstream tests (e.g. chat)
      // Get AID from the user's backend (identity store is in memory, not localStorage)
      const identityResp = await userPage.request.get(`http://localhost:${userBackend.port}/api/v1/identity`);
      const identityBody = await identityResp.json();
      const memberAid = identityBody.aid || '';
      accounts.member = {
        mnemonic: mnemonic,
        aid: memberAid,
        name: userName,
      };
      accounts.note = 'Auto-generated. Admin from org-setup, member from registration approval.';
      saveAccounts(accounts);
      console.log(`[Test] Saved member account: ${userName} (${memberAid.slice(0, 12)}...)`);

      // 9. Verify credential synced to backend (through user's backend)
      const syncResp = await syncResponse;
      expect(syncResp.status()).toBe(200);
      const syncBody = await syncResp.json();
      expect(syncBody.synced).toBeGreaterThan(0);
      console.log('[Test] Credential synced:', {
        synced: syncBody.synced,
        spaces: syncBody.spaces,
        privateSpace: syncBody.privateSpace,
        communitySpace: syncBody.communitySpace,
        errors: syncBody.errors,
      });

      console.log('[Test] PASS - User approved, credential synced, dashboard accessible');

      // 9. Verify all profile data persisted to Account Settings
      //    WelcomeOverlay confirmed the user's SharedProfile synced (matched by AID).
      //    Retry page loads in case the settings page needs time to read from store.
      console.log('[Test] Checking Account Settings for profile data (with sync retries)...');

      let profileSynced = false;
      for (let attempt = 1; attempt <= 8; attempt++) {
        await userPage.goto(`${FRONTEND_URL}/#/dashboard/settings`);
        await expect(userPage.locator('.header-title')).toContainText('Account Settings', { timeout: TIMEOUT.short });
        await expect(userPage.locator('.settings-content')).toBeVisible({ timeout: TIMEOUT.short });

        // Check if display name has populated (indicates this user's SharedProfile synced)
        const displayName = await userPage.locator('input[placeholder="Your display name"]').inputValue();
        if (displayName && displayName !== '') {
          console.log(`[Test] SharedProfile synced on attempt ${attempt} — display name: "${displayName}"`);
          profileSynced = true;
          break;
        }

        console.log(`[Test] SharedProfile not synced yet (attempt ${attempt}/8), retrying in 5s...`);
        await userPage.waitForTimeout(5000);
      }

      expect(profileSynced, 'SharedProfile should sync to user backend within 40s').toBe(true);

      // Verify all text fields persisted from registration
      await expect(userPage.locator('input[placeholder="Your display name"]')).toHaveValue(profileData.name);
      await expect(userPage.locator('input[placeholder="Your public email"]')).toHaveValue(profileData.email);
      await expect(userPage.locator('textarea[placeholder="Tell us about yourself"]')).toHaveValue(profileData.bio);
      await expect(userPage.locator('input[placeholder="Village, City, Country"]')).toHaveValue(profileData.location);
      await expect(userPage.locator('input[placeholder="Your community, people"]')).toHaveValue(profileData.indigenousCommunity);
      await expect(userPage.locator('textarea[placeholder="Why you joined"]')).toHaveValue(profileData.joinReason);
      await expect(userPage.locator('textarea[placeholder="Other interests"]')).toHaveValue(profileData.customInterests);

      // Verify avatar image is displayed (uploaded during registration, carried into SharedProfile)
      const avatarImg = userPage.locator('.avatar-img');
      await expect(avatarImg).toBeVisible({ timeout: TIMEOUT.short });
      const avatarSrc = await avatarImg.getAttribute('src');
      expect(avatarSrc).toContain('/api/v1/files/');
      console.log('[Test] Avatar image visible with fileRef:', avatarSrc);

      // Verify social links appear in the social links list
      await expect(userPage.locator('.social-link-url').filter({ hasText: 'facebook.com' })).toBeVisible();
      await expect(userPage.locator('.social-link-url').filter({ hasText: 'linkedin.com' })).toBeVisible();
      await expect(userPage.locator('.social-link-url').filter({ hasText: 'x.com' })).toBeVisible();
      await expect(userPage.locator('.social-link-url').filter({ hasText: 'instagram.com' })).toBeVisible();
      await expect(userPage.locator('.social-link-url').filter({ hasText: 'github.com' })).toBeVisible();
      await expect(userPage.locator('.social-link-url').filter({ hasText: 'gitlab.com' })).toBeVisible();
      console.log('[Test] PASS - All registration profile data (including avatar) persisted to Account Settings');

      // ================================================================
      // 10. Restart admin backend and verify invite still includes readonly keys
      // ================================================================
      // This tests that the backend recovers its any-sync SDK state from disk
      // and can produce invites with readonly keys after a restart.
      // NOTE: Must happen after Account Settings check because restartAdminBackend()
      // kills/respawns port 9080, which can disrupt other running backends.
      // Stop the user backend first so it doesn't get caught in the crossfire.
      await backends.stop('user-approve');
      await userContext.close();

      console.log('[Test] --- Restarting admin backend to verify invite resilience ---');
      adminBackendProc = await restartAdminBackend();

      // Call the invite endpoint directly using a standalone request context
      const apiCtx = await request.newContext({ baseURL: 'http://localhost:9080' });
      const reinviteResp = await apiCtx.post('/api/v1/spaces/community/invite', {
        data: {
          recipientAid: memberAid,
          credentialSaid: 'ETestDummySAIDForReinviteVerification',
          schema: 'EMatouMembershipSchemaV1',
        },
      });
      expect(reinviteResp.status()).toBe(200);
      const reinviteBody = await reinviteResp.json();
      expect(reinviteBody.success, 'Post-restart invite should succeed').toBe(true);
      expect(reinviteBody.inviteKey, 'Post-restart invite should include community invite key').toBeTruthy();
      expect(reinviteBody.readOnlyInviteKey, 'Post-restart invite should include readOnlyInviteKey').toBeTruthy();
      expect(reinviteBody.readOnlySpaceId, 'Post-restart invite should include readOnlySpaceId').toBeTruthy();
      console.log('[Test] Post-restart invite includes readonly keys:', {
        communitySpaceId: reinviteBody.communitySpaceId?.slice(0, 16) + '...',
        readOnlySpaceId: reinviteBody.readOnlySpaceId?.slice(0, 16) + '...',
        hasInviteKey: !!reinviteBody.inviteKey,
        hasReadOnlyInviteKey: !!reinviteBody.readOnlyInviteKey,
      });
      console.log('[Test] PASS - Admin backend restart: invite with readonly keys verified');
      await apiCtx.dispose();
    } finally {
      // User context and backend may already be closed (step 10 cleans up before restart).
      // Calling stop/close again is safe — they're no-ops if already stopped.
      await backends.stop('user-approve').catch(() => {});
      await userContext?.close().catch(() => {});
    }
  });

  // ------------------------------------------------------------------
  // Test 2: Register and approve a second member (User2)
  //
  // Registers User2, completes endorsement/attendance requirements via
  // admin + User1, then admin approves User2. Creates member2 account
  // used by later tests (e.g. Test 5 member removal).
  //
  // NOTE: Role upgrade (promoting User1 to Community Steward) is skipped
  // for now — the ChangeRoleModal needs investigation.
  // ------------------------------------------------------------------
  test('register and approve a second member', async ({ browser }) => {
    test.setTimeout(360_000); // 6 min: registration + endorsements + attendance + approval

    // Reload accounts saved by test 1 (includes member mnemonic).
    // Skip gracefully when running standalone without test 1.
    accounts = loadAccounts();
    if (!accounts.member?.mnemonic) {
      test.skip(true, 'Test 1 must run first to create member account');
      return;
    }

    // --- Set up User2 (new registrant) ---
    const user2Backend = await backends.start('user2-approve');
    const user2Context = await browser.newContext();
    await setupTestConfig(user2Context);
    await setupBackendRouting(user2Context, user2Backend.port);
    const user2Page = await user2Context.newPage();
    setupPageLogging(user2Page, 'User2');

    const user2Name = `Member2_${uniqueSuffix()}`;

    // --- Set up User1 (existing member from test 1) ---
    const user1Backend = await backends.start('user1-endorse');
    const user1Context = await browser.newContext();
    await setupTestConfig(user1Context);
    await setupBackendRouting(user1Context, user1Backend.port);
    const user1Page = await user1Context.newPage();
    setupPageLogging(user1Page, 'User1');

    try {
      // ================================================================
      // A. Register User2
      // ================================================================
      console.log(`[Test] Registering User2: ${user2Name}`);
      const { mnemonic: user2Mnemonic } = await registerUser(user2Page, user2Name);

      // ================================================================
      // B. Log in User1 (existing member from test 1)
      // ================================================================
      console.log('[Test] Logging in User1 with saved mnemonic...');
      await loginWithMnemonic(user1Page, accounts.member!.mnemonic);
      console.log('[Test] User1 on dashboard');

      // ================================================================
      // C. Wait for User2 to appear in admin's pending members
      // ================================================================
      console.log('[Test] Waiting for User2 to appear in admin New Members...');
      const membersCard = adminPage.locator('.members-card');
      const user2CardName = membersCard.locator('.card-name', { hasText: user2Name });
      await expect(user2CardName).toBeVisible({ timeout: TIMEOUT.medium });
      console.log('[Test] User2 visible in admin members card');

      // ================================================================
      // D. User2 appears on User1's members list
      // ================================================================
      console.log('[Test] Waiting for User2 to appear in User1 members list...');
      const user1MembersCard = user1Page.locator('.members-card');
      const user2OnUser1 = user1MembersCard.locator('.card-name', { hasText: user2Name });
      await expect(user2OnUser1).toBeVisible({ timeout: TIMEOUT.registrationSubmit });
      console.log('[Test] User2 visible in User1 members card');

      // ================================================================
      // E. User1 opens User2's profile — only Endorse visible (User1 is Member)
      // ================================================================
      console.log('[Test] --- User1 opening User2 profile (as Member) ---');
      const user2CardOnUser1 = user1MembersCard.locator('.profile-card').filter({ hasText: user2Name });
      await user2CardOnUser1.click();

      const user1Modal = user1Page.locator('.modal-content');
      await expect(user1Modal).toBeVisible({ timeout: TIMEOUT.short });
      await expect(user1Modal.locator('h4').first()).toContainText(user2Name, { timeout: TIMEOUT.short });

      // User1 should see "Endorse" button (they are a regular Member)
      const user1EndorseBtn = user1Modal.getByRole('button', { name: /^Endorse$/i });
      await expect(user1EndorseBtn).toBeVisible({ timeout: TIMEOUT.short });
      console.log('[Test] Endorse button visible for User1 (Member)');

      // User1 should NOT see Approve or Onboarded buttons (not a steward)
      await expect(user1Modal.getByRole('button', { name: /approve/i })).not.toBeVisible();
      await expect(user1Modal.getByRole('button', { name: /onboarded/i })).not.toBeVisible();
      console.log('[Test] User1 correctly cannot see Approve or Onboarded (is Member, not steward)');

      // ================================================================
      // F. User1 endorses User2 (member endorsement)
      // ================================================================
      console.log('[Test] --- User1 endorsing User2 ---');
      await user1EndorseBtn.click();
      const user1EndorseTextarea = user1Modal.locator('textarea[placeholder="Why do you endorse this person?"]');
      await expect(user1EndorseTextarea).toBeVisible({ timeout: TIMEOUT.short });
      await user1EndorseTextarea.fill('Member endorsement from User1');

      const user1ConfirmEndorse = user1Modal.getByRole('button', { name: /confirm endorsement/i });
      await expect(user1ConfirmEndorse).toBeEnabled({ timeout: TIMEOUT.short });
      await user1ConfirmEndorse.click();
      console.log('[Test] User1 clicked Confirm Endorsement...');

      const user1EndorsedBtn = user1Modal.getByRole('button', { name: /^Endorsed$/i });
      await expect(user1EndorsedBtn).toBeVisible({ timeout: TIMEOUT.aidCreation });
      console.log('[Test] User1 endorsement succeeded');

      // Close User1 modal
      await user1Modal.locator('button').filter({ has: user1Page.locator('svg') }).first().click();
      await expect(user1Modal).not.toBeVisible({ timeout: TIMEOUT.short });

      // Verify member endorsement on User2's PendingApprovalScreen
      console.log('[Test] Verifying Endorsement requirement card on User2 screen...');
      const requirementsGrid = user2Page.locator('.requirements-grid');
      await expect(requirementsGrid).toBeVisible({ timeout: TIMEOUT.short });
      const endorsementCard = requirementsGrid.locator('.requirement-card', { hasText: 'Endorsement' });
      await expect(endorsementCard).toHaveClass(/requirement-met/, { timeout: TIMEOUT.long });
      console.log('[Test] Endorsement card green (member endorsement from User1)');

      // ================================================================
      // G. Admin endorses User2 (steward endorsement — Confirmation requirement)
      // ================================================================
      console.log('[Test] --- Admin endorsing User2 ---');
      const user2ProfileCard = membersCard.locator('.profile-card').filter({ hasText: user2Name });
      await user2ProfileCard.click();

      const adminModal = adminPage.locator('.modal-content');
      await expect(adminModal).toBeVisible({ timeout: TIMEOUT.short });
      await expect(adminModal.locator('h4').first()).toContainText(user2Name, { timeout: TIMEOUT.short });

      const adminEndorseBtn = adminModal.getByRole('button', { name: /^Endorse$/i });
      await expect(adminEndorseBtn).toBeVisible({ timeout: TIMEOUT.short });
      await adminEndorseBtn.click();

      const adminEndorseTextarea = adminModal.locator('textarea[placeholder="Why do you endorse this person?"]');
      await expect(adminEndorseTextarea).toBeVisible({ timeout: TIMEOUT.short });
      await adminEndorseTextarea.fill('Admin endorsement for User2');

      const adminConfirmEndorse = adminModal.getByRole('button', { name: /confirm endorsement/i });
      await expect(adminConfirmEndorse).toBeEnabled({ timeout: TIMEOUT.short });
      await adminConfirmEndorse.click();
      console.log('[Test] Clicked admin Confirm Endorsement...');

      const adminEndorsedBtn = adminModal.getByRole('button', { name: /^Endorsed$/i });
      await expect(adminEndorsedBtn).toBeVisible({ timeout: TIMEOUT.aidCreation });
      console.log('[Test] Admin endorsement succeeded');

      // Close modal
      await adminModal.locator('button').filter({ has: adminPage.locator('svg') }).first().click();
      await expect(adminModal).not.toBeVisible({ timeout: TIMEOUT.short });

      // Verify steward endorsement on User2's PendingApprovalScreen
      const confirmationCard = requirementsGrid.locator('.requirement-card', { hasText: 'Confirmation' });
      await expect(confirmationCard).toHaveClass(/requirement-met/, { timeout: TIMEOUT.long });
      console.log('[Test] Confirmation card green (steward endorsement from admin)');

      // ================================================================
      // H. Admin marks User2 attendance (Whakawhanaunga requirement)
      // ================================================================
      console.log('[Test] --- Admin marking User2 attendance ---');
      const user2CardForAttendance = membersCard.locator('.profile-card').filter({ hasText: user2Name });
      await user2CardForAttendance.click();

      const attendanceModal = adminPage.locator('.modal-content');
      await expect(attendanceModal).toBeVisible({ timeout: TIMEOUT.short });

      const onboardedBtn = attendanceModal.getByRole('button', { name: /onboarded/i });
      await expect(onboardedBtn).toBeVisible({ timeout: TIMEOUT.short });
      await onboardedBtn.click();
      console.log('[Test] Clicked Onboarded...');

      const onboardedDoneBtn = attendanceModal.locator('button:disabled', { hasText: /onboarded/i });
      await expect(onboardedDoneBtn).toBeVisible({ timeout: TIMEOUT.aidCreation });
      console.log('[Test] Event attendance succeeded');

      // Close modal
      await attendanceModal.locator('button').filter({ has: adminPage.locator('svg') }).first().click();
      await expect(attendanceModal).not.toBeVisible({ timeout: TIMEOUT.short });

      // Verify attendance on User2's PendingApprovalScreen
      console.log('[Test] Verifying Whakawhanaunga requirement card on User2 screen...');
      const whakawhanaunga = requirementsGrid.locator('.requirement-card', { hasText: 'Whakawhanaunga' });
      await expect(whakawhanaunga).toHaveClass(/requirement-met/, { timeout: TIMEOUT.long });
      console.log('[Test] Whakawhanaunga card green (attendance)');

      // ================================================================
      // Verify all 3 requirement cards are green
      // ================================================================
      console.log('[Test] Verifying all 3 requirement cards are green...');
      const allCards = requirementsGrid.locator('.requirement-card');
      const cardCount = await allCards.count();
      expect(cardCount).toBe(3);
      for (let i = 0; i < cardCount; i++) {
        await expect(allCards.nth(i)).toHaveClass(/requirement-met/);
      }
      console.log('[Test] All 3 requirement cards are met!');

      // ================================================================
      // G. Admin approves User2
      // ================================================================
      console.log('[Test] --- Admin approving User2 ---');
      const user2CardForApproval = membersCard.locator('.profile-card').filter({ hasText: user2Name });
      await user2CardForApproval.click();

      const approvalModal = adminPage.locator('.modal-content');
      await expect(approvalModal).toBeVisible({ timeout: TIMEOUT.short });
      await expect(approvalModal.locator('h4').first()).toContainText(user2Name, { timeout: TIMEOUT.short });

      const approveBtn = approvalModal.getByRole('button', { name: /approve/i });
      await expect(approveBtn).toBeVisible({ timeout: TIMEOUT.short });

      // Set up response listeners
      const initProfilesResponse = adminPage.waitForResponse(
        resp => resp.url().includes('/api/v1/profiles/init-member') && resp.request().method() === 'POST',
        { timeout: TIMEOUT.long },
      );
      const inviteResponse = adminPage.waitForResponse(
        resp => resp.url().includes('/api/v1/spaces/community/invite') && resp.request().method() === 'POST',
        { timeout: TIMEOUT.long },
      );
      const joinResponse = user2Page.waitForResponse(
        resp => resp.url().includes('/api/v1/spaces/community/join') && resp.request().method() === 'POST',
        { timeout: TIMEOUT.aidCreation },
      );

      await approveBtn.click();
      console.log('[Test] Admin clicked Approve');

      // Verify invite and init-member
      const invResp = await inviteResponse;
      expect(invResp.status()).toBe(200);
      console.log('[Test] Community invite sent');

      const initResp = await initProfilesResponse;
      expect(initResp.status()).toBe(200);
      console.log('[Test] Init member profiles succeeded');

      // Verify community join
      const joinResp = await joinResponse;
      expect(joinResp.status()).toBe(200);
      console.log('[Test] User2 joined community space');

      // ================================================================
      // H. User2 receives credential and enters community
      // ================================================================
      console.log('[Test] Waiting for User2 to receive credential...');
      await expect(user2Page.locator('.welcome-overlay')).toBeVisible({ timeout: TIMEOUT.long });
      console.log('[Test] User2 received credential!');

      const enterButton = user2Page.getByRole('button', { name: /enter community/i });
      await expect(enterButton).toBeEnabled({ timeout: TIMEOUT.long + 30_000 });
      await enterButton.click();
      await expect(user2Page).toHaveURL(/#\/dashboard/, { timeout: TIMEOUT.short });
      console.log('[Test] User2 on dashboard — approved by admin');

      // Save User2 account — get AID from the user's backend (same as Test 1)
      const identityResp = await user2Page.request.get(`http://localhost:${user2Backend.port}/api/v1/identity`);
      const identityBody = await identityResp.json();
      const member2Aid = identityBody.aid || '';
      accounts.member2 = {
        mnemonic: user2Mnemonic,
        aid: member2Aid,
        name: user2Name,
      };
      saveAccounts(accounts);
      console.log(`[Test] Saved member2 account: ${user2Name} (${member2Aid.slice(0, 12)}...)`);

      console.log('[Test] PASS - User2 registered and approved, account saved');
    } finally {
      await user2Context?.close();
      await user1Context?.close();
      await backends.stop('user2-approve');
      await backends.stop('user1-endorse');
    }
  });

  // ------------------------------------------------------------------
  // Test 3: Admin declines user registration
  // ------------------------------------------------------------------
  test('admin declines user registration', async ({ browser }) => {
    console.log('[Test] Starting decline test...');

    // Wrap browser setup in a 15s timeout to fail fast if something hangs
    const setupTimeout = 15_000;
    const startTime = Date.now();

    const setupWithTimeout = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      const elapsed = Date.now() - startTime;
      const remaining = setupTimeout - elapsed;
      if (remaining <= 0) {
        throw new Error(`[Test] Setup timeout: ${name} - took longer than ${setupTimeout}ms total`);
      }
      console.log(`[Test] ${name}...`);
      const result = await Promise.race([
        fn(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`[Test] ${name} timed out after ${remaining}ms`)), remaining)
        ),
      ]);
      console.log(`[Test] ${name} done (${Date.now() - startTime}ms elapsed)`);
      return result;
    };

    const userBackend = await setupWithTimeout('Starting backend', () => backends.start('user-decline'));
    const userContext = await setupWithTimeout('Creating browser context', () => browser.newContext());
    await setupWithTimeout('Setting up test config', () => setupTestConfig(userContext));
    await setupWithTimeout('Setting up backend routing', () => setupBackendRouting(userContext, userBackend.port));
    const userPage = await setupWithTimeout('Creating new page', () => userContext.newPage());

    setupPageLogging(userPage, 'User-Decline');

    const userName = `Decline_${uniqueSuffix()}`;
    console.log(`[Test] Starting registration for ${userName}...`);

    try {
      // User registers (on their own backend)
      await registerUser(userPage, userName);

      // Wait for admin to see pending member in New Members card
      const membersCard = adminPage.locator('.members-card');
      const pendingMemberName = membersCard.locator('.card-name', { hasText: userName });
      await expect(pendingMemberName).toBeVisible({ timeout: TIMEOUT.long });

      // Click on the pending member card to open ProfileModal
      console.log('[Test] Opening profile modal for pending member...');
      const memberProfileCard = membersCard.locator('.profile-card').filter({ hasText: userName });
      await memberProfileCard.click();

      // Verify ProfileModal opens
      const profileModal = adminPage.locator('.modal-content');
      await expect(profileModal).toBeVisible({ timeout: TIMEOUT.short });
      await expect(profileModal.locator('h4').first()).toContainText(userName, { timeout: TIMEOUT.short });

      // Click "Decline" button in the modal
      console.log('[Test] Admin clicking decline...');
      const declineBtn = profileModal.getByRole('button', { name: /^Decline$/i });
      await expect(declineBtn).toBeVisible({ timeout: TIMEOUT.short });
      await declineBtn.click();

      // Fill decline reason and confirm
      const reasonField = profileModal.locator('textarea[placeholder="Provide a reason for declining..."]');
      await expect(reasonField).toBeVisible({ timeout: TIMEOUT.short });
      await reasonField.fill('Declined for testing');
      await profileModal.getByRole('button', { name: /confirm decline/i }).click();

      // User sees rejection
      console.log('[Test] Waiting for user to see rejection...');
      await expect(
        userPage.getByText(/declined|rejected/i).first(),
      ).toBeVisible({ timeout: TIMEOUT.long });
      console.log('[Test] User sees rejection');

      // Test session restart: reload without clearing localStorage
      // This verifies the rejection state persists across sessions
      console.log('[Test] Testing session restart with persisted rejection...');
      await userPage.goto(FRONTEND_URL);

      // Should auto-restore to rejected state (not splash or pending)
      await expect(
        userPage.getByText(/declined|rejected/i).first(),
      ).toBeVisible({ timeout: TIMEOUT.long });
      console.log('[Test] Session restart: rejection state persisted');

      // Splash buttons should NOT be visible
      await expect(
        userPage.getByRole('button', { name: /register/i }),
      ).not.toBeVisible();
      console.log('[Test] Session restart: splash buttons correctly hidden');

      // Should show the "What you can do" support section
      await expect(
        userPage.getByText(/what you can do/i),
      ).toBeVisible({ timeout: TIMEOUT.short });
      console.log('[Test] PASS - Rejection persisted across session restart');
    } finally {
      await userContext.close();
      await backends.stop('user-decline');
    }
  });

  // ------------------------------------------------------------------
  // Test 4: User books a Whakawhānaunga session while pending
  // ------------------------------------------------------------------
  test('user books a Whakawhānaunga session', async ({ browser }) => {
    const userBackend = await backends.start('user-booking');

    const userContext = await browser.newContext();
    await setupTestConfig(userContext);
    await setupBackendRouting(userContext, userBackend.port);
    const userPage = await userContext.newPage();
    setupPageLogging(userPage, 'User-Booking');

    const userName = `Booking_${uniqueSuffix()}`;
    const testEmail = 'ben@matou.nz';

    try {
      // 1. User registers (stays pending, on their own backend)
      await registerUser(userPage, userName);

      // 2. Verify user is on pending approval screen
      await expect(
        userPage.getByText(/application.*review|pending|under review/i).first(),
      ).toBeVisible({ timeout: TIMEOUT.long });
      console.log('[Test] User on pending approval screen');

      // 3. Wait for time slots grid to be visible
      console.log('[Test] Looking for booking time slots...');
      const timeSlotsGrid = userPage.locator('.time-slots-grid');
      await expect(timeSlotsGrid).toBeVisible({ timeout: TIMEOUT.medium });

      // 4. Click the first available time slot
      const timeSlotBtn = timeSlotsGrid.locator('.time-slot-btn').first();
      await expect(timeSlotBtn).toBeVisible({ timeout: TIMEOUT.short });
      await timeSlotBtn.click();
      console.log('[Test] Selected time slot');

      // 5. Email confirmation step should appear
      const emailInput = userPage.locator('#booking-email');
      await expect(emailInput).toBeVisible({ timeout: TIMEOUT.short });
      await emailInput.fill(testEmail);
      console.log('[Test] Filled email:', testEmail);

      // 6. Set up listener for booking API call
      const bookingResponse = userPage.waitForResponse(
        resp => resp.url().includes('/api/v1/booking/send-email') && resp.request().method() === 'POST',
        { timeout: TIMEOUT.medium },
      );

      // 7. Click confirm button
      const confirmBtn = userPage.getByRole('button', { name: /confirm/i });
      await expect(confirmBtn).toBeEnabled({ timeout: TIMEOUT.short });
      await confirmBtn.click();
      console.log('[Test] Clicked confirm');

      // 8. Verify booking API was called successfully
      const bookingResp = await bookingResponse;
      expect(bookingResp.status()).toBe(200);
      const bookingBody = await bookingResp.json();
      expect(bookingBody.success).toBe(true);
      console.log('[Test] Booking API response:', bookingBody);

      // 9. Verify confirmation message appears
      await expect(
        userPage.getByText(/session requested/i),
      ).toBeVisible({ timeout: TIMEOUT.medium });
      console.log('[Test] Booking confirmation displayed');

      // 10. Verify email is shown in confirmation
      await expect(
        userPage.getByText(testEmail),
      ).toBeVisible({ timeout: TIMEOUT.short });

      // 11. Test session restart: booking should persist
      console.log('[Test] Testing session restart with persisted booking...');
      await userPage.goto(FRONTEND_URL);

      // Should auto-restore to pending-approval with booking still shown
      await expect(
        userPage.getByText(/session requested/i),
      ).toBeVisible({ timeout: TIMEOUT.long });
      await expect(
        userPage.getByText(testEmail),
      ).toBeVisible({ timeout: TIMEOUT.short });
      console.log('[Test] PASS - Booking persisted across session restart');
    } finally {
      await userContext.close();
      await backends.stop('user-booking');
    }
  });

});
