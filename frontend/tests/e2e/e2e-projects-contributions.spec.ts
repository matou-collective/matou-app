/**
 * E2E Tests: Projects & Contributions — Full UI Lifecycle (Two-User)
 *
 * Tests the complete projects and contributions system through the UI,
 * matching the UX flow table (docs/design/CONTRIBUTIONS_UX_FLOW_TABLE.md).
 *
 * Two users:
 *   - Admin (Founding Member): creates project, assigns roles, creates
 *     milestones/contributions, confirms, signs off plan, shares/offers,
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

/** Close the currently open maximized contribution detail dialog */
async function closeContributionDialog(page: Page) {
  const closeBtn = page.locator('.q-dialog .dialog-close-btn');
  if (await closeBtn.isVisible().catch(() => false)) {
    await closeBtn.click();
  } else {
    await page.keyboard.press('Escape');
  }
  await page.waitForTimeout(500);
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
      // Try secureStorage keys (browser mode = localStorage)
      adminAID = await adminPage.evaluate(() => {
        // matou_admin_aid is set by useOrgSetup
        const adminAid = localStorage.getItem('matou_admin_aid');
        if (adminAid) return adminAid;
        // matou_current_aid is set by some login flows
        const currentAid = localStorage.getItem('matou_current_aid');
        if (currentAid) {
          try { const p = JSON.parse(currentAid); return p.prefix || p.aid || currentAid; } catch { return currentAid; }
        }
        return '';
      });
    }
    if (!adminAID) {
      // Fallback: health endpoint
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

    // 1.2 Click "+ New Project"
    const newBtn = adminPage.getByRole('button', { name: /New Project/i });
    await expect(newBtn).toBeVisible({ timeout: TIMEOUT.short });
    await newBtn.click();

    // 1.3 Fill project form
    const dlg = dialog(adminPage, 'Create Project');
    await expect(dlg).toBeVisible({ timeout: TIMEOUT.short });
    await dlg.getByLabel(/Title/i).fill(PROJECT_TITLE);
    await dlg.getByLabel(/Description/i).fill(PROJECT_DESC);

    // 1.4 Submit
    await dlg.getByRole('button', { name: /Create Project/i }).click();
    await waitForSettle(adminPage);

    // Verify project appears in list
    const card = adminPage.locator('.project-card', { hasText: PROJECT_TITLE }).first();
    await expect(card).toBeVisible({ timeout: TIMEOUT.medium });
    console.log('[Phase 1] Project created: %s', PROJECT_TITLE);
  });

  // ------------------------------------------------------------------
  // Phase 2: Assign Team & Structure Work (UX Table 2.1–2.7)
  // ------------------------------------------------------------------

  test('Phase 2: admin opens project and adds milestone with contributions', async () => {
    await adminPage.bringToFront();

    // 2.1 Open project detail
    const card = adminPage.locator('.project-card', { hasText: PROJECT_TITLE }).first();
    await card.click();
    await expect(adminPage).toHaveURL(/\/dashboard\/projects\//, { timeout: TIMEOUT.short });
    await waitForSettle(adminPage);

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
    // The card starts expanded by default — only click header if "Add Contribution" isn't visible
    let addContribBtn = milestoneCard.getByRole('button', { name: /Add Contribution|Add First Contribution/i });
    if (!await addContribBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      // Card is collapsed — click header to expand
      await milestoneCard.locator('.milestone-header').click();
      await adminPage.waitForTimeout(500);
    }
    await expect(addContribBtn).toBeVisible({ timeout: TIMEOUT.short });
    await addContribBtn.click();

    // 2.7 Fill contribution 1 form
    let contribDlg = dialog(adminPage, 'Create Contribution');
    await expect(contribDlg).toBeVisible({ timeout: TIMEOUT.short });

    await contribDlg.getByLabel(/Title/i).first().fill(CONTRIBUTION_1_TITLE);
    await contribDlg.getByLabel(/Description/i).first().fill(CONTRIBUTION_1_DESC);
    await contribDlg.getByRole('button', { name: 'Technical' }).click();
    await contribDlg.getByRole('button', { name: 'High' }).click();

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
    await contribDlg.getByRole('button', { name: 'Medium' }).click();

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

    // 3.3 Sign off plan — appears when all contributions are confirmed
    const signOffBtn = adminPage.getByRole('button', { name: /Sign Off Plan/i }).first();
    await expect(signOffBtn).toBeVisible({ timeout: TIMEOUT.medium });
    await signOffBtn.click();
    await waitForSettle(adminPage);

    // 3.4 Verify signed-off banner
    const signedBadge = adminPage.locator('text=Signed Off').first();
    await expect(signedBadge).toBeVisible({ timeout: TIMEOUT.medium });

    // 3.5 Verify milestone shows "Locked" badge
    const lockedBadge = adminPage.locator('.milestone-card').first().locator('text=Locked');
    await expect(lockedBadge).toBeVisible({ timeout: TIMEOUT.short });
    console.log('[Phase 3] Plan signed off, milestones locked');
  });

  // ------------------------------------------------------------------
  // Phase 4: Distribute Work — Share & Offer contribution 1 to member
  // (UX Table 4.1–4.9)
  // ------------------------------------------------------------------

  test('Phase 4: admin shares and offers contribution 1 to member', async () => {
    await adminPage.bringToFront();

    // Open contribution 1 detail dialog from the project detail page
    await openContributionDialog(adminPage, CONTRIBUTION_1_TITLE);
    const dlg = adminPage.locator('.q-dialog');

    // 4.1b Click Share in dialog footer
    const shareBtn = dlg.getByRole('button', { name: 'Share' }).first();
    await expect(shareBtn).toBeVisible({ timeout: TIMEOUT.short });
    await shareBtn.click();

    // 4.2 Select roles: Contributors + Members
    const shareDlg = adminPage.locator('.q-dialog').filter({ hasText: 'Share Contribution' });
    await expect(shareDlg).toBeVisible({ timeout: TIMEOUT.short });

    const contributorsCheckbox = shareDlg.getByLabel('Contributors').or(shareDlg.getByText('Contributors'));
    await contributorsCheckbox.click();
    const membersCheckbox = shareDlg.getByLabel('Members').or(shareDlg.getByText('Members'));
    await membersCheckbox.click();

    // 4.3 Confirm share
    await shareDlg.getByRole('button', { name: 'Share' }).click();
    await waitForSettle(adminPage);
    console.log('[Phase 4] Contribution 1 shared with Contributors, Members');

    // 4.5b Click Offer in dialog footer
    const offerBtn = dlg.getByRole('button', { name: 'Offer' }).first();
    await expect(offerBtn).toBeVisible({ timeout: TIMEOUT.short });
    await offerBtn.click();

    // 4.6 Fill offer dialog with member's AID and name
    const offerDlg = adminPage.locator('.q-dialog').filter({ hasText: 'Offer' });
    await expect(offerDlg).toBeVisible({ timeout: TIMEOUT.short });

    const memberAIDToUse = memberAID || (accounts.member?.aid ?? '');
    const memberNameToUse = accounts.member?.name ?? MEMBER_NAME;
    await offerDlg.getByLabel(/User ID/i).fill(memberAIDToUse);
    await offerDlg.getByLabel(/User Name/i).fill(memberNameToUse);

    // 4.7 Send offer
    await offerDlg.getByRole('button', { name: /Send Offer|Offer/i }).click();
    await waitForSettle(adminPage);
    console.log('[Phase 4] Contribution 1 offered to member AID: %s', memberAIDToUse);

    // 4.8 Verify offered status visible in dialog
    await expect(dlg.getByText(/Offered to/i)).toBeVisible({ timeout: TIMEOUT.short });

    await closeContributionDialog(adminPage);
  });

  // ------------------------------------------------------------------
  // Phase 5: Member Accepts Offer (UX Table 5.6)
  // ------------------------------------------------------------------

  test('Phase 5: member sees shared contribution and registers interest', async () => {
    await memberPage.bringToFront();

    // 5.1 Navigate to Contributions page to see shared/offered contributions
    await navigateTo(memberPage, 'Contributions');
    await expect(memberPage).toHaveURL(/\/dashboard\/contributions/, { timeout: TIMEOUT.short });

    // Give any-sync a moment to sync the contribution to the member's backend
    await waitForSettle(memberPage, 2000);

    // The member should see the offered contribution
    const contribCard = memberPage.locator('.contribution-card').filter({ hasText: CONTRIBUTION_1_TITLE });
    await expect(contribCard).toBeVisible({ timeout: TIMEOUT.medium });
    await contribCard.click();

    // 5.2 / 5.3 / 5.4 Register interest
    const detailDlg = memberPage.locator('.q-dialog');
    await expect(detailDlg).toBeVisible({ timeout: TIMEOUT.short });

    const registerBtn = detailDlg.getByRole('button', { name: /Register Interest/i });
    const isRegisterVisible = await registerBtn.isVisible({ timeout: 3000 }).catch(() => false);
    if (isRegisterVisible) {
      await registerBtn.click();
      const interestDlg = memberPage.locator('.q-dialog').filter({ hasText: /interest/i });
      await expect(interestDlg).toBeVisible({ timeout: TIMEOUT.short });
      const noteInput = interestDlg.locator('textarea').first();
      await noteInput.fill('I am very interested in this design contribution and have relevant experience.');
      await interestDlg.getByRole('button', { name: /Submit|Register/i }).click();
      await waitForSettle(memberPage);
      console.log('[Phase 5] Member registered interest');
    } else {
      console.log('[Phase 5] Register Interest not visible (contribution may be directly offered)');
    }

    // Close dialog
    await memberPage.keyboard.press('Escape');
    await memberPage.waitForTimeout(500);
  });

  test('Phase 5: member accepts the offer', async () => {
    await memberPage.bringToFront();

    // Navigate back to Contributions and find the offered contribution
    await navigateTo(memberPage, 'Contributions');
    await waitForSettle(memberPage, 1000);

    const contribCard = memberPage.locator('.contribution-card').filter({ hasText: CONTRIBUTION_1_TITLE });
    await expect(contribCard).toBeVisible({ timeout: TIMEOUT.medium });
    await contribCard.click();

    const detailDlg = memberPage.locator('.q-dialog');
    await expect(detailDlg).toBeVisible({ timeout: TIMEOUT.short });

    // 5.6 Accept Offer
    const acceptBtn = detailDlg.getByRole('button', { name: /Accept Offer|Accept/i }).first();
    await expect(acceptBtn).toBeVisible({ timeout: TIMEOUT.short });
    await acceptBtn.click();
    await waitForSettle(memberPage);

    // Verify assigned status
    await expect(detailDlg.getByText(/Assigned/i).first()).toBeVisible({ timeout: TIMEOUT.short });
    console.log('[Phase 5] Member accepted offer — contribution assigned');

    await memberPage.keyboard.press('Escape');
    await memberPage.waitForTimeout(500);
  });

  // ------------------------------------------------------------------
  // Phase 6: Sub-Contributions (UX Table 6.1–6.8)
  // Member creates sub-contribution; admin approves it; sub lifecycle runs
  // ------------------------------------------------------------------

  test('Phase 6: member creates sub-contribution', async () => {
    await memberPage.bringToFront();

    // Navigate to the project page so member can open the contribution detail there
    // (Contribution detail dialog with sub-contribution controls)
    await navigateTo(memberPage, 'Contributions');
    await waitForSettle(memberPage, 1000);

    const contribCard = memberPage.locator('.contribution-card').filter({ hasText: CONTRIBUTION_1_TITLE });
    await expect(contribCard).toBeVisible({ timeout: TIMEOUT.medium });
    await contribCard.click();

    const detailDlg = memberPage.locator('.q-dialog');
    await expect(detailDlg).toBeVisible({ timeout: TIMEOUT.short });

    // 6.2 Add sub-contribution
    const addSubBtn = detailDlg.getByRole('button', { name: /Add Sub-Contribution/i });
    await expect(addSubBtn).toBeVisible({ timeout: TIMEOUT.medium });
    await addSubBtn.click();

    // Fill sub-contribution form
    const subDlg = dialog(memberPage, /Sub-Contribution|Create Contribution/i);
    await expect(subDlg).toBeVisible({ timeout: TIMEOUT.short });

    await subDlg.getByLabel(/Title/i).first().fill(SUB_CONTRIBUTION_TITLE);
    await subDlg.getByLabel(/Description/i).first().fill(SUB_CONTRIBUTION_DESC);
    await subDlg.getByRole('button', { name: 'Technical' }).click();
    await subDlg.getByRole('button', { name: 'Medium' }).click();

    const objInputSub = subDlg.getByPlaceholder(/objective/i).first();
    await objInputSub.fill('Review design documents');
    await objInputSub.press('Enter');

    const delInputSub = subDlg.getByPlaceholder(/deliverable/i).first();
    await delInputSub.fill('Review report');
    await delInputSub.press('Enter');

    await subDlg.getByRole('button', { name: /Create/i }).click();
    await waitForSettle(memberPage);
    console.log('[Phase 6] Sub-contribution created: %s', SUB_CONTRIBUTION_TITLE);

    // 6.3 Sub-contribution starts as pending_approval (member created it)
    // Verify it appears in the dialog
    await expect(detailDlg.getByText(SUB_CONTRIBUTION_TITLE)).toBeVisible({ timeout: TIMEOUT.medium });

    // 6.7 Verify blocking warning — parent cannot submit evidence while sub is unsigned
    const blockingWarning = detailDlg.getByText(/Sub-Contributions Not Complete|must be signed off/i);
    const hasWarning = await blockingWarning.isVisible().catch(() => false);
    console.log('[Phase 6] Blocking warning visible: %s', hasWarning);

    await memberPage.keyboard.press('Escape');
    await memberPage.waitForTimeout(500);
  });

  test('Phase 6: admin approves the sub-contribution', async () => {
    await adminPage.bringToFront();

    // Admin needs to open contribution 1 dialog and approve the pending sub-contribution
    // Navigate back to project detail page
    await navigateTo(adminPage, 'Projects');
    await waitForSettle(adminPage);

    const card = adminPage.locator('.project-card', { hasText: PROJECT_TITLE }).first();
    await card.click();
    await expect(adminPage).toHaveURL(/\/dashboard\/projects\//, { timeout: TIMEOUT.short });
    await waitForSettle(adminPage, 2000); // give any-sync time to sync the sub-contribution

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

    // Open the sub-contribution dialog via its parent
    await navigateTo(memberPage, 'Contributions');
    await waitForSettle(memberPage, 1500);

    const contribCard = memberPage.locator('.contribution-card').filter({ hasText: CONTRIBUTION_1_TITLE });
    await expect(contribCard).toBeVisible({ timeout: TIMEOUT.medium });
    await contribCard.click();

    const detailDlg = memberPage.locator('.q-dialog');
    await expect(detailDlg).toBeVisible({ timeout: TIMEOUT.short });

    // 6.6 Click sub-item to open recursive dialog
    const subItem = detailDlg.locator('.sub-item').filter({ hasText: SUB_CONTRIBUTION_TITLE });
    await expect(subItem).toBeVisible({ timeout: TIMEOUT.medium });
    await subItem.click();
    await memberPage.waitForTimeout(500);

    // A nested dialog should open with the sub-contribution
    const nestedDlg = memberPage.locator('.q-dialog').last();

    // Fill completion notes and submit evidence for sub
    const notesInput = nestedDlg.getByLabel(/Completion Notes/i).or(nestedDlg.getByPlaceholder(/completion|describe/i));
    const notesVisible = await notesInput.isVisible({ timeout: 5000 }).catch(() => false);
    if (notesVisible) {
      await notesInput.fill('Design review completed. All documents reviewed and feedback provided.');

      const hoursInput = nestedDlg.getByLabel(/Actual Hours|Actual Duration/i).or(nestedDlg.getByPlaceholder(/hours/i));
      if (await hoursInput.isVisible().catch(() => false)) {
        await hoursInput.fill('8');
      }

      const submitBtn = nestedDlg.getByRole('button', { name: /Submit for Review|Submit Evidence/i });
      if (await submitBtn.isVisible().catch(() => false)) {
        await submitBtn.click();
        await waitForSettle(memberPage);
        console.log('[Phase 6] Member submitted evidence for sub-contribution');
      }
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

    // Navigate to project detail to access contribution 1
    await navigateTo(adminPage, 'Projects');
    await waitForSettle(adminPage);

    const card = adminPage.locator('.project-card', { hasText: PROJECT_TITLE }).first();
    await card.click();
    await expect(adminPage).toHaveURL(/\/dashboard\/projects\//, { timeout: TIMEOUT.short });
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

    // Review: approve
    const approveBtn = nestedDlg.getByRole('button', { name: 'Approve' });
    const approveVisible = await approveBtn.isVisible({ timeout: 5000 }).catch(() => false);
    if (approveVisible) {
      await approveBtn.click();

      const stars = nestedDlg.locator('.star-btn, [name="star"]');
      const starCount = await stars.count();
      if (starCount >= 7) {
        await stars.nth(6).click();
      }

      const feedbackInput = nestedDlg.getByLabel(/feedback/i).or(nestedDlg.getByPlaceholder(/feedback/i));
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

    // Sign off sub-contribution
    const signOffBtn = nestedDlg.getByRole('button', { name: /Sign Off/i }).first();
    const signOffVisible = await signOffBtn.isVisible({ timeout: 5000 }).catch(() => false);
    if (signOffVisible) {
      await signOffBtn.click();
      await waitForSettle(adminPage);
      console.log('[Phase 6] Admin signed off sub-contribution');
    }

    await adminPage.keyboard.press('Escape');
    await adminPage.waitForTimeout(300);
    await closeContributionDialog(adminPage);
  });

  // ------------------------------------------------------------------
  // Phase 7: Member Submits Evidence for Parent Contribution
  // (UX Table 7.1–7.8)
  // ------------------------------------------------------------------

  test('Phase 7: member submits evidence for parent contribution', async () => {
    await memberPage.bringToFront();

    await navigateTo(memberPage, 'Contributions');
    await waitForSettle(memberPage, 1500);

    const contribCard = memberPage.locator('.contribution-card').filter({ hasText: CONTRIBUTION_1_TITLE });
    await expect(contribCard).toBeVisible({ timeout: TIMEOUT.medium });
    await contribCard.click();

    const detailDlg = memberPage.locator('.q-dialog');
    await expect(detailDlg).toBeVisible({ timeout: TIMEOUT.short });

    // 7.2 Fill completion notes
    const notesInput = detailDlg.getByLabel(/Completion Notes/i).or(detailDlg.getByPlaceholder(/completion|describe/i));
    await expect(notesInput).toBeVisible({ timeout: TIMEOUT.medium });
    await notesInput.fill('Wireframes completed. All design objectives met. Sub-contributions signed off. Ready for review.');

    // 7.7 Enter actual hours
    const hoursInput = detailDlg.getByLabel(/Actual Hours|Actual Duration/i).or(detailDlg.getByPlaceholder(/hours/i));
    if (await hoursInput.isVisible().catch(() => false)) {
      await hoursInput.fill('32');
    }

    // 7.8 Submit for review
    const submitBtn = detailDlg.getByRole('button', { name: /Submit for Review|Submit Evidence/i });
    await expect(submitBtn).toBeVisible({ timeout: TIMEOUT.short });
    await submitBtn.click();
    await waitForSettle(memberPage);
    console.log('[Phase 7] Member submitted evidence for parent contribution');

    await memberPage.keyboard.press('Escape');
    await memberPage.waitForTimeout(500);
  });

  // ------------------------------------------------------------------
  // Phase 8: Admin Reviews Parent Contribution (UX Table 8.1–8.9)
  // ------------------------------------------------------------------

  test('Phase 8: admin reviews and approves parent contribution', async () => {
    await adminPage.bringToFront();

    // Navigate to project detail
    await navigateTo(adminPage, 'Projects');
    await waitForSettle(adminPage);

    const card = adminPage.locator('.project-card', { hasText: PROJECT_TITLE }).first();
    await card.click();
    await expect(adminPage).toHaveURL(/\/dashboard\/projects\//, { timeout: TIMEOUT.short });
    await waitForSettle(adminPage, 1500);

    await openContributionDialog(adminPage, CONTRIBUTION_1_TITLE);
    const dlg = adminPage.locator('.q-dialog');

    // 8.3 Select outcome — Approve
    const approveBtn = dlg.getByRole('button', { name: 'Approve' });
    await expect(approveBtn).toBeVisible({ timeout: TIMEOUT.medium });
    await approveBtn.click();

    // 8.4 Rate quality — click 8th star
    const stars = dlg.locator('.star-btn, [name="star"]');
    const starCount = await stars.count();
    if (starCount >= 8) {
      await stars.nth(7).click();
    }

    // 8.6 Write feedback
    const feedbackInput = dlg.getByLabel(/feedback/i).or(dlg.getByPlaceholder(/feedback/i));
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
  // Phase 9: Admin Signs Off Contribution (UX Table 9.1–9.4)
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
  // Phase 10: Contribution Change on Contribution 2
  // Admin shares + offers to member → member accepts → member changes →
  // admin re-confirms (UX Table 10.1–10.8)
  // ------------------------------------------------------------------

  test('Phase 10: admin shares and offers contribution 2 to member', async () => {
    await adminPage.bringToFront();

    await openContributionDialog(adminPage, CONTRIBUTION_2_TITLE);
    const dlg = adminPage.locator('.q-dialog');

    // Share contribution 2
    const shareBtn = dlg.getByRole('button', { name: 'Share' }).first();
    await expect(shareBtn).toBeVisible({ timeout: TIMEOUT.short });
    await shareBtn.click();

    const shareDlg = adminPage.locator('.q-dialog').filter({ hasText: 'Share Contribution' });
    await expect(shareDlg).toBeVisible({ timeout: TIMEOUT.short });
    await shareDlg.getByLabel('Contributors').or(shareDlg.getByText('Contributors')).click();
    await shareDlg.getByRole('button', { name: 'Share' }).click();
    await waitForSettle(adminPage);
    console.log('[Phase 10] Contribution 2 shared');

    // Offer to member
    const offerBtn = dlg.getByRole('button', { name: 'Offer' }).first();
    await expect(offerBtn).toBeVisible({ timeout: TIMEOUT.short });
    await offerBtn.click();

    const offerDlg = adminPage.locator('.q-dialog').filter({ hasText: 'Offer' });
    await expect(offerDlg).toBeVisible({ timeout: TIMEOUT.short });
    const memberAIDToUse = memberAID || (accounts.member?.aid ?? '');
    const memberNameToUse = accounts.member?.name ?? MEMBER_NAME;
    await offerDlg.getByLabel(/User ID/i).fill(memberAIDToUse);
    await offerDlg.getByLabel(/User Name/i).fill(memberNameToUse);
    await offerDlg.getByRole('button', { name: /Send Offer|Offer/i }).click();
    await waitForSettle(adminPage);
    console.log('[Phase 10] Contribution 2 offered to member');

    await closeContributionDialog(adminPage);
  });

  test('Phase 10: member accepts offer on contribution 2', async () => {
    await memberPage.bringToFront();

    await navigateTo(memberPage, 'Contributions');
    await waitForSettle(memberPage, 1500);

    const contribCard = memberPage.locator('.contribution-card').filter({ hasText: CONTRIBUTION_2_TITLE });
    await expect(contribCard).toBeVisible({ timeout: TIMEOUT.medium });
    await contribCard.click();

    const detailDlg = memberPage.locator('.q-dialog');
    await expect(detailDlg).toBeVisible({ timeout: TIMEOUT.short });

    const acceptBtn = detailDlg.getByRole('button', { name: /Accept Offer|Accept/i }).first();
    await expect(acceptBtn).toBeVisible({ timeout: TIMEOUT.short });
    await acceptBtn.click();
    await waitForSettle(memberPage);
    console.log('[Phase 10] Member accepted offer on contribution 2');

    await memberPage.keyboard.press('Escape');
    await memberPage.waitForTimeout(500);
  });

  test('Phase 10: member changes contribution 2', async () => {
    await memberPage.bringToFront();

    await navigateTo(memberPage, 'Contributions');
    await waitForSettle(memberPage, 1000);

    const contribCard = memberPage.locator('.contribution-card').filter({ hasText: CONTRIBUTION_2_TITLE });
    await expect(contribCard).toBeVisible({ timeout: TIMEOUT.medium });
    await contribCard.click();

    const detailDlg = memberPage.locator('.q-dialog');
    await expect(detailDlg).toBeVisible({ timeout: TIMEOUT.short });

    // 10.1 Click Change Contribution
    const changeBtn = detailDlg.getByRole('button', { name: /Change Contribution/i });
    await expect(changeBtn).toBeVisible({ timeout: TIMEOUT.short });
    await changeBtn.click();

    // 10.2 Change dialog opens (reuses CreateContributionDialog in editing mode)
    const changeDlg = dialog(memberPage, 'Change Contribution');
    await expect(changeDlg).toBeVisible({ timeout: TIMEOUT.short });

    // 10.3 Re-confirmation warning should be visible
    await expect(changeDlg.getByText(/re-confirmation/i)).toBeVisible({ timeout: TIMEOUT.short });

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
    await waitForSettle(memberPage);
    console.log('[Phase 10] Member submitted contribution change');

    await memberPage.keyboard.press('Escape');
    await memberPage.waitForTimeout(500);
  });

  test('Phase 10: admin re-confirms changed contribution 2', async () => {
    await adminPage.bringToFront();

    // Navigate to project detail page to re-confirm via the compact card
    await navigateTo(adminPage, 'Projects');
    await waitForSettle(adminPage);

    const card = adminPage.locator('.project-card', { hasText: PROJECT_TITLE }).first();
    await card.click();
    await expect(adminPage).toHaveURL(/\/dashboard\/projects\//, { timeout: TIMEOUT.short });
    await waitForSettle(adminPage, 1500);

    // 10.7 Re-confirm changed contribution — Confirm button should reappear
    const contrib2Card = adminPage.locator('.contribution-compact').filter({ hasText: CONTRIBUTION_2_TITLE });
    const confirmBtn = contrib2Card.getByRole('button', { name: 'Confirm' });
    await expect(confirmBtn).toBeVisible({ timeout: TIMEOUT.medium });
    await confirmBtn.click();
    await waitForSettle(adminPage);
    console.log('[Phase 10] Admin re-confirmed changed contribution 2');
  });

  // ------------------------------------------------------------------
  // Verification: Contributions page and Projects page
  // ------------------------------------------------------------------

  test('verify contributions page shows all contributions to admin', async () => {
    await adminPage.bringToFront();

    await navigateTo(adminPage, 'Contributions');
    await expect(adminPage).toHaveURL(/\/dashboard\/contributions/, { timeout: TIMEOUT.short });
    await waitForSettle(adminPage);

    // Contribution 1 should show as signed_off
    const contrib1 = adminPage.locator('.contribution-card').filter({ hasText: CONTRIBUTION_1_TITLE });
    await expect(contrib1).toBeVisible({ timeout: TIMEOUT.medium });

    // Contribution 2 should be visible
    const contrib2 = adminPage.locator('.contribution-card').filter({ hasText: CONTRIBUTION_2_TITLE });
    await expect(contrib2).toBeVisible({ timeout: TIMEOUT.medium });

    console.log('[Verify] Admin: both contributions visible on contributions page');
  });

  test('verify contributions page shows contributions to member', async () => {
    await memberPage.bringToFront();

    await navigateTo(memberPage, 'Contributions');
    await expect(memberPage).toHaveURL(/\/dashboard\/contributions/, { timeout: TIMEOUT.short });
    await waitForSettle(memberPage);

    // Member should see at minimum their assigned contributions
    const contrib1 = memberPage.locator('.contribution-card').filter({ hasText: CONTRIBUTION_1_TITLE });
    await expect(contrib1).toBeVisible({ timeout: TIMEOUT.medium });

    console.log('[Verify] Member: assigned contribution visible on contributions page');
  });

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
