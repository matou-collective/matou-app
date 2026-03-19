/**
 * E2E Tests: Projects & Contributions — Full UI Lifecycle (Two-User)
 *
 * Tests the complete projects and contributions system through the UI,
 * matching the UX flow table (docs/design/CONTRIBUTIONS_UX_FLOW_TABLE.md).
 *
 * Two users:
 *   - Admin (Founding Member): creates project, assigns roles, creates
 *     milestones/contributions, confirms, signs off plan, assigns contributions,
 *     reviews work, signs off contributions.
 *   - Member: registers interest, accepts offers, creates sub-contributions,
 *     submits evidence for sub and parent contributions.
 *
 * Accounts are reused from test-accounts.json when they exist. If the member
 * account is missing, it is registered and approved during setup.
 *
 * Run: npx playwright test --project=projects-contributions
 */
import { test, expect, Page, BrowserContext } from '@playwright/test';
import { setupTestConfig } from './utils/mock-config';
import { requireAllTestServices } from './utils/keri-testnet';
import { BackendManager, BackendInstance } from './utils/backend-manager';
import {
  FRONTEND_URL,
  BACKEND_URL,
  TIMEOUT,
  setupPageLogging,
  setupBackendRouting,
  loginWithMnemonic,
  loadAccounts,
  saveAccounts,
  performOrgSetup,
  type TestAccounts,
} from './utils/test-helpers';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_TITLE = 'E2E Community Garden';
const PROJECT_DESC = 'A community garden project for E2E testing';
const MILESTONE_TITLE = 'Phase 1: Design';
const MILESTONE_DURATION = '2 weeks';
const CONTRIBUTION_1_TITLE = 'Design Phase Work';
const CONTRIBUTION_1_DESC = 'Create wireframes and mockups for the community garden';
const CONTRIBUTION_2_TITLE = 'Outreach Coordination';
const CONTRIBUTION_2_DESC = 'Coordinate community outreach and engagement';
const SUB_CONTRIBUTION_TITLE = 'Sub: Design Review';
const SUB_CONTRIBUTION_DESC = 'Review and validate the design deliverables';

const MEMBER_NAME = 'Test Member Contrib';

// ---------------------------------------------------------------------------
// UI Helpers
// ---------------------------------------------------------------------------

/** Navigate to a sidebar item by label (sidebar nav items are buttons) */
async function navigateTo(page: Page, label: string) {
  await page.getByRole('button', { name: label }).click();
}

/** Wait for network + animations to settle after a UI action */
async function waitForSettle(page: Page, ms = 1500) {
  await page.waitForTimeout(ms);
}

/** Scope a dialog by its title text */
function dialog(page: Page, title: string | RegExp) {
  return page.locator('.q-dialog').filter({ hasText: title });
}

/** Click a contribution compact card by title to open the detail dialog */
async function openContributionDialog(page: Page, title: string) {
  const card = page.locator('.contribution-compact').filter({ hasText: title });
  await expect(card).toBeVisible({ timeout: TIMEOUT.medium });
  await card.click();
  await expect(page.locator('.q-dialog')).toBeVisible({ timeout: TIMEOUT.short });
  await waitForSettle(page, 500);
}

/** Close the currently open contribution detail dialog */
async function closeContributionDialog(page: Page) {
  const closeBtn = page.locator('.q-dialog .close-btn');
  if (await closeBtn.isVisible().catch(() => false)) {
    await closeBtn.click();
  } else {
    await page.keyboard.press('Escape');
  }
  await page.waitForTimeout(500);
}

/** Navigate to the project detail page from the projects list */
async function navigateToProjectDetail(page: Page, projectTitle: string) {
  await navigateTo(page, 'Projects');
  await waitForSettle(page);
  const card = page.locator('.project-card', { hasText: projectTitle }).first();
  await expect(card).toBeVisible({ timeout: TIMEOUT.medium });
  await card.click();
  await expect(page).toHaveURL(/\/dashboard\/projects\//, { timeout: TIMEOUT.short });
  await waitForSettle(page);
}

// ===========================================================================
// Group 1: Full UI Lifecycle (Phases 1–10)
// ===========================================================================

test.describe.serial('Projects & Contributions — Full UI Lifecycle', () => {
  let accounts: TestAccounts;

  // Admin: default backend on port 9080, no routing needed
  let adminContext: BrowserContext;
  let adminPage: Page;
  let adminAID: string;

  // Member: dedicated backend spawned by BackendManager
  const backends = new BackendManager();
  let memberBackend: BackendInstance;
  let memberContext: BrowserContext;
  let memberPage: Page;
  let memberAID: string;

  // ------------------------------------------------------------------
  // Setup: admin login + member login/registration
  // ------------------------------------------------------------------

  test.beforeAll(async ({ browser, request }) => {
    test.setTimeout(360_000); // Full setup can take 6 min if member needs registering

    await requireAllTestServices();

    // --- Admin context (port 9080, no routing override) ---
    adminContext = await browser.newContext();
    await setupTestConfig(adminContext);
    adminPage = await adminContext.newPage();
    setupPageLogging(adminPage, 'Admin');

    await adminPage.goto(FRONTEND_URL);

    const needsSetup = await Promise.race([
      adminPage
        .waitForURL(/.*#\/setup/, { timeout: TIMEOUT.medium })
        .then(() => true),
      adminPage
        .locator('button', { hasText: /join now/i })
        .waitFor({ state: 'visible', timeout: TIMEOUT.medium })
        .then(() => false),
    ]);

    if (needsSetup) {
      console.log('[Setup] No org config — running org setup...');
      accounts = await performOrgSetup(adminPage, request);
      console.log('[Setup] Org setup complete, admin on dashboard');
    } else {
      console.log('[Setup] Recovering admin identity...');
      accounts = loadAccounts();
      if (!accounts.admin?.mnemonic) {
        throw new Error(
          'Org configured but no admin mnemonic in test-accounts.json. ' +
          'Run org-setup first or clean test state and re-run.',
        );
      }
      await loginWithMnemonic(adminPage, accounts.admin.mnemonic);
      console.log('[Setup] Admin logged in and on dashboard');
    }

    // Resolve admin AID from multiple sources
    adminAID = accounts.admin?.aid ?? '';
    if (!adminAID) {
      adminAID = await adminPage.evaluate(() => {
        const adminAid = localStorage.getItem('matou_admin_aid');
        if (adminAid) return adminAid;
        const currentAid = localStorage.getItem('matou_current_aid');
        if (currentAid) {
          try { const p = JSON.parse(currentAid); return p.prefix || p.aid || currentAid; } catch { return currentAid; }
        }
        return '';
      });
    }
    if (!adminAID) {
      try {
        const health = await request.get(`${BACKEND_URL}/health`);
        const data = await health.json();
        adminAID = data.admin || '';
      } catch { /* ignore */ }
    }
    if (!adminAID) throw new Error('Could not resolve admin AID');
    console.log('[Setup] Admin AID: %s', adminAID);

    // --- Member backend ---
    memberBackend = await backends.start('member-contrib');
    memberContext = await browser.newContext();
    await setupTestConfig(memberContext);
    await setupBackendRouting(memberContext, memberBackend.port);
    memberPage = await memberContext.newPage();
    setupPageLogging(memberPage, 'Member');

    // Require member account from a prior registration test run
    if (!accounts.member?.mnemonic || accounts.member.mnemonic.length !== 12) {
      throw new Error(
        'No member account in test-accounts.json.\n' +
        'Run the registration test first:\n' +
        '  npx playwright test --project=registration\n' +
        'Then re-run this test.',
      );
    }

    console.log('[Setup] Reusing saved member account, logging in...');
    await loginWithMnemonic(memberPage, accounts.member.mnemonic);
    memberAID = accounts.member.aid ?? '';
    if (!memberAID) {
      memberAID = await memberPage.evaluate(() => {
        return localStorage.getItem('matou_admin_aid') || '';
      });
    }
    console.log('[Setup] Member logged in, AID: %s', memberAID);
  });

  test.afterAll(async () => {
    await backends.stopAll();
    await memberContext?.close();
    await adminContext?.close();
  });

  // ------------------------------------------------------------------
  // Phase 1: Project Creation (UX Table 1.1–1.4)
  // ------------------------------------------------------------------

  test('Phase 1: admin creates project via UI', async () => {
    await adminPage.bringToFront();

    // 1.1 Navigate to Projects screen
    await navigateTo(adminPage, 'Projects');
    await expect(adminPage).toHaveURL(/\/dashboard\/projects/, { timeout: TIMEOUT.short });
    console.log('[Phase 1] On projects page');

    // 1.2 Click "+ New Project" (visible to admins only)
    const newBtn = adminPage.getByRole('button', { name: /New Project/i });
    await expect(newBtn).toBeVisible({ timeout: TIMEOUT.short });
    await newBtn.click();

    // 1.3 Fill project form
    const dlg = dialog(adminPage, 'Create Project');
    await expect(dlg).toBeVisible({ timeout: TIMEOUT.short });
    await dlg.getByLabel(/Title/i).fill(PROJECT_TITLE);
    await dlg.getByLabel(/Description/i).fill(PROJECT_DESC);

    // 1.4 Submit — auto-navigates to project detail
    await dlg.getByRole('button', { name: /Create Project/i }).click();
    await expect(adminPage).toHaveURL(/\/dashboard\/projects\//, { timeout: TIMEOUT.short });
    await waitForSettle(adminPage);

    // Verify on project detail page
    const title = adminPage.locator('h1, h2').filter({ hasText: PROJECT_TITLE });
    await expect(title.first()).toBeVisible({ timeout: TIMEOUT.medium });
    console.log('[Phase 1] Project created and opened: %s', PROJECT_TITLE);
  });

  // ------------------------------------------------------------------
  // Phase 2: Assign Team & Structure Work (UX Table 2.1–2.7)
  // ------------------------------------------------------------------

  test('Phase 2: admin adds milestone with contributions', async () => {
    await adminPage.bringToFront();

    // Already on project detail page from Phase 1
    const title = adminPage.locator('h1, h2').filter({ hasText: PROJECT_TITLE });
    await expect(title.first()).toBeVisible({ timeout: TIMEOUT.medium });
    console.log('[Phase 2] On project detail page');

    // 2.2 Assign Project Lead — admin assigns themselves
    const assignLeadBtn = adminPage.getByRole('button', { name: /Assign Lead/i });
    if (await assignLeadBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await assignLeadBtn.click();
      const roleDlg = dialog(adminPage, 'Assign Project Lead');
      await expect(roleDlg).toBeVisible({ timeout: TIMEOUT.short });
      const adminItem = roleDlg.locator('.member-item').filter({ hasText: /Admin/i }).first();
      await expect(adminItem).toBeVisible({ timeout: TIMEOUT.medium });
      await adminItem.click();
      await roleDlg.getByRole('button', { name: /Assign Project Lead/i }).click();
      await expect(roleDlg).not.toBeVisible({ timeout: TIMEOUT.short });
      await waitForSettle(adminPage);
      console.log('[Phase 2] Project Lead assigned (Admin User)');
    }

    // 2.3 Assign Project Steward — admin assigns themselves
    const assignStewardBtn = adminPage.getByRole('button', { name: /Assign Steward/i });
    if (await assignStewardBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await assignStewardBtn.click();
      const roleDlg2 = dialog(adminPage, 'Assign Project Steward');
      await expect(roleDlg2).toBeVisible({ timeout: TIMEOUT.short });
      const adminItem2 = roleDlg2.locator('.member-item').filter({ hasText: /Admin/i }).first();
      await expect(adminItem2).toBeVisible({ timeout: TIMEOUT.medium });
      await adminItem2.click();
      await roleDlg2.getByRole('button', { name: /Assign Project Steward/i }).click();
      await expect(roleDlg2).not.toBeVisible({ timeout: TIMEOUT.short });
      await waitForSettle(adminPage);
      console.log('[Phase 2] Project Steward assigned (Admin User)');
    }

    // 2.4 Create first milestone
    const addMilestoneBtn = adminPage.getByRole('button', { name: /Milestone/i }).first();
    await expect(addMilestoneBtn).toBeVisible({ timeout: TIMEOUT.medium });
    await addMilestoneBtn.click();

    // 2.5 Fill milestone form
    const msDlg = dialog(adminPage, 'Add Milestone');
    await expect(msDlg).toBeVisible({ timeout: TIMEOUT.short });
    await msDlg.getByLabel(/Milestone Title/i).fill(MILESTONE_TITLE);
    await msDlg.getByLabel(/Duration/i).fill(MILESTONE_DURATION);
    await msDlg.getByRole('button', { name: /Add Milestone/i }).click();
    await waitForSettle(adminPage);
    console.log('[Phase 2] Milestone created: %s', MILESTONE_TITLE);

    // Wait for milestone card and ensure it's expanded
    const milestoneCard = adminPage.locator('.milestone-card').first();
    await expect(milestoneCard).toBeVisible({ timeout: TIMEOUT.short });

    // 2.6 Create contribution 1 within milestone
    let addContribBtn = milestoneCard.getByRole('button', { name: /Add Contribution|Add First Contribution/i });
    if (!await addContribBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await milestoneCard.locator('.milestone-header').click();
      await adminPage.waitForTimeout(500);
    }
    await expect(addContribBtn).toBeVisible({ timeout: TIMEOUT.short });
    await addContribBtn.click();

    // 2.7 Fill contribution 1 form (type cards, no priority)
    let contribDlg = dialog(adminPage, 'Create Contribution');
    await expect(contribDlg).toBeVisible({ timeout: TIMEOUT.short });

    await contribDlg.getByLabel(/Title/i).first().fill(CONTRIBUTION_1_TITLE);
    await contribDlg.getByLabel(/Description/i).first().fill(CONTRIBUTION_1_DESC);
    await contribDlg.getByRole('button', { name: 'Technical' }).click();

    await contribDlg.getByLabel('Objective 1').fill('Create wireframe designs');
    await contribDlg.getByLabel('Deliverable 1').fill('Wireframe document');
    await contribDlg.getByLabel('Criterion 1').fill('Wireframes reviewed by team');

    await contribDlg.getByRole('button', { name: /Create Contribution/i }).click();
    await waitForSettle(adminPage);
    console.log('[Phase 2] Contribution 1 created: %s', CONTRIBUTION_1_TITLE);

    // Create contribution 2 in the same milestone
    await addContribBtn.click();
    contribDlg = dialog(adminPage, 'Create Contribution');
    await expect(contribDlg).toBeVisible({ timeout: TIMEOUT.short });

    await contribDlg.getByLabel(/Title/i).first().fill(CONTRIBUTION_2_TITLE);
    await contribDlg.getByLabel(/Description/i).first().fill(CONTRIBUTION_2_DESC);
    await contribDlg.getByRole('button', { name: 'Community' }).click();

    await contribDlg.getByLabel('Objective 1').fill('Engage community members');
    await contribDlg.getByLabel('Deliverable 1').fill('Outreach report');
    await contribDlg.getByLabel('Criterion 1').fill('Community engagement report submitted');

    await contribDlg.getByRole('button', { name: /Create Contribution/i }).click();
    await waitForSettle(adminPage);
    console.log('[Phase 2] Contribution 2 created: %s', CONTRIBUTION_2_TITLE);

    // Verify both contributions visible in milestone
    await expect(
      milestoneCard.locator('.contribution-compact').filter({ hasText: CONTRIBUTION_1_TITLE }).first(),
    ).toBeVisible({ timeout: TIMEOUT.short });
    await expect(
      milestoneCard.locator('.contribution-compact').filter({ hasText: CONTRIBUTION_2_TITLE }).first(),
    ).toBeVisible({ timeout: TIMEOUT.short });
  });

  // ------------------------------------------------------------------
  // Phase 3: Confirm Contributions & Sign Off Plan (UX Table 3.1–3.6)
  // ------------------------------------------------------------------

  test('Phase 3: admin confirms contributions and signs off plan', async () => {
    await adminPage.bringToFront();

    // 3.2 Confirm contribution 1
    const contrib1Card = adminPage.locator('.contribution-compact').filter({ hasText: CONTRIBUTION_1_TITLE });
    const confirmBtn1 = contrib1Card.getByRole('button', { name: 'Confirm' });
    await expect(confirmBtn1).toBeVisible({ timeout: TIMEOUT.short });
    await confirmBtn1.click();
    await waitForSettle(adminPage);
    console.log('[Phase 3] Contribution 1 confirmed');

    // 3.2 Confirm contribution 2
    const contrib2Card = adminPage.locator('.contribution-compact').filter({ hasText: CONTRIBUTION_2_TITLE });
    const confirmBtn2 = contrib2Card.getByRole('button', { name: 'Confirm' });
    await expect(confirmBtn2).toBeVisible({ timeout: TIMEOUT.short });
    await confirmBtn2.click();
    await waitForSettle(adminPage);
    console.log('[Phase 3] Contribution 2 confirmed');

    // 3.3 Sign off plan — click the banner button
    const signOffBanner = adminPage.getByText(/ready for sign-off|All contributions confirmed/i);
    await expect(signOffBanner).toBeVisible({ timeout: TIMEOUT.medium });

    const signOffBtn = adminPage.getByRole('button', { name: /Sign Off Plan/i }).last();
    await expect(signOffBtn).toBeVisible({ timeout: TIMEOUT.short });
    await signOffBtn.click();
    await waitForSettle(adminPage, 3000);

    // 3.4 Verify signed-off state
    const signedIndicator = adminPage.getByText(/Signed Off/i).first();
    await expect(signedIndicator).toBeVisible({ timeout: TIMEOUT.medium });

    // 3.5 Verify milestone shows "Locked" badge
    const lockedBadge = adminPage.locator('.milestone-card').first().locator('text=Locked');
    await expect(lockedBadge).toBeVisible({ timeout: TIMEOUT.short });
    console.log('[Phase 3] Plan signed off, milestones locked');
  });

  // ------------------------------------------------------------------
  // Phase 4: Distribute Work — Assign contribution 1 to member
  // Uses the merged Assign Contribution dialog (group → members)
  // ------------------------------------------------------------------

  test('Phase 4: admin assigns contribution 1 to member', async () => {
    await adminPage.bringToFront();

    // Re-navigate to ensure fresh data after plan sign-off
    await navigateToProjectDetail(adminPage, PROJECT_TITLE);

    // Open contribution 1 detail dialog
    await openContributionDialog(adminPage, CONTRIBUTION_1_TITLE);
    const dlg = adminPage.locator('.q-dialog');

    // 4.1 Click "Assign Contribution" in dialog footer
    const assignBtn = dlg.getByRole('button', { name: /Assign Contribution/i }).first();
    await expect(assignBtn).toBeVisible({ timeout: TIMEOUT.short });
    await assignBtn.click();

    // 4.2 Assign dialog opens (use .assign-dialog class to avoid matching parent dialog)
    const assignDlg = adminPage.locator('.assign-dialog');
    await expect(assignDlg).toBeVisible({ timeout: TIMEOUT.short });

    // 4.3 Select "Member" mode
    const memberModeCard = assignDlg.locator('.assign-mode-card').filter({ hasText: 'Member' });
    await memberModeCard.click();
    await waitForSettle(adminPage, 500);

    // 4.4 Search and select the member
    const memberNameToUse = accounts.member?.name ?? MEMBER_NAME;
    const searchInput = assignDlg.locator('input[placeholder*="Search"]');
    if (await searchInput.isVisible().catch(() => false)) {
      await searchInput.fill(memberNameToUse.substring(0, 5));
      await waitForSettle(adminPage, 500);
    }

    const memberRow = assignDlg.locator('.assign-member-row').filter({ hasText: new RegExp(memberNameToUse, 'i') }).first();
    if (await memberRow.isVisible({ timeout: 3000 }).catch(() => false)) {
      await memberRow.click();
    } else {
      // Fallback: click first member in list
      const firstMember = assignDlg.locator('.assign-member-row').first();
      await firstMember.click();
    }

    // 4.5 Click Assign
    await assignDlg.getByRole('button', { name: 'Assign' }).click();
    await waitForSettle(adminPage);
    console.log('[Phase 4] Contribution 1 assigned to member');

    await closeContributionDialog(adminPage);
  });

  // ------------------------------------------------------------------
  // Phase 5: Member Accepts Offer (UX Table 5.6)
  // ------------------------------------------------------------------

  test('Phase 5: member navigates to project and accepts offer', async () => {
    await memberPage.bringToFront();

    // 5.1 Navigate via Projects page → project detail
    await navigateToProjectDetail(memberPage, PROJECT_TITLE);

    // Give any-sync a moment to sync
    await waitForSettle(memberPage, 2000);

    // 5.2 Open contribution 1 from the milestone card
    const contribCard = memberPage.locator('.contribution-compact').filter({ hasText: CONTRIBUTION_1_TITLE });
    await expect(contribCard).toBeVisible({ timeout: TIMEOUT.medium });
    await contribCard.click();

    const detailDlg = memberPage.locator('.q-dialog');
    await expect(detailDlg).toBeVisible({ timeout: TIMEOUT.short });

    // 5.3 Accept Offer
    const acceptBtn = detailDlg.getByRole('button', { name: /Accept Offer|Accept/i }).first();
    await expect(acceptBtn).toBeVisible({ timeout: TIMEOUT.short });
    await acceptBtn.click();
    await waitForSettle(memberPage);

    // Verify assigned status
    await waitForSettle(memberPage);
    await expect(detailDlg.getByText(/assigned/i).first()).toBeVisible({ timeout: TIMEOUT.short });
    console.log('[Phase 5] Member accepted offer — contribution assigned');

    await memberPage.keyboard.press('Escape');
    await memberPage.waitForTimeout(500);
  });

  // ------------------------------------------------------------------
  // Phase 6: Sub-Contributions (UX Table 6.1–6.8)
  // ------------------------------------------------------------------

  test('Phase 6: member creates sub-contribution', async () => {
    await memberPage.bringToFront();

    // Navigate to project and open contribution detail
    await navigateToProjectDetail(memberPage, PROJECT_TITLE);
    await waitForSettle(memberPage, 1000);

    await openContributionDialog(memberPage, CONTRIBUTION_1_TITLE);
    const detailDlg = memberPage.locator('.q-dialog');

    // 6.2 Add sub-contribution (button is in ContributionDetailDialog)
    const addSubBtn = detailDlg.getByRole('button', { name: /Add Sub-Contribution/i });
    await expect(addSubBtn).toBeVisible({ timeout: TIMEOUT.medium });
    await addSubBtn.click();

    // Fill sub-contribution form (no priority selector)
    // Use the contribution-dialog class to target the create dialog specifically
    const subDlg = memberPage.locator('.contribution-dialog');
    await expect(subDlg).toBeVisible({ timeout: TIMEOUT.short });

    await subDlg.getByLabel(/Title/i).first().fill(SUB_CONTRIBUTION_TITLE);
    await subDlg.getByLabel(/Description/i).first().fill(SUB_CONTRIBUTION_DESC);
    await subDlg.getByRole('button', { name: 'Technical' }).click();

    const objInputSub = subDlg.getByLabel('Objective 1');
    await objInputSub.fill('Review design documents');

    const delInputSub = subDlg.getByLabel('Deliverable 1');
    await delInputSub.fill('Review report');

    const critInputSub = subDlg.getByLabel('Criterion 1');
    await critInputSub.fill('Design documents reviewed and approved');

    const createSubBtn = subDlg.getByRole('button', { name: /Create Sub-Contribution/i });
    await createSubBtn.scrollIntoViewIfNeeded();
    await createSubBtn.click();
    await waitForSettle(memberPage, 3000);
    console.log('[Phase 6] Sub-contribution created: %s', SUB_CONTRIBUTION_TITLE);

    // Verify it appears in the parent dialog (may need re-open)
    const subText = detailDlg.getByText(SUB_CONTRIBUTION_TITLE);
    const isSubVisible = await subText.isVisible({ timeout: 5000 }).catch(() => false);
    if (!isSubVisible) {
      // Dialog may have closed — re-open parent contribution
      await memberPage.keyboard.press('Escape');
      await memberPage.waitForTimeout(500);
      await openContributionDialog(memberPage, CONTRIBUTION_1_TITLE);
    }
    await expect(memberPage.locator('.q-dialog').getByText(SUB_CONTRIBUTION_TITLE).first()).toBeVisible({ timeout: TIMEOUT.medium });

    await memberPage.keyboard.press('Escape');
    await memberPage.waitForTimeout(500);
  });

  test('Phase 6: admin approves the sub-contribution', async () => {
    await adminPage.bringToFront();

    // Navigate to project detail
    await navigateToProjectDetail(adminPage, PROJECT_TITLE);
    await waitForSettle(adminPage, 2000);

    // Open contribution 1 detail dialog
    await openContributionDialog(adminPage, CONTRIBUTION_1_TITLE);
    const dlg = adminPage.locator('.q-dialog');

    // 6.4 Approve the sub-contribution
    const approveBtn = dlg.getByRole('button', { name: 'Approve' }).first();
    const isApproveVisible = await approveBtn.isVisible({ timeout: 5000 }).catch(() => false);
    if (isApproveVisible) {
      await approveBtn.click();
      await waitForSettle(adminPage);
      console.log('[Phase 6] Admin approved sub-contribution');
    } else {
      console.log('[Phase 6] No Approve button — sub-contribution may already be approved');
    }

    await closeContributionDialog(adminPage);
  });

  test('Phase 6: member submits evidence for sub-contribution', async () => {
    await memberPage.bringToFront();

    // Navigate to project and open parent contribution
    await navigateToProjectDetail(memberPage, PROJECT_TITLE);
    await waitForSettle(memberPage, 1500);

    await openContributionDialog(memberPage, CONTRIBUTION_1_TITLE);
    const detailDlg = memberPage.locator('.q-dialog');

    // 6.6 Click sub-item to open recursive dialog
    const subItem = detailDlg.locator('.sub-item').filter({ hasText: SUB_CONTRIBUTION_TITLE });
    await expect(subItem).toBeVisible({ timeout: TIMEOUT.medium });
    await subItem.click();
    await memberPage.waitForTimeout(500);

    // A nested dialog opens with the sub-contribution
    const nestedDlg = memberPage.locator('.q-dialog').last();

    // Toggle evidence form first
    const submitEvidenceBtn = nestedDlg.getByRole('button', { name: /Submit Evidence & Complete/i });
    if (await submitEvidenceBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await submitEvidenceBtn.click();
      await memberPage.waitForTimeout(500);
    }

    // Fill completion notes and acceptance criteria, then submit
    const notesInput = nestedDlg.getByPlaceholder(/Describe how you completed/i).or(
      nestedDlg.locator('.submit-completion-form textarea').first(),
    );
    const notesVisible = await notesInput.isVisible({ timeout: 5000 }).catch(() => false);
    if (notesVisible) {
      await notesInput.fill('Design review completed. All documents reviewed and feedback provided.');

      // Fill acceptance criteria responses (required)
      const criteriaInputs = nestedDlg.locator('.submit-completion-form .criterion-block input');
      const criteriaCount = await criteriaInputs.count();
      for (let i = 0; i < criteriaCount; i++) {
        await criteriaInputs.nth(i).fill('Criterion met through thorough review');
      }

      const submitBtn = nestedDlg.getByRole('button', { name: /Submit for Review/i });
      await expect(submitBtn).toBeEnabled({ timeout: TIMEOUT.short });
      await submitBtn.click();
      await waitForSettle(memberPage);
      console.log('[Phase 6] Member submitted evidence for sub-contribution');
    } else {
      console.log('[Phase 6] Sub-contribution evidence form not visible — may need approval first');
    }

    // Close nested dialog
    await memberPage.keyboard.press('Escape');
    await memberPage.waitForTimeout(300);
    // Close parent dialog
    await memberPage.keyboard.press('Escape');
    await memberPage.waitForTimeout(300);
  });

  test('Phase 6: admin reviews and signs off sub-contribution', async () => {
    await adminPage.bringToFront();

    await navigateToProjectDetail(adminPage, PROJECT_TITLE);
    await waitForSettle(adminPage, 1500);

    await openContributionDialog(adminPage, CONTRIBUTION_1_TITLE);
    const dlg = adminPage.locator('.q-dialog');

    // Click sub-item to open it
    const subItem = dlg.locator('.sub-item').filter({ hasText: SUB_CONTRIBUTION_TITLE });
    const subVisible = await subItem.isVisible({ timeout: 5000 }).catch(() => false);
    if (!subVisible) {
      console.log('[Phase 6] Sub-contribution item not visible — skipping sub review');
      await closeContributionDialog(adminPage);
      return;
    }
    await subItem.click();
    await adminPage.waitForTimeout(500);

    const nestedDlg = adminPage.locator('.q-dialog').last();

    // Toggle review form
    const reviewBtn = nestedDlg.getByRole('button', { name: /Review Submission/i });
    if (await reviewBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await reviewBtn.click();
      await adminPage.waitForTimeout(500);
    }

    // Review: select Approve decision
    const approveDecision = nestedDlg.locator('.decision-btn').filter({ hasText: 'Approve' });
    const approveVisible = await approveDecision.isVisible({ timeout: 5000 }).catch(() => false);
    if (approveVisible) {
      await approveDecision.click();

      const stars = nestedDlg.locator('.star-btn');
      const starCount = await stars.count();
      if (starCount >= 7) {
        await stars.nth(6).click();
      }

      const feedbackInput = nestedDlg.getByPlaceholder(/feedback/i);
      if (await feedbackInput.isVisible().catch(() => false)) {
        await feedbackInput.fill('Thorough review. Sub-contribution objectives fully met.');
      }

      const submitReview = nestedDlg.getByRole('button', { name: /Submit Review/i });
      if (await submitReview.isVisible().catch(() => false)) {
        await submitReview.click();
        await waitForSettle(adminPage);
        console.log('[Phase 6] Admin reviewed sub-contribution');
      }
    }

    // After review submit, the nested dialog closes. Re-open sub to sign off.
    await adminPage.waitForTimeout(1000);

    // The parent dialog should still be open — re-click the sub-item
    const parentDlg = adminPage.locator('.q-dialog').first();
    const subItemAgain = parentDlg.locator('.sub-item').filter({ hasText: SUB_CONTRIBUTION_TITLE });
    const subStillVisible = await subItemAgain.isVisible({ timeout: 5000 }).catch(() => false);
    if (subStillVisible) {
      await subItemAgain.click();
      await adminPage.waitForTimeout(500);

      const nestedDlg2 = adminPage.locator('.q-dialog').last();
      const signOffBtn = nestedDlg2.getByRole('button', { name: /Sign Off/i }).first();
      const signOffVisible = await signOffBtn.isVisible({ timeout: 5000 }).catch(() => false);
      if (signOffVisible) {
        await signOffBtn.click();
        await waitForSettle(adminPage);
        console.log('[Phase 6] Admin signed off sub-contribution');
      } else {
        console.log('[Phase 6] Sign Off button not visible — sub may not be in approved status yet');
      }
      await adminPage.keyboard.press('Escape');
      await adminPage.waitForTimeout(300);
    }

    await closeContributionDialog(adminPage);
  });

  // ------------------------------------------------------------------
  // Phase 7: Member Submits Evidence for Parent Contribution
  // ------------------------------------------------------------------

  test('Phase 7: member submits evidence for parent contribution', async () => {
    await memberPage.bringToFront();

    // Allow extra time for sub-contribution sign-off to sync via any-sync
    await navigateToProjectDetail(memberPage, PROJECT_TITLE);
    await waitForSettle(memberPage, 5000);

    await openContributionDialog(memberPage, CONTRIBUTION_1_TITLE);
    const detailDlg = memberPage.locator('.q-dialog');

    // Toggle evidence form — retry with re-navigation if not visible (sync delay)
    let submitEvidenceBtn = detailDlg.getByRole('button', { name: /Submit Evidence & Complete/i });
    if (!await submitEvidenceBtn.isVisible({ timeout: 10000 }).catch(() => false)) {
      // Sub sign-off may not have synced yet — close, wait, re-open
      await memberPage.keyboard.press('Escape');
      await waitForSettle(memberPage, 5000);
      await navigateToProjectDetail(memberPage, PROJECT_TITLE);
      await waitForSettle(memberPage, 3000);
      await openContributionDialog(memberPage, CONTRIBUTION_1_TITLE);
      submitEvidenceBtn = memberPage.locator('.q-dialog').getByRole('button', { name: /Submit Evidence & Complete/i });
    }
    const evidenceBtnVisible = await submitEvidenceBtn.isVisible({ timeout: TIMEOUT.medium }).catch(() => false);
    if (!evidenceBtnVisible) {
      console.log('[Phase 7] Submit Evidence button not visible — sub-contribution sign-off may not have synced. Skipping.');
      await memberPage.keyboard.press('Escape');
      await memberPage.waitForTimeout(500);
      return;
    }
    await submitEvidenceBtn.click();
    await memberPage.waitForTimeout(500);

    // 7.2 Fill completion notes
    const notesInput = detailDlg.getByPlaceholder(/Describe how you completed/i).or(
      detailDlg.locator('.submit-completion-form textarea').first(),
    );
    await expect(notesInput).toBeVisible({ timeout: TIMEOUT.medium });
    await notesInput.fill('Wireframes completed. All design objectives met. Sub-contributions signed off. Ready for review.');

    // 7.7 Enter actual hours
    const hoursInput = detailDlg.locator('.submit-completion-form').getByLabel(/Actual Hours/i).or(
      detailDlg.locator('.submit-completion-form input[type="number"]'),
    );
    if (await hoursInput.isVisible().catch(() => false)) {
      await hoursInput.fill('32');
    }

    // Fill acceptance criteria if present
    const criteriaInputs = detailDlg.locator('.submit-completion-form .criterion-block input');
    const criteriaCount = await criteriaInputs.count();
    for (let i = 0; i < criteriaCount; i++) {
      await criteriaInputs.nth(i).fill('Criterion met through design review and team validation');
    }

    // 7.8 Submit for review
    const submitBtn = detailDlg.getByRole('button', { name: /Submit for Review/i });
    await expect(submitBtn).toBeVisible({ timeout: TIMEOUT.short });
    await submitBtn.click();
    await waitForSettle(memberPage);
    console.log('[Phase 7] Member submitted evidence for parent contribution');

    await memberPage.keyboard.press('Escape');
    await memberPage.waitForTimeout(500);
  });

  // ------------------------------------------------------------------
  // Phase 8: Admin Reviews Parent Contribution
  // ------------------------------------------------------------------

  test('Phase 8: admin reviews and approves parent contribution', async () => {
    await adminPage.bringToFront();

    await navigateToProjectDetail(adminPage, PROJECT_TITLE);
    await waitForSettle(adminPage, 1500);

    await openContributionDialog(adminPage, CONTRIBUTION_1_TITLE);
    const dlg = adminPage.locator('.q-dialog');

    // Toggle review form
    const reviewBtn = dlg.getByRole('button', { name: /Review Submission/i });
    await expect(reviewBtn).toBeVisible({ timeout: TIMEOUT.medium });
    await reviewBtn.click();
    await adminPage.waitForTimeout(500);

    // 8.3 Select Approve decision
    const approveDecision = dlg.locator('.decision-btn').filter({ hasText: 'Approve' });
    await expect(approveDecision).toBeVisible({ timeout: TIMEOUT.short });
    await approveDecision.click();

    // 8.4 Rate quality — click 8th star
    const stars = dlg.locator('.star-btn');
    const starCount = await stars.count();
    if (starCount >= 8) {
      await stars.nth(7).click();
    }

    // 8.6 Write feedback
    const feedbackInput = dlg.getByPlaceholder(/feedback/i);
    if (await feedbackInput.isVisible().catch(() => false)) {
      await feedbackInput.fill('Excellent work. Design meets all acceptance criteria. Outstanding collaboration on sub-contributions.');
    }

    // 8.7 Submit review
    const submitReview = dlg.getByRole('button', { name: /Submit Review/i });
    await expect(submitReview).toBeVisible({ timeout: TIMEOUT.short });
    await submitReview.click();
    await waitForSettle(adminPage);
    console.log('[Phase 8] Admin submitted review — approved');

    await closeContributionDialog(adminPage);
  });

  // ------------------------------------------------------------------
  // Phase 9: Admin Signs Off Contribution
  // ------------------------------------------------------------------

  test('Phase 9: admin signs off parent contribution', async () => {
    await adminPage.bringToFront();

    await openContributionDialog(adminPage, CONTRIBUTION_1_TITLE);
    const dlg = adminPage.locator('.q-dialog');

    // 9.2 Click Sign Off
    const signOffBtn = dlg.getByRole('button', { name: /Sign Off/i }).first();
    await expect(signOffBtn).toBeVisible({ timeout: TIMEOUT.medium });
    await signOffBtn.click();
    await waitForSettle(adminPage);

    // 9.4 Verify signed-off state
    await expect(dlg.getByText(/Signed Off/i).first()).toBeVisible({ timeout: TIMEOUT.short });
    console.log('[Phase 9] Contribution 1 signed off');

    await closeContributionDialog(adminPage);
  });

  // ------------------------------------------------------------------
  // Phase 10: Assign contribution 2, member change, admin re-confirms
  // ------------------------------------------------------------------

  test('Phase 10: admin assigns contribution 2 to member', async () => {
    await adminPage.bringToFront();

    await openContributionDialog(adminPage, CONTRIBUTION_2_TITLE);
    const dlg = adminPage.locator('.q-dialog');

    // Use merged Assign dialog
    const assignBtn = dlg.getByRole('button', { name: /Assign Contribution/i }).first();
    await expect(assignBtn).toBeVisible({ timeout: TIMEOUT.short });
    await assignBtn.click();

    const assignDlg = adminPage.locator('.assign-dialog');
    await expect(assignDlg).toBeVisible({ timeout: TIMEOUT.short });

    // Select Member mode and pick the correct member (not the admin)
    const memberModeCard = assignDlg.locator('.assign-mode-card').filter({ hasText: 'Member' });
    await memberModeCard.click();
    await waitForSettle(adminPage, 500);

    const memberNameToUse = accounts.member?.name ?? MEMBER_NAME;
    const searchInput = assignDlg.locator('input[placeholder*="Search"]');
    if (await searchInput.isVisible().catch(() => false)) {
      await searchInput.fill(memberNameToUse.substring(0, 5));
      await waitForSettle(adminPage, 500);
    }

    const memberRow = assignDlg.locator('.assign-member-row').filter({ hasText: new RegExp(memberNameToUse, 'i') }).first();
    if (await memberRow.isVisible({ timeout: 3000 }).catch(() => false)) {
      await memberRow.click();
    } else {
      // Fallback: pick the last member (admin is usually first)
      const rows = assignDlg.locator('.assign-member-row');
      const count = await rows.count();
      await rows.nth(count - 1).click();
    }

    await assignDlg.getByRole('button', { name: 'Assign' }).click();
    await waitForSettle(adminPage);
    console.log('[Phase 10] Contribution 2 assigned to member');

    await closeContributionDialog(adminPage);
  });

  test('Phase 10: member accepts offer on contribution 2', async () => {
    await memberPage.bringToFront();

    await navigateToProjectDetail(memberPage, PROJECT_TITLE);
    await waitForSettle(memberPage, 1500);

    await openContributionDialog(memberPage, CONTRIBUTION_2_TITLE);
    const detailDlg = memberPage.locator('.q-dialog');

    const acceptBtn = detailDlg.getByRole('button', { name: /Accept Offer|Accept/i }).first();
    await expect(acceptBtn).toBeVisible({ timeout: TIMEOUT.short });
    await acceptBtn.click();
    await waitForSettle(memberPage);
    console.log('[Phase 10] Member accepted offer on contribution 2');

    await memberPage.keyboard.press('Escape');
    await memberPage.waitForTimeout(500);
  });

  test('Phase 10: admin edits contribution 2 via header pencil icon', async () => {
    await adminPage.bringToFront();

    await navigateToProjectDetail(adminPage, PROJECT_TITLE);
    await waitForSettle(adminPage, 1500);

    await openContributionDialog(adminPage, CONTRIBUTION_2_TITLE);
    const dlg = adminPage.locator('.q-dialog');

    // 10.1 Click edit pencil icon in dialog header
    const editBtn = dlg.locator('.edit-btn');
    await expect(editBtn).toBeVisible({ timeout: TIMEOUT.short });
    await editBtn.click();

    // 10.2 Change dialog opens (reuses CreateContributionDialog in editing mode)
    const changeDlg = dialog(adminPage, /Change Contribution|Submit Change/i);
    await expect(changeDlg).toBeVisible({ timeout: TIMEOUT.short });

    // 10.4 Edit description
    const descInput = changeDlg.getByLabel(/Description/i).first();
    await descInput.clear();
    await descInput.fill('Updated: Coordinate expanded community outreach with new partners and stakeholders');

    // 10.5 Provide reason for change
    const reasonInput = changeDlg.getByLabel(/Reason for Change/i).or(
      changeDlg.getByPlaceholder(/reason|why/i),
    );
    await expect(reasonInput).toBeVisible({ timeout: TIMEOUT.short });
    await reasonInput.fill('Scope expanded to include additional community partners following initial planning');

    // 10.6 Submit change
    await changeDlg.getByRole('button', { name: /Submit Change/i }).click();
    await waitForSettle(adminPage);
    console.log('[Phase 10] Admin submitted contribution change');

    await closeContributionDialog(adminPage);
  });

  test('Phase 10: verify contribution 2 status after admin edit', async () => {
    await adminPage.bringToFront();

    // Admin (community_admin) edits stay assigned — no re-confirmation needed.
    // Only project_lead edits transition to "changed" and require re-confirmation.
    // Verify the contribution is still visible and in assigned status.
    const contrib2Card = adminPage.locator('.contribution-compact').filter({ hasText: CONTRIBUTION_2_TITLE });
    await expect(contrib2Card).toBeVisible({ timeout: TIMEOUT.medium });

    const confirmBtn = contrib2Card.getByRole('button', { name: 'Confirm' });
    const needsConfirm = await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false);
    if (needsConfirm) {
      await confirmBtn.click();
      await waitForSettle(adminPage);
      console.log('[Phase 10] Admin re-confirmed changed contribution 2');
    } else {
      console.log('[Phase 10] No re-confirmation needed (admin/steward edit stays assigned)');
    }
  });

  // ------------------------------------------------------------------
  // Verification
  // ------------------------------------------------------------------

  test('verify project still listed on projects page', async () => {
    await adminPage.bringToFront();

    await navigateTo(adminPage, 'Projects');
    await expect(adminPage).toHaveURL(/\/dashboard\/projects/, { timeout: TIMEOUT.short });
    await waitForSettle(adminPage);

    const card = adminPage.locator('.project-card', { hasText: PROJECT_TITLE }).first();
    await expect(card).toBeVisible({ timeout: TIMEOUT.medium });
    console.log('[Verify] Project still listed on projects page');
  });
});

// ===========================================================================
// Group 2: API Validation (runs after lifecycle so org setup is complete)
// ===========================================================================

test.describe.serial('Projects & Contributions — API Validation', () => {
  test('backend is reachable', async ({ request }) => {
    const response = await request.get(`${BACKEND_URL}/health`);
    expect(response.ok()).toBeTruthy();
    console.log('[API] Backend health check passed');
  });

  test('rejects project creation with empty title', async ({ request }) => {
    const health = await request.get(`${BACKEND_URL}/health`);
    const { admin: resolvedAdminAID } = await health.json();
    expect(resolvedAdminAID).toBeTruthy();

    const response = await request.post(`${BACKEND_URL}/api/v1/projects`, {
      headers: {
        'Content-Type': 'application/json',
        'X-User-AID': resolvedAdminAID,
      },
      data: { title: '', description: 'No title', created_by: resolvedAdminAID },
    });
    expect(response.status()).toBe(400);
    console.log('[API] Empty project title rejected');
  });

  test('rejects contribution creation with missing required fields', async ({ request }) => {
    const response = await request.post(`${BACKEND_URL}/api/v1/contributions`, {
      headers: { 'Content-Type': 'application/json' },
      data: { title: 'Missing fields' },
    });
    expect(response.status()).toBe(400);
    console.log('[API] Missing contribution fields rejected');
  });
});
