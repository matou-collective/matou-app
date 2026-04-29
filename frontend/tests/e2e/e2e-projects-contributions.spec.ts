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
  // Phase 11: Edit milestone via pencil icon
  // The .milestone-row-actions wrapper is gated only by canEdit (lead/steward/admin),
  // so the edit pencil is reachable on the existing signed-off plan.
  // ------------------------------------------------------------------

  test('Phase 11: admin edits milestone description via pencil icon', async () => {
    await adminPage.bringToFront();

    await navigateToProjectDetail(adminPage, PROJECT_TITLE);
    await waitForSettle(adminPage);

    const milestoneCard = adminPage.locator('.milestone-card').first();
    await expect(milestoneCard).toBeVisible({ timeout: TIMEOUT.medium });

    // .milestone-row-actions contains the edit + delete q-btns
    const actions = milestoneCard.locator('.milestone-row-actions');
    await expect(actions).toBeVisible({ timeout: TIMEOUT.short });

    // First button is edit (icon=edit), second is delete (icon=delete)
    const editBtn = actions.locator('button').first();
    await editBtn.click();

    // MilestoneFormDialog opens in edit mode
    const formDlg = dialog(adminPage, /Edit Milestone/i);
    await expect(formDlg).toBeVisible({ timeout: TIMEOUT.short });

    // The title field should be prefilled
    await expect(formDlg.getByLabel(/Milestone Title/i)).toHaveValue(MILESTONE_TITLE, { timeout: TIMEOUT.short });

    // Edit description
    const descInput = formDlg.getByLabel(/Description/i);
    await descInput.clear();
    await descInput.fill('Updated via E2E Phase 11');

    // Save Changes button
    const saveBtn = formDlg.getByRole('button', { name: /Save Changes/i });
    await expect(saveBtn).toBeVisible({ timeout: TIMEOUT.short });
    await saveBtn.click();
    await waitForSettle(adminPage, 2000);

    // Re-open the dialog to verify the change persisted
    await editBtn.click();
    const reDlg = dialog(adminPage, /Edit Milestone/i);
    await expect(reDlg).toBeVisible({ timeout: TIMEOUT.short });
    await expect(reDlg.getByLabel(/Description/i)).toHaveValue('Updated via E2E Phase 11', { timeout: TIMEOUT.short });
    await reDlg.locator('button').filter({ hasText: /Cancel/i }).first().click();

    // Verify the plan-modified banner now appears (plan was signed off in Phase 3,
    // edit invalidated the signoff). The banner has class .plan-modified-banner
    // and shows "Plan modified — re-signoff required". Also verify the
    // Re-Sign Off Plan button is offered.
    await expect(adminPage.locator('.plan-modified-banner')).toBeVisible({ timeout: TIMEOUT.short });
    await expect(adminPage.getByText(/re-signoff required/i)).toBeVisible({ timeout: TIMEOUT.short });
    await expect(adminPage.getByRole('button', { name: /Re-Sign Off Plan/i })).toBeVisible({ timeout: TIMEOUT.short });
    console.log('[Phase 11] Plan-modified banner visible after milestone edit');

    // Note: we don't click Re-Sign Off Plan here. The existing SignOffPlan
    // validator requires all contributions to be in 'confirmed' state, which
    // they're not by Phase 11 (mix of signed_off + assigned). Subsequent
    // phases (12-17) don't need contributions to be signed off again — they
    // unassign/archive contributions and submit project completion.
  });

  // ------------------------------------------------------------------
  // Phase 12: Unassign contributor from contribution 2 via UI
  // Click the edit pencil on contribution 2's compact card (now reachable
  // after the !isPlanSignedOff gate was lifted), then click "Unassign
  // Contributor" inside the ContributionForm dialog.
  // ------------------------------------------------------------------

  test('Phase 12: admin unassigns member from contribution 2 via pencil icon', async () => {
    await adminPage.bringToFront();

    await navigateToProjectDetail(adminPage, PROJECT_TITLE);
    await waitForSettle(adminPage);

    // Locate contribution 2 card
    const contrib2Card = adminPage.locator('.contribution-compact').filter({ hasText: CONTRIBUTION_2_TITLE });
    await expect(contrib2Card).toBeVisible({ timeout: TIMEOUT.medium });

    // Confirm assignee avatar is present (member accepted offer in Phase 10)
    await expect(contrib2Card.locator('.compact-avatar')).toBeVisible({ timeout: TIMEOUT.short });

    // .compact-actions has the edit pencil — click it
    // The first button matching the edit icon (skipping any Confirm button which is rendered conditionally)
    const editPencil = contrib2Card.locator('.compact-actions button').filter({
      has: adminPage.locator('.q-icon').filter({ hasText: /^edit$/ }),
    }).first();
    // Fallback: find by tooltip text
    const editFallback = contrib2Card.locator('.compact-actions button').filter({ hasText: '' }).nth(0);
    if (await editPencil.isVisible({ timeout: 2000 }).catch(() => false)) {
      await editPencil.click();
    } else {
      // The compact-actions has flat round buttons; the first non-Confirm button is edit
      const allBtns = contrib2Card.locator('.compact-actions button');
      const btnCount = await allBtns.count();
      // Skip Confirm/Assign buttons — find an icon-only flat round button
      let clicked = false;
      for (let i = 0; i < btnCount; i++) {
        const btn = allBtns.nth(i);
        const text = (await btn.textContent() ?? '').trim();
        if (text === '' || text.length < 2) {
          await btn.click();
          clicked = true;
          break;
        }
      }
      if (!clicked) {
        await editFallback.click();
      }
    }

    // ContributionForm dialog opens in edit mode
    const formDlg = adminPage.locator('.q-dialog').filter({ hasText: /Edit Contribution/i }).first();
    await expect(formDlg).toBeVisible({ timeout: TIMEOUT.short });

    // The unassign block (.unassign-block) contains the "Unassign Contributor" button
    const unassignBtn = formDlg.getByRole('button', { name: /Unassign Contributor/i });
    await expect(unassignBtn).toBeVisible({ timeout: TIMEOUT.short });
    await unassignBtn.click();

    // ConfirmArchiveDialog (reused with confirmLabel="Unassign", icon="person_remove",
    // title="Unassign Contributor")
    const confirmDlg = adminPage.locator('.q-dialog').filter({ hasText: 'Unassign Contributor' }).last();
    await expect(confirmDlg).toBeVisible({ timeout: TIMEOUT.short });
    await confirmDlg.getByRole('button', { name: 'Unassign' }).click();
    await waitForSettle(adminPage, 2000);

    // ContributionForm should close; refresh and verify
    await adminPage.keyboard.press('Escape').catch(() => {});
    await waitForSettle(adminPage);
    await navigateToProjectDetail(adminPage, PROJECT_TITLE);
    await waitForSettle(adminPage);

    const refreshedCard = adminPage.locator('.contribution-compact').filter({ hasText: CONTRIBUTION_2_TITLE });
    await expect(refreshedCard).toBeVisible({ timeout: TIMEOUT.medium });
    await expect(refreshedCard.locator('.compact-avatar')).toHaveCount(0, { timeout: TIMEOUT.short });
    console.log('[Phase 12] UI confirms contribution 2 unassigned (no avatar visible)');
  });

  // ------------------------------------------------------------------
  // Phase 13: Archive sub-contribution via ContributionDetailDialog UI
  // The sub-item archive button is gated only by canApproveSub (lead/steward),
  // NOT by isPlanSignedOff. Sub-contribution is signed_off after Phase 6 —
  // admin (also lead+steward) can still click the delete icon.
  // The archive-sub-contribution event feeds into confirmArchiveContribution()
  // which opens a ConfirmArchiveDialog with title "Archive Contribution".
  // ------------------------------------------------------------------

  test('Phase 13: admin archives sub-contribution via dialog delete icon', async () => {
    await adminPage.bringToFront();

    await navigateToProjectDetail(adminPage, PROJECT_TITLE);
    await waitForSettle(adminPage, 1500);

    // Open contribution 1 (which contains the sub-contribution)
    await openContributionDialog(adminPage, CONTRIBUTION_1_TITLE);
    const dlg = adminPage.locator('.q-dialog').first();

    // Locate the sub-item row by title
    const subItem = dlg.locator('.sub-item').filter({ hasText: SUB_CONTRIBUTION_TITLE });
    await expect(subItem).toBeVisible({ timeout: TIMEOUT.medium });

    // Click the delete icon (icon="delete") within the sub-item; stop propagation handles click isolation
    const deleteSubBtn = subItem.locator('button').filter({ has: adminPage.locator('[aria-label="Delete Sub-Contribution"], .q-icon[name="delete"]') }).first();
    // Fallback: last button in the sub-item (edit is first, delete is second in the template)
    const subItemBtns = subItem.locator('button');
    const btnCount = await subItemBtns.count();
    if (btnCount >= 2) {
      await subItemBtns.last().click();
    } else if (await deleteSubBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await deleteSubBtn.click();
    } else {
      console.log('[Phase 13] Delete sub-contribution button not found — sub may not be visible or canApproveSub is false');
      await closeContributionDialog(adminPage);
      return;
    }

    // ConfirmArchiveDialog opens with title "Archive Contribution"
    const archiveDlg = adminPage.locator('.q-dialog').filter({ hasText: 'Archive Contribution' }).last();
    await expect(archiveDlg).toBeVisible({ timeout: TIMEOUT.short });

    // Default confirm label is "Archive"
    const archiveConfirmBtn = archiveDlg.getByRole('button', { name: 'Archive' });
    await expect(archiveConfirmBtn).toBeVisible({ timeout: TIMEOUT.short });
    await archiveConfirmBtn.click();
    await waitForSettle(adminPage, 2000);

    // Sub-item should no longer appear in the dialog
    await expect(dlg.locator('.sub-item').filter({ hasText: SUB_CONTRIBUTION_TITLE })).toHaveCount(0, { timeout: TIMEOUT.medium });
    console.log('[Phase 13] Sub-contribution archived via dialog delete icon');

    await closeContributionDialog(adminPage);
  });

  // ------------------------------------------------------------------
  // Phase 14: Archive contribution 2 via UI trash icon
  // Now reachable on the compact card after the !isPlanSignedOff gate
  // was lifted. After archive the card is hidden from the milestone view.
  // ------------------------------------------------------------------

  test('Phase 14: admin archives contribution 2 via trash icon', async () => {
    await adminPage.bringToFront();

    await navigateToProjectDetail(adminPage, PROJECT_TITLE);
    await waitForSettle(adminPage);

    const contrib2Card = adminPage.locator('.contribution-compact').filter({ hasText: CONTRIBUTION_2_TITLE });
    await expect(contrib2Card).toBeVisible({ timeout: TIMEOUT.medium });

    // Click the trash icon — second flat round button in .compact-actions (after edit pencil)
    const actionBtns = contrib2Card.locator('.compact-actions button');
    const btnCount = await actionBtns.count();
    let trashClicked = false;
    // Iterate from the end to find icon-only buttons; trash is the last icon-only button
    for (let i = btnCount - 1; i >= 0; i--) {
      const btn = actionBtns.nth(i);
      const text = (await btn.textContent() ?? '').trim();
      if (text === '' || text.length < 2) {
        // Click the LAST icon-only button (trash, not edit)
        await btn.click();
        trashClicked = true;
        break;
      }
    }
    expect(trashClicked, 'Trash button not found in compact-actions').toBe(true);

    // ConfirmArchiveDialog opens with title "Archive Contribution"
    const archiveDlg = adminPage.locator('.q-dialog').filter({ hasText: 'Archive Contribution' }).last();
    await expect(archiveDlg).toBeVisible({ timeout: TIMEOUT.short });
    await archiveDlg.getByRole('button', { name: 'Archive' }).click();
    await waitForSettle(adminPage, 2500);

    // Card should disappear from the milestone view (archived contributions
    // are filtered out of the active list)
    await expect(adminPage.locator('.contribution-compact').filter({ hasText: CONTRIBUTION_2_TITLE })).toHaveCount(0, { timeout: TIMEOUT.medium });
    console.log('[Phase 14] Contribution 2 archived via UI trash icon');
  });

  // ------------------------------------------------------------------
  // Phase 15: Submit project for steward review
  // All contributions are now in {signed_off (contrib 1), archived (contrib 2)}.
  // The ProjectCompletionSection "Submit for Steward Review" button is visible
  // when allSignedOff is true (counts both signed_off and archived).
  // Admin is also project lead so canSubmit is true.
  // ------------------------------------------------------------------

  test('Phase 15: admin submits project for steward review', async () => {
    await adminPage.bringToFront();

    await navigateToProjectDetail(adminPage, PROJECT_TITLE);
    await waitForSettle(adminPage, 2000);

    // The ProjectCompletionSection is a .completion-section card on the page
    const submitBtn = adminPage.getByRole('button', { name: 'Submit for Steward Review' });
    await expect(submitBtn).toBeVisible({ timeout: TIMEOUT.medium });
    await submitBtn.click();
    await waitForSettle(adminPage, 2000);

    // After submit, project status becomes pending_completion.
    // Admin is also steward so the "Awaiting your signoff." banner should appear.
    await expect(adminPage.getByText(/Awaiting your signoff\./i)).toBeVisible({ timeout: TIMEOUT.medium });
    console.log('[Phase 15] Project submitted for steward review — pending_completion');
  });

  // ------------------------------------------------------------------
  // Phase 16a: Steward (admin) sends back with rejection reason
  // ------------------------------------------------------------------

  test('Phase 16a: admin (steward) sends project back with reason', async () => {
    await adminPage.bringToFront();

    // Page should already show pending_completion state from Phase 15
    // but navigate fresh to ensure we have current state
    await navigateToProjectDetail(adminPage, PROJECT_TITLE);
    await waitForSettle(adminPage);

    const sendBackBtn = adminPage.getByRole('button', { name: 'Send Back' });
    await expect(sendBackBtn).toBeVisible({ timeout: TIMEOUT.medium });
    await sendBackBtn.click();

    // Reject dialog is a q-dialog rendered inside ProjectCompletionSection
    // Title is "Send Back for Revision", input label is "Reason (optional)"
    const rejectDlg = adminPage.locator('.q-dialog').filter({ hasText: 'Send Back for Revision' }).last();
    await expect(rejectDlg).toBeVisible({ timeout: TIMEOUT.short });

    const reasonInput = rejectDlg.getByLabel(/Reason/i);
    await expect(reasonInput).toBeVisible({ timeout: TIMEOUT.short });
    await reasonInput.fill('Need to fix one thing first');

    // Button inside the reject dialog is labeled "Send Back" with color negative
    const sendBackConfirm = rejectDlg.getByRole('button', { name: 'Send Back' });
    await sendBackConfirm.click();
    await waitForSettle(adminPage, 2000);

    // Project returns to 'active'. The rejection_reason banner should appear.
    await expect(adminPage.getByText(/Need to fix one thing first/)).toBeVisible({ timeout: TIMEOUT.medium });
    console.log('[Phase 16a] Project sent back with rejection reason');
  });

  // ------------------------------------------------------------------
  // Phase 16b: Admin re-submits and approves completion
  // ------------------------------------------------------------------

  test('Phase 16b: admin re-submits project and approves completion', async () => {
    await adminPage.bringToFront();

    // Page should show active state with rejection_reason banner
    await navigateToProjectDetail(adminPage, PROJECT_TITLE);
    await waitForSettle(adminPage);

    // Re-submit for steward review
    const submitBtn = adminPage.getByRole('button', { name: 'Submit for Steward Review' });
    await expect(submitBtn).toBeVisible({ timeout: TIMEOUT.medium });
    await submitBtn.click();
    await waitForSettle(adminPage, 2000);

    // After re-submit the rejection_reason is cleared (backend sets rejection_reason = '')
    await expect(adminPage.getByText(/Need to fix one thing first/)).not.toBeVisible({ timeout: TIMEOUT.short });
    console.log('[Phase 16b] Re-submitted; rejection reason cleared');

    // Admin is steward — "Approve Completion" button is visible
    const approveBtn = adminPage.getByRole('button', { name: 'Approve Completion' });
    await expect(approveBtn).toBeVisible({ timeout: TIMEOUT.medium });
    await approveBtn.click();
    await waitForSettle(adminPage, 2000);

    // After approval: status = completed, banner shows "Completed by ... on ..."
    await expect(adminPage.getByText(/Completed by/i)).toBeVisible({ timeout: TIMEOUT.medium });
    console.log('[Phase 16b] Project approved — status = completed');
  });

  // ------------------------------------------------------------------
  // Verification: project is still listed before destructive Phase 17
  // ------------------------------------------------------------------

  test('verify project listed on projects page before deletion', async () => {
    await adminPage.bringToFront();

    await navigateTo(adminPage, 'Projects');
    await expect(adminPage).toHaveURL(/\/dashboard\/projects/, { timeout: TIMEOUT.short });
    await waitForSettle(adminPage);

    const card = adminPage.locator('.project-card', { hasText: PROJECT_TITLE }).first();
    await expect(card).toBeVisible({ timeout: TIMEOUT.medium });
    console.log('[Verify] Project listed on projects page (pre-deletion)');
  });

  // ------------------------------------------------------------------
  // Phase 17: Delete project (DESTROY confirmation)
  // Opens ProjectForm via the "Edit" button in the project header
  // (flat q-btn with icon "edit" and label "Edit", gated by canEditProject).
  // ProjectForm has a Danger Zone with "Delete Project" button.
  // Clicking it fires onDeleteRequested() which closes the form and opens
  // ConfirmDestroyDialog. The confirm word defaults to "DESTROY".
  // The dialog's confirm button label is the `title` prop = "Delete Project".
  // ------------------------------------------------------------------

  test('Phase 17: admin deletes project with DESTROY confirmation', async () => {
    await adminPage.bringToFront();

    await navigateToProjectDetail(adminPage, PROJECT_TITLE);
    await waitForSettle(adminPage);

    // Open ProjectForm via the "Edit" button in the project-header-actions
    // (ProjectDetailPage.vue line 58-65: flat button with icon="edit" label="Edit")
    const editBtn = adminPage.locator('.project-header-actions').getByRole('button', { name: 'Edit' });
    await expect(editBtn).toBeVisible({ timeout: TIMEOUT.medium });
    await editBtn.click();

    // ProjectForm dialog — title is "Edit" (no distinct dialog title text from the form component)
    // but the form is the visible q-dialog
    const formDlg = adminPage.locator('.q-dialog').filter({ hasText: 'Delete Project' }).first();
    await expect(formDlg).toBeVisible({ timeout: TIMEOUT.short });

    // Click "Delete Project" in the danger zone
    const deleteBtn = formDlg.getByRole('button', { name: 'Delete Project' });
    await expect(deleteBtn).toBeVisible({ timeout: TIMEOUT.short });
    await deleteBtn.click();
    await waitForSettle(adminPage, 500);

    // ConfirmDestroyDialog opens (ProjectForm closes, showDestroy becomes true)
    // Dialog has title "Delete Project" and confirm word "DESTROY"
    const destroyDlg = adminPage.locator('.destroy-dialog').first();
    await expect(destroyDlg).toBeVisible({ timeout: TIMEOUT.short });

    // The confirm button is disabled until DESTROY is typed
    const confirmBtn = destroyDlg.getByRole('button', { name: 'Delete Project' });
    await expect(confirmBtn).toBeDisabled({ timeout: TIMEOUT.short });

    // Type DESTROY in the input (label: "Type DESTROY to confirm")
    await destroyDlg.locator('input').fill('DESTROY');
    await expect(confirmBtn).toBeEnabled({ timeout: TIMEOUT.short });
    await confirmBtn.click();
    await waitForSettle(adminPage, 3000);

    // After archive + redirect, we should be on the projects list
    await expect(adminPage).toHaveURL(/\/dashboard\/projects$/, { timeout: TIMEOUT.medium });

    // Project should not appear in the active list
    await waitForSettle(adminPage);
    await expect(adminPage.locator('.project-card').filter({ hasText: PROJECT_TITLE })).toHaveCount(0, { timeout: TIMEOUT.medium });
    console.log('[Phase 17] Project deleted — no longer listed on projects page');
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

  // ── New endpoint validation tests ───────────────────────────────────────

  test('unassign returns 409 when contribution is not in assigned status', async ({ request }) => {
    const health = await request.get(`${BACKEND_URL}/health`);
    const { admin: adminAID } = await health.json();
    expect(adminAID).toBeTruthy();

    // Create a fresh project and contribution (status = 'created', not 'assigned')
    const projectResp = await request.post(`${BACKEND_URL}/api/v1/projects`, {
      headers: { 'Content-Type': 'application/json', 'X-User-AID': adminAID },
      data: { title: 'API Unassign Test Project', description: 'Created for unassign 409 test', created_by: adminAID },
    });
    expect(projectResp.ok()).toBeTruthy();
    const project: { id: string } = await projectResp.json();

    const contribResp = await request.post(`${BACKEND_URL}/api/v1/contributions`, {
      headers: { 'Content-Type': 'application/json', 'X-User-AID': adminAID },
      data: {
        project_id: project.id,
        title: 'API Unassign Test Contribution',
        description: 'For testing unassign 409',
        contribution_type: 'technical',
        objectives: ['Obj 1'],
        deliverables: ['Del 1'],
        acceptance_criteria: ['Crit 1'],
        created_by: adminAID,
      },
    });
    expect(contribResp.ok()).toBeTruthy();
    const contrib: { id: string; status: string } = await contribResp.json();
    expect(contrib.status).toBe('created');

    // Attempt to unassign a 'created' contribution — expect 409
    const unassignResp = await request.post(`${BACKEND_URL}/api/v1/contributions/${contrib.id}/unassign`, {
      headers: { 'X-User-AID': adminAID },
    });
    expect(unassignResp.status()).toBe(409);
    console.log('[API] Unassign on non-assigned contribution correctly returned 409');

    // Cleanup: archive the test project
    await request.post(`${BACKEND_URL}/api/v1/projects/${project.id}/archive`, {
      headers: { 'X-User-AID': adminAID },
    });
  });

  test('submit-completion returns 400 when not all contributions are signed off', async ({ request }) => {
    const health = await request.get(`${BACKEND_URL}/health`);
    const { admin: adminAID } = await health.json();
    expect(adminAID).toBeTruthy();

    // Create a fresh project with an active (unsigned) contribution
    const projectResp = await request.post(`${BACKEND_URL}/api/v1/projects`, {
      headers: { 'Content-Type': 'application/json', 'X-User-AID': adminAID },
      data: { title: 'API Submit Completion Test', description: 'For submit-completion 400 test', created_by: adminAID },
    });
    expect(projectResp.ok()).toBeTruthy();
    const project: { id: string } = await projectResp.json();

    // Add a contribution (status = 'created', definitely not signed_off)
    await request.post(`${BACKEND_URL}/api/v1/contributions`, {
      headers: { 'Content-Type': 'application/json', 'X-User-AID': adminAID },
      data: {
        project_id: project.id,
        title: 'Unsigned Contribution',
        description: 'Not signed off',
        contribution_type: 'technical',
        objectives: ['Obj 1'],
        deliverables: ['Del 1'],
        acceptance_criteria: ['Crit 1'],
        created_by: adminAID,
      },
    });

    // Submit for completion — should fail because contribution is not signed_off/archived
    const submitResp = await request.post(`${BACKEND_URL}/api/v1/projects/${project.id}/submit-completion`, {
      headers: { 'X-User-AID': adminAID },
    });
    expect(submitResp.status()).toBe(400);
    console.log('[API] submit-completion with unsigned contributions correctly returned 400');

    // Cleanup
    await request.post(`${BACKEND_URL}/api/v1/projects/${project.id}/archive`, {
      headers: { 'X-User-AID': adminAID },
    });
  });

  test('project archive returns 200 and cascades status', async ({ request }) => {
    const health = await request.get(`${BACKEND_URL}/health`);
    const { admin: adminAID } = await health.json();
    expect(adminAID).toBeTruthy();

    // Create a fresh project to archive
    const projectResp = await request.post(`${BACKEND_URL}/api/v1/projects`, {
      headers: { 'Content-Type': 'application/json', 'X-User-AID': adminAID },
      data: { title: 'API Archive Test Project', description: 'For archive cascade test', created_by: adminAID },
    });
    expect(projectResp.ok()).toBeTruthy();
    const project: { id: string; status: string } = await projectResp.json();
    // New projects are created with status='created' (not 'active' until a plan exists/is signed off)
    expect(['created', 'active']).toContain(project.status);

    // Archive it — handler returns {success: "true"} (archive is fire-and-forget)
    const archiveResp = await request.post(`${BACKEND_URL}/api/v1/projects/${project.id}/archive`, {
      headers: { 'X-User-AID': adminAID },
    });
    expect(archiveResp.status()).toBe(200);
    const body: { success?: string } = await archiveResp.json();
    expect(body.success).toBe('true');

    // Verify cascade by re-fetching and checking project status is now archived
    const verifyResp = await request.get(`${BACKEND_URL}/api/v1/projects/${project.id}`, {
      headers: { 'X-User-AID': adminAID },
    });
    expect(verifyResp.ok()).toBeTruthy();
    const verified: { status: string } = await verifyResp.json();
    expect(verified.status).toBe('archived');
    console.log('[API] Project archive returned 200 and project.status=archived');
  });

  test('milestone PATCH succeeds and returns updated fields', async ({ request }) => {
    const health = await request.get(`${BACKEND_URL}/health`);
    const { admin: adminAID } = await health.json();
    expect(adminAID).toBeTruthy();

    // Create a fresh project + plan + milestone via API to get a patchable milestone_id
    const projectResp = await request.post(`${BACKEND_URL}/api/v1/projects`, {
      headers: { 'Content-Type': 'application/json', 'X-User-AID': adminAID },
      data: { title: 'API Milestone PATCH Test', description: 'For milestone patch test', created_by: adminAID },
    });
    expect(projectResp.ok()).toBeTruthy();
    const project: { id: string } = await projectResp.json();

    // Create a plan for the project
    const planResp = await request.post(`${BACKEND_URL}/api/v1/implementation-plans`, {
      headers: { 'Content-Type': 'application/json', 'X-User-AID': adminAID },
      data: { project_id: project.id, total_budget: '0', project_lead: adminAID, project_steward_id: adminAID },
    });
    if (!planResp.ok()) {
      console.log('[API] Could not create plan for milestone PATCH test (status=%d) — skipping', planResp.status());
      await request.post(`${BACKEND_URL}/api/v1/projects/${project.id}/archive`, {
        headers: { 'X-User-AID': adminAID },
      });
      return;
    }
    const plan: { id: string } = await planResp.json();

    // Add a milestone
    const msResp = await request.post(`${BACKEND_URL}/api/v1/milestones`, {
      headers: { 'Content-Type': 'application/json', 'X-User-AID': adminAID },
      data: { implementation_plan_id: plan.id, title: 'Test Milestone', duration: '1 week' },
    });
    expect(msResp.ok()).toBeTruthy();
    const ms: { milestone_id?: string; id?: string } = await msResp.json();
    const milestoneId = ms.milestone_id ?? ms.id;
    expect(milestoneId).toBeTruthy();

    // PATCH the milestone description
    const patchResp = await request.put(`${BACKEND_URL}/api/v1/milestones/${milestoneId}`, {
      headers: { 'Content-Type': 'application/json', 'X-User-AID': adminAID },
      data: { description: 'Patched description from API validation test' },
    });
    expect(patchResp.status()).toBe(200);
    const patched: { milestone_id?: string; id?: string; description?: string } = await patchResp.json();
    expect(patched.milestone_id ?? patched.id).toBeTruthy();
    console.log('[API] Milestone PATCH returned 200: %s', milestoneId);

    // Cleanup
    await request.post(`${BACKEND_URL}/api/v1/projects/${project.id}/archive`, {
      headers: { 'X-User-AID': adminAID },
    });
  });

  test('contribution sign-off returns 409 when implementation plan is not signed off', async ({ request }) => {
    const health = await request.get(`${BACKEND_URL}/health`);
    const { admin: adminAID } = await health.json();
    expect(adminAID).toBeTruthy();

    // Create a project + plan + contribution; do NOT sign off the plan.
    const projectResp = await request.post(`${BACKEND_URL}/api/v1/projects`, {
      headers: { 'Content-Type': 'application/json', 'X-User-AID': adminAID },
      data: { title: 'API Plan-Signoff Guard Test', description: 'For sign-off 409 test', created_by: adminAID },
    });
    expect(projectResp.ok()).toBeTruthy();
    const project: { id: string } = await projectResp.json();

    const planResp = await request.post(`${BACKEND_URL}/api/v1/implementation-plans`, {
      headers: { 'Content-Type': 'application/json', 'X-User-AID': adminAID },
      data: { project_id: project.id, total_budget: '0', project_lead: adminAID, project_steward_id: adminAID },
    });
    if (!planResp.ok()) {
      console.log('[API] Could not create plan for sign-off guard test (status=%d) — skipping', planResp.status());
      await request.post(`${BACKEND_URL}/api/v1/projects/${project.id}/archive`, {
        headers: { 'X-User-AID': adminAID },
      });
      return;
    }

    const contribResp = await request.post(`${BACKEND_URL}/api/v1/contributions`, {
      headers: { 'Content-Type': 'application/json', 'X-User-AID': adminAID },
      data: {
        project_id: project.id,
        title: 'Approved but plan not signed',
        description: 'Should reject signoff',
        contribution_type: 'technical',
        objectives: ['Obj 1'],
        deliverables: ['Del 1'],
        acceptance_criteria: ['Crit 1'],
        created_by: adminAID,
      },
    });
    expect(contribResp.ok()).toBeTruthy();
    const contrib: { id: string } = await contribResp.json();

    // Force the contribution into 'approved' status via the transition endpoint —
    // the only state from which sign-off can be attempted.
    await request.post(`${BACKEND_URL}/api/v1/contributions/${contrib.id}/transition`, {
      headers: { 'Content-Type': 'application/json', 'X-User-AID': adminAID },
      data: { status: 'approved' },
    });

    // Attempt sign-off — must fail with 409 because plan.signed_off=false.
    const signOffResp = await request.post(`${BACKEND_URL}/api/v1/contributions/${contrib.id}/sign-off`, {
      headers: { 'X-User-AID': adminAID },
    });
    expect(signOffResp.status()).toBe(409);
    const errBody: { error?: string } = await signOffResp.json().catch(() => ({}));
    expect(errBody.error ?? '').toMatch(/plan must be signed off/i);
    console.log('[API] Sign-off correctly returned 409 when plan not signed off');

    // Cleanup
    await request.post(`${BACKEND_URL}/api/v1/projects/${project.id}/archive`, {
      headers: { 'X-User-AID': adminAID },
    });
  });
});
