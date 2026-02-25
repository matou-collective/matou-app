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
  TestAccounts,
} from './utils/test-helpers';

/**
 * E2E: Member Removal Flow
 *
 * Tests that an admin can approve a new member then remove them.
 * Requires test-accounts.json from a prior registration test run
 * (needs admin + existing member for the 3-requirement approval flow).
 *
 * Test 1: Register a new member, complete all requirements, admin approves
 * Test 2: Admin removes the approved member — soft-delete profiles
 *
 * Run: npx playwright test --project=member-removal
 */

test.describe.serial('Member Removal', () => {
  let accounts: TestAccounts;
  let adminContext: BrowserContext;
  let adminPage: Page;
  const backends = new BackendManager();

  // Member info saved by Test 1 for Test 2
  let memberToRemove: { name: string; aid: string } | null = null;

  test.beforeAll(async ({ browser }) => {
    await requireAllTestServices();

    accounts = loadAccounts();
    if (!accounts.admin?.mnemonic) {
      throw new Error(
        'No admin mnemonic in test-accounts.json. Run registration tests first.',
      );
    }
    if (!accounts.member?.mnemonic) {
      throw new Error(
        'No member mnemonic in test-accounts.json. Run registration tests first (Test 1 creates member).',
      );
    }

    // Set up admin context — uses default backend on port 9080
    adminContext = await browser.newContext();
    await setupTestConfig(adminContext);
    adminPage = await adminContext.newPage();
    setupPageLogging(adminPage, 'Admin');

    await loginWithMnemonic(adminPage, accounts.admin.mnemonic);
    console.log('[Test] Admin logged in and on dashboard');
  });

  test.afterAll(async () => {
    await backends.stopAll();
    await adminContext?.close();
  });

  // ------------------------------------------------------------------
  // Test 1: Register and approve a new member (for removal in Test 2)
  // ------------------------------------------------------------------
  test('register and approve a new member', async ({ browser }) => {
    test.setTimeout(360_000); // 6 min

    // --- Set up new member ---
    const newMemberBackend = await backends.start('new-member');
    const newMemberContext = await browser.newContext();
    await setupTestConfig(newMemberContext);
    await setupBackendRouting(newMemberContext, newMemberBackend.port);
    const newMemberPage = await newMemberContext.newPage();
    setupPageLogging(newMemberPage, 'NewMember');

    const newMemberName = `Remove_${uniqueSuffix()}`;

    // --- Set up existing member (for member endorsement) ---
    const existingMemberBackend = await backends.start('existing-member');
    const existingMemberContext = await browser.newContext();
    await setupTestConfig(existingMemberContext);
    await setupBackendRouting(existingMemberContext, existingMemberBackend.port);
    const existingMemberPage = await existingMemberContext.newPage();
    setupPageLogging(existingMemberPage, 'ExistingMember');

    try {
      // ================================================================
      // A. Register new member
      // ================================================================
      console.log(`[Test] Registering new member: ${newMemberName}`);
      await registerUser(newMemberPage, newMemberName);

      // ================================================================
      // B. Log in existing member
      // ================================================================
      console.log('[Test] Logging in existing member...');
      await loginWithMnemonic(existingMemberPage, accounts.member!.mnemonic);
      console.log('[Test] Existing member on dashboard');

      // ================================================================
      // C. Wait for new member to appear in admin's pending members
      // ================================================================
      console.log('[Test] Waiting for new member in admin members card...');
      const membersCard = adminPage.locator('.members-card');
      const newMemberCardName = membersCard.locator('.card-name', { hasText: newMemberName });
      await expect(newMemberCardName).toBeVisible({ timeout: TIMEOUT.medium });
      console.log('[Test] New member visible in admin members card');

      // ================================================================
      // D. Wait for new member to appear in existing member's list
      // ================================================================
      console.log('[Test] Waiting for new member in existing member list...');
      const existingMembersCard = existingMemberPage.locator('.members-card');
      const newMemberOnExisting = existingMembersCard.locator('.card-name', { hasText: newMemberName });
      await expect(newMemberOnExisting).toBeVisible({ timeout: TIMEOUT.registrationSubmit });
      console.log('[Test] New member visible in existing member list');

      // ================================================================
      // E. Existing member endorses new member (member endorsement)
      // ================================================================
      console.log('[Test] --- Existing member endorsing new member ---');
      const cardOnExisting = existingMembersCard.locator('.profile-card').filter({ hasText: newMemberName });
      await cardOnExisting.click();

      const existingModal = existingMemberPage.locator('.modal-content');
      await expect(existingModal).toBeVisible({ timeout: TIMEOUT.short });
      await expect(existingModal.locator('h4').first()).toContainText(newMemberName, { timeout: TIMEOUT.short });

      const memberEndorseBtn = existingModal.getByRole('button', { name: /^Endorse$/i });
      await expect(memberEndorseBtn).toBeVisible({ timeout: TIMEOUT.short });
      await memberEndorseBtn.click();

      const endorseTextarea = existingModal.locator('textarea[placeholder="Why do you endorse this person?"]');
      await expect(endorseTextarea).toBeVisible({ timeout: TIMEOUT.short });
      await endorseTextarea.fill('Member endorsement for removal test');

      const confirmEndorseBtn = existingModal.getByRole('button', { name: /confirm endorsement/i });
      await expect(confirmEndorseBtn).toBeEnabled({ timeout: TIMEOUT.short });
      await confirmEndorseBtn.click();
      console.log('[Test] Existing member clicked Confirm Endorsement...');

      const endorsedBtn = existingModal.getByRole('button', { name: /^Endorsed$/i });
      await expect(endorsedBtn).toBeVisible({ timeout: TIMEOUT.aidCreation });
      console.log('[Test] Existing member endorsement succeeded');

      // Close modal
      await existingModal.locator('button').filter({ has: existingMemberPage.locator('svg') }).first().click();
      await expect(existingModal).not.toBeVisible({ timeout: TIMEOUT.short });

      // Verify on new member's pending screen
      const requirementsGrid = newMemberPage.locator('.requirements-grid');
      await expect(requirementsGrid).toBeVisible({ timeout: TIMEOUT.short });
      const endorsementCard = requirementsGrid.locator('.requirement-card', { hasText: 'Endorsement' });
      await expect(endorsementCard).toHaveClass(/requirement-met/, { timeout: TIMEOUT.long });
      console.log('[Test] Endorsement requirement met');

      // ================================================================
      // F. Admin endorses new member (steward endorsement / Confirmation)
      // ================================================================
      console.log('[Test] --- Admin endorsing new member ---');
      const adminCard = membersCard.locator('.profile-card').filter({ hasText: newMemberName });
      await adminCard.click();

      const adminModal = adminPage.locator('.modal-content');
      await expect(adminModal).toBeVisible({ timeout: TIMEOUT.short });

      const adminEndorseBtn = adminModal.getByRole('button', { name: /^Endorse$/i });
      await expect(adminEndorseBtn).toBeVisible({ timeout: TIMEOUT.short });
      await adminEndorseBtn.click();

      const adminEndorseTextarea = adminModal.locator('textarea[placeholder="Why do you endorse this person?"]');
      await expect(adminEndorseTextarea).toBeVisible({ timeout: TIMEOUT.short });
      await adminEndorseTextarea.fill('Admin endorsement for removal test');

      const adminConfirmEndorse = adminModal.getByRole('button', { name: /confirm endorsement/i });
      await expect(adminConfirmEndorse).toBeEnabled({ timeout: TIMEOUT.short });
      await adminConfirmEndorse.click();
      console.log('[Test] Admin clicked Confirm Endorsement...');

      const adminEndorsedBtn = adminModal.getByRole('button', { name: /^Endorsed$/i });
      await expect(adminEndorsedBtn).toBeVisible({ timeout: TIMEOUT.aidCreation });
      console.log('[Test] Admin endorsement succeeded');

      // Close modal
      await adminModal.locator('button').filter({ has: adminPage.locator('svg') }).first().click();
      await expect(adminModal).not.toBeVisible({ timeout: TIMEOUT.short });

      // Verify on new member's pending screen
      const confirmationCard = requirementsGrid.locator('.requirement-card', { hasText: 'Confirmation' });
      await expect(confirmationCard).toHaveClass(/requirement-met/, { timeout: TIMEOUT.long });
      console.log('[Test] Confirmation requirement met');

      // ================================================================
      // G. Admin marks attendance (Whakawhanaunga)
      // ================================================================
      console.log('[Test] --- Admin marking attendance ---');
      const attendanceCard = membersCard.locator('.profile-card').filter({ hasText: newMemberName });
      await attendanceCard.click();

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

      // Verify on new member's pending screen
      const whakawhanaunga = requirementsGrid.locator('.requirement-card', { hasText: 'Whakawhanaunga' });
      await expect(whakawhanaunga).toHaveClass(/requirement-met/, { timeout: TIMEOUT.long });
      console.log('[Test] Whakawhanaunga requirement met');

      // ================================================================
      // H. Admin approves
      // ================================================================
      console.log('[Test] --- Admin approving new member ---');
      const approvalCard = membersCard.locator('.profile-card').filter({ hasText: newMemberName });
      await approvalCard.click();

      const approvalModal = adminPage.locator('.modal-content');
      await expect(approvalModal).toBeVisible({ timeout: TIMEOUT.short });

      const approveBtn = approvalModal.getByRole('button', { name: /approve/i });
      await expect(approveBtn).toBeVisible({ timeout: TIMEOUT.short });

      // Set up response listeners
      const joinResponse = newMemberPage.waitForResponse(
        resp => resp.url().includes('/api/v1/spaces/community/join') && resp.request().method() === 'POST',
        { timeout: TIMEOUT.aidCreation },
      );

      await approveBtn.click();
      console.log('[Test] Admin clicked Approve');

      // Verify community join
      const joinResp = await joinResponse;
      expect(joinResp.status()).toBe(200);
      console.log('[Test] New member joined community space');

      // ================================================================
      // I. New member receives credential and enters community
      // ================================================================
      console.log('[Test] Waiting for new member to receive credential...');
      await expect(newMemberPage.locator('.welcome-overlay')).toBeVisible({ timeout: TIMEOUT.long });

      const enterButton = newMemberPage.getByRole('button', { name: /enter community/i });
      await expect(enterButton).toBeEnabled({ timeout: TIMEOUT.long + 30_000 });
      await enterButton.click();
      await expect(newMemberPage).toHaveURL(/#\/dashboard/, { timeout: TIMEOUT.short });
      console.log('[Test] New member on dashboard — approved');

      // Get the new member's AID
      const identityResp = await newMemberPage.request.get(`http://localhost:${newMemberBackend.port}/api/v1/identity`);
      const identityBody = await identityResp.json();
      memberToRemove = {
        name: newMemberName,
        aid: identityBody.aid || '',
      };
      console.log(`[Test] PASS - Member approved: ${memberToRemove.name} (${memberToRemove.aid.slice(0, 12)}...)`);
    } finally {
      await newMemberContext?.close();
      await existingMemberContext?.close();
      await backends.stop('new-member');
      await backends.stop('existing-member');
    }
  });

  // ------------------------------------------------------------------
  // Test 2: Admin removes the approved member
  // ------------------------------------------------------------------
  test('admin removes the approved member', async () => {
    test.setTimeout(120_000); // 2 min

    if (!memberToRemove) {
      test.skip(true, 'Test 1 must run first to create member');
      return;
    }

    console.log(`[Test] Removing member: ${memberToRemove.name} (${memberToRemove.aid.slice(0, 12)}...)`);

    // Navigate admin to dashboard
    await adminPage.goto(`${FRONTEND_URL}/#/dashboard`);
    const membersCard = adminPage.locator('.members-card');
    await expect(membersCard).toBeVisible({ timeout: TIMEOUT.short });

    // Find the member in the member list
    const memberCard = membersCard.locator('.profile-card').filter({ hasText: memberToRemove.name });
    await expect(memberCard).toBeVisible({ timeout: TIMEOUT.medium });
    console.log('[Test] Member visible in member list');

    // Open ProfileModal
    await memberCard.click();
    const profileModal = adminPage.locator('.modal-content');
    await expect(profileModal).toBeVisible({ timeout: TIMEOUT.short });
    await expect(profileModal.locator('h4').first()).toContainText(memberToRemove.name, { timeout: TIMEOUT.short });
    console.log('[Test] ProfileModal opened');

    // Verify "Remove Member" button is visible
    const removeBtn = profileModal.getByRole('button', { name: /remove member/i });
    await expect(removeBtn).toBeVisible({ timeout: TIMEOUT.short });
    console.log('[Test] Remove Member button visible');

    // Click "Remove Member" to show confirmation
    await removeBtn.click();

    // Fill optional reason
    const reasonField = profileModal.locator('textarea[placeholder="Provide a reason for removing this member..."]');
    await expect(reasonField).toBeVisible({ timeout: TIMEOUT.short });
    await reasonField.fill('Removed for E2E testing');
    console.log('[Test] Filled removal reason');

    // Set up response listener for the DELETE API call
    const removeResponse = adminPage.waitForResponse(
      resp => resp.url().includes('/api/v1/members/') && resp.request().method() === 'DELETE',
      { timeout: TIMEOUT.long },
    );

    // Click "Confirm Removal"
    const confirmBtn = profileModal.getByRole('button', { name: /confirm removal/i });
    await expect(confirmBtn).toBeEnabled({ timeout: TIMEOUT.short });
    await confirmBtn.click();
    console.log('[Test] Clicked Confirm Removal');

    // Verify DELETE API call succeeded
    const removeResp = await removeResponse;
    expect(removeResp.status()).toBe(200);
    const removeBody = await removeResp.json();
    expect(removeBody.success).toBe('true');
    expect(removeBody.memberAid).toBeTruthy();
    console.log('[Test] Remove member API succeeded:', removeBody);

    // Modal should close after successful removal
    await expect(profileModal).not.toBeVisible({ timeout: TIMEOUT.short });
    console.log('[Test] ProfileModal closed after removal');

    // Verify the member no longer appears in the member list
    await expect(memberCard).not.toBeVisible({ timeout: TIMEOUT.medium });
    console.log('[Test] Removed member no longer visible in member list');

    // Verify via API that the SharedProfile has status 'removed'
    const expectedSharedId = `SharedProfile-${memberToRemove.aid}`;
    const profilesResp = await adminPage.request.get('http://localhost:9080/api/v1/profiles/SharedProfile');
    const profiles = await profilesResp.json();
    const profileList = (profiles.profiles ?? []) as Array<{ id: string; data: Record<string, unknown> }>;
    const removedProfile = profileList.find(p => p.id === expectedSharedId);
    expect(removedProfile, 'SharedProfile should still exist for removed member').toBeTruthy();
    expect(removedProfile!.data.status).toBe('removed');
    expect(removedProfile!.data.removedAt).toBeTruthy();
    console.log('[Test] SharedProfile status confirmed as "removed" via API');

    // Verify CommunityProfile also has status 'removed'
    const expectedCPId = `CommunityProfile-${memberToRemove.aid}`;
    const cpResp = await adminPage.request.get('http://localhost:9080/api/v1/profiles/CommunityProfile');
    const cpProfiles = await cpResp.json();
    const cpList = (cpProfiles.profiles ?? []) as Array<{ id: string; data: Record<string, unknown> }>;
    const removedCP = cpList.find(p => p.id === expectedCPId);
    expect(removedCP, 'CommunityProfile should still exist for removed member').toBeTruthy();
    expect(removedCP!.data.status).toBe('removed');
    expect(removedCP!.data.removedBy).toBeTruthy();
    expect(removedCP!.data.removalReason).toBe('Removed for E2E testing');
    console.log('[Test] CommunityProfile status confirmed as "removed" via API');

    console.log('[Test] PASS - Admin removed member, profiles soft-deleted, member filtered from list');
  });
});
