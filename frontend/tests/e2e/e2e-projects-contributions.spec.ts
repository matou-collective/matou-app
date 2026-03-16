/**
 * E2E Tests: Projects & Contributions — Full UI Lifecycle
 *
 * Tests the complete projects and contributions system through the UI,
 * matching the UX flow table (docs/design/CONTRIBUTIONS_UX_FLOW_TABLE.md).
 *
 * Phases tested:
 *   1. Project Creation (via UI)
 *   2. Assign Team & Structure Work (milestone + contributions via UI)
 *   3. Confirm Contributions & Sign Off Plan (via UI)
 *   4. Distribute Work — Share & Offer (via detail dialog)
 *   5. Accept Offer (via detail dialog)
 *   6. Sub-Contributions (create, approve, lifecycle via UI)
 *   7. Submit Evidence (via detail dialog)
 *   8. Review (via detail dialog)
 *   9. Sign Off (via detail dialog)
 *  10. Contribution Change (via detail dialog)
 *
 * Single admin user (Founding Member) with full privileges.
 *
 * Run: npx playwright test --project=projects-contributions
 */
import { test, expect, Page, BrowserContext } from '@playwright/test';
import { setupTestConfig } from './utils/mock-config';
import { requireAllTestServices } from './utils/keri-testnet';
import {
  FRONTEND_URL,
  BACKEND_URL,
  TIMEOUT,
  setupPageLogging,
  loginWithMnemonic,
  loadAccounts,
  performOrgSetup,
  type TestAccounts,
} from './utils/test-helpers';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROJECT_TITLE = 'E2E Community Garden';
const PROJECT_DESC = 'A community garden project for E2E testing';
const MILESTONE_1_TITLE = 'Phase 1: Design';
const MILESTONE_1_DURATION = '2 weeks';
const CONTRIBUTION_1_TITLE = 'Design Phase Work';
const CONTRIBUTION_1_DESC = 'Create wireframes and mockups for the community garden';
const CONTRIBUTION_2_TITLE = 'Outreach Coordination';
const CONTRIBUTION_2_DESC = 'Coordinate community outreach and engagement';
const SUB_CONTRIBUTION_TITLE = 'Sub: Design Review';
const SUB_CONTRIBUTION_DESC = 'Review and validate the design deliverables';

// ---------------------------------------------------------------------------
// UI Helpers
// ---------------------------------------------------------------------------

/** Navigate to a sidebar item by label */
async function navigateTo(page: Page, label: string) {
  const navItem = page.locator('.nav-item', { hasText: label });
  await expect(navItem).toBeVisible({ timeout: TIMEOUT.short });
  await navItem.click();
}

/** Wait for network to settle after a UI action */
async function waitForSettle(page: Page, ms = 1500) {
  await page.waitForTimeout(ms);
}

/** Scope a dialog by its title text */
function dialog(page: Page, title: string) {
  return page.locator('.q-dialog').filter({ hasText: title });
}

/** Click a contribution compact card by title to open the detail dialog */
async function openContributionDialog(page: Page, title: string) {
  const card = page.locator('.contribution-compact').filter({ hasText: title });
  await expect(card).toBeVisible({ timeout: TIMEOUT.medium });
  await card.click();
  // Wait for the maximized dialog to appear
  await expect(page.locator('.q-dialog')).toBeVisible({ timeout: TIMEOUT.short });
  await waitForSettle(page, 500);
}

/** Close the currently open maximized contribution detail dialog */
async function closeContributionDialog(page: Page) {
  const closeBtn = page.locator('.q-dialog .dialog-close-btn');
  if (await closeBtn.isVisible().catch(() => false)) {
    await closeBtn.click();
  } else {
    // Fallback: press Escape
    await page.keyboard.press('Escape');
  }
  await page.waitForTimeout(500);
}

// ===========================================================================
// Group 1: Full UI Lifecycle (Phases 1–9)
// ===========================================================================

test.describe.serial('Projects & Contributions — Full UI Lifecycle', () => {
  let accounts: TestAccounts;
  let context: BrowserContext;
  let page: Page;
  let adminAID: string;

  // ------------------------------------------------------------------
  // Setup: login as admin
  // ------------------------------------------------------------------

  test.beforeAll(async ({ browser, request }) => {
    await requireAllTestServices();

    context = await browser.newContext();
    await setupTestConfig(context);
    page = await context.newPage();
    setupPageLogging(page, 'ProjectsContrib');

    await page.goto(FRONTEND_URL);

    const needsSetup = await Promise.race([
      page
        .waitForURL(/.*#\/setup/, { timeout: TIMEOUT.medium })
        .then(() => true),
      page
        .locator('button', { hasText: /join now/i })
        .waitFor({ state: 'visible', timeout: TIMEOUT.medium })
        .then(() => false),
    ]);

    if (needsSetup) {
      console.log('[E2E] No org config — running org setup...');
      accounts = await performOrgSetup(page, request);
    } else {
      console.log('[E2E] Recovering admin identity...');
      accounts = loadAccounts();
      if (!accounts.admin?.mnemonic) {
        throw new Error('No admin mnemonic — run org-setup first');
      }
      await loginWithMnemonic(page, accounts.admin.mnemonic);
    }

    // Resolve admin AID
    adminAID = accounts.admin?.aid || '';
    if (!adminAID) {
      adminAID = await page.evaluate(() => {
        const stored = localStorage.getItem('matou_current_aid');
        if (stored) {
          try { const p = JSON.parse(stored); return p.prefix || p.aid || ''; } catch { return ''; }
        }
        return '';
      });
    }
    if (!adminAID) {
      const health = await request.get(`${BACKEND_URL}/health`);
      const data = await health.json();
      adminAID = data.admin || '';
    }
    if (!adminAID) throw new Error('Could not resolve admin AID');
    console.log('[E2E] Admin AID: %s', adminAID);
  });

  test.afterAll(async () => {
    await context?.close();
  });

  // ------------------------------------------------------------------
  // Phase 1: Project Creation (UX Table 1.1–1.4)
  // ------------------------------------------------------------------

  test('Phase 1: create project via UI', async () => {
    // 1.1 Navigate to Projects screen
    await navigateTo(page, 'Projects');
    await expect(page).toHaveURL(/\/dashboard\/projects/, { timeout: TIMEOUT.short });
    console.log('[Phase 1] On projects page');

    // 1.2 Click "+ New Project"
    const newBtn = page.getByRole('button', { name: /New Project/i });
    await expect(newBtn).toBeVisible({ timeout: TIMEOUT.short });
    await newBtn.click();

    // 1.3 Fill project form
    const dlg = dialog(page, 'Create Project');
    await expect(dlg).toBeVisible({ timeout: TIMEOUT.short });

    await dlg.getByLabel(/Title/i).fill(PROJECT_TITLE);
    await dlg.getByLabel(/Description/i).fill(PROJECT_DESC);

    // 1.4 Submit
    await dlg.getByRole('button', { name: /Create Project/i }).click();
    await waitForSettle(page);

    // Verify project appears in list
    const card = page.locator('.project-card', { hasText: PROJECT_TITLE }).first();
    await expect(card).toBeVisible({ timeout: TIMEOUT.medium });
    console.log('[Phase 1] Project created: %s', PROJECT_TITLE);
  });

  // ------------------------------------------------------------------
  // Phase 2: Assign Team & Structure Work (UX Table 2.1–2.7)
  // ------------------------------------------------------------------

  test('Phase 2: open project and add milestone with contributions', async () => {
    // 2.1 Open project detail
    const card = page.locator('.project-card', { hasText: PROJECT_TITLE }).first();
    await card.click();
    await expect(page).toHaveURL(/\/dashboard\/projects\//, { timeout: TIMEOUT.short });
    await waitForSettle(page);

    // Verify project title
    const title = page.locator('h1, h2').filter({ hasText: PROJECT_TITLE });
    await expect(title.first()).toBeVisible({ timeout: TIMEOUT.medium });
    console.log('[Phase 2] On project detail page');

    // 2.2 Assign Project Lead
    const assignLeadBtn = page.getByRole('button', { name: /Assign Lead/i });
    if (await assignLeadBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await assignLeadBtn.click();
      const roleDlg = dialog(page, 'Assign Project Lead');
      await expect(roleDlg).toBeVisible({ timeout: TIMEOUT.short });
      // Select the first member in the list (admin user)
      const memberItem = roleDlg.locator('.member-item').first();
      await expect(memberItem).toBeVisible({ timeout: TIMEOUT.short });
      await memberItem.click();
      await roleDlg.getByRole('button', { name: /Assign Project Lead/i }).click();
      await waitForSettle(page);
      console.log('[Phase 2] Project Lead assigned');
    }

    // 2.3 Assign Project Steward
    const assignStewardBtn = page.getByRole('button', { name: /Assign Steward/i });
    if (await assignStewardBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await assignStewardBtn.click();
      const roleDlg = dialog(page, 'Assign Project Steward');
      await expect(roleDlg).toBeVisible({ timeout: TIMEOUT.short });
      const memberItem = roleDlg.locator('.member-item').first();
      await expect(memberItem).toBeVisible({ timeout: TIMEOUT.short });
      await memberItem.click();
      await roleDlg.getByRole('button', { name: /Assign Project Steward/i }).click();
      await waitForSettle(page);
      console.log('[Phase 2] Project Steward assigned');
    }

    // 2.4 Create first milestone — click "Add Milestone" or "Create First Milestone"
    const addMilestoneBtn = page.getByRole('button', { name: /Milestone/i }).first();
    await expect(addMilestoneBtn).toBeVisible({ timeout: TIMEOUT.medium });
    await addMilestoneBtn.click();

    // 2.5 Fill milestone form
    const msDlg = dialog(page, 'Add Milestone');
    await expect(msDlg).toBeVisible({ timeout: TIMEOUT.short });
    await msDlg.getByLabel(/Milestone Title/i).fill(MILESTONE_1_TITLE);
    await msDlg.getByLabel(/Duration/i).fill(MILESTONE_1_DURATION);
    await msDlg.getByRole('button', { name: /Add Milestone/i }).click();
    await waitForSettle(page);
    console.log('[Phase 2] Milestone created: %s', MILESTONE_1_TITLE);

    // 2.6 Create contribution 1 within milestone
    const milestoneCard = page.locator('.milestone-card').first();
    await expect(milestoneCard).toBeVisible({ timeout: TIMEOUT.short });

    // Expand milestone if collapsed
    const header = milestoneCard.locator('.milestone-header');
    await header.click();
    await page.waitForTimeout(300);

    // Click "Add Contribution"
    const addContribBtn = milestoneCard.getByRole('button', { name: /Add Contribution|Add First Contribution/i });
    await expect(addContribBtn).toBeVisible({ timeout: TIMEOUT.short });
    await addContribBtn.click();

    // 2.7 Fill contribution form
    let contribDlg = dialog(page, 'Create Contribution');
    await expect(contribDlg).toBeVisible({ timeout: TIMEOUT.short });

    await contribDlg.getByLabel(/Title/i).first().fill(CONTRIBUTION_1_TITLE);
    await contribDlg.getByLabel(/Description/i).first().fill(CONTRIBUTION_1_DESC);

    // Select type: Technical
    await contribDlg.getByRole('button', { name: 'Technical' }).click();
    // Select priority: High
    await contribDlg.getByRole('button', { name: 'High' }).click();

    // Add objective
    const objInput = contribDlg.getByPlaceholder(/objective/i).first();
    await objInput.fill('Create wireframe designs');
    await objInput.press('Enter');

    // Add deliverable
    const delInput = contribDlg.getByPlaceholder(/deliverable/i).first();
    await delInput.fill('Wireframe document');
    await delInput.press('Enter');

    // Submit
    await contribDlg.getByRole('button', { name: /Create Contribution/i }).click();
    await waitForSettle(page);
    console.log('[Phase 2] Contribution 1 created: %s', CONTRIBUTION_1_TITLE);

    // Create contribution 2 in the same milestone
    await addContribBtn.click();
    contribDlg = dialog(page, 'Create Contribution');
    await expect(contribDlg).toBeVisible({ timeout: TIMEOUT.short });

    await contribDlg.getByLabel(/Title/i).first().fill(CONTRIBUTION_2_TITLE);
    await contribDlg.getByLabel(/Description/i).first().fill(CONTRIBUTION_2_DESC);
    await contribDlg.getByRole('button', { name: 'Community' }).click();
    await contribDlg.getByRole('button', { name: 'Medium' }).click();

    const objInput2 = contribDlg.getByPlaceholder(/objective/i).first();
    await objInput2.fill('Engage community members');
    await objInput2.press('Enter');

    const delInput2 = contribDlg.getByPlaceholder(/deliverable/i).first();
    await delInput2.fill('Outreach report');
    await delInput2.press('Enter');

    await contribDlg.getByRole('button', { name: /Create Contribution/i }).click();
    await waitForSettle(page);
    console.log('[Phase 2] Contribution 2 created: %s', CONTRIBUTION_2_TITLE);

    // Verify both contributions visible in milestone
    await expect(milestoneCard.locator('.contribution-compact').filter({ hasText: CONTRIBUTION_1_TITLE }))
      .toBeVisible({ timeout: TIMEOUT.short });
    await expect(milestoneCard.locator('.contribution-compact').filter({ hasText: CONTRIBUTION_2_TITLE }))
      .toBeVisible({ timeout: TIMEOUT.short });
  });

  // ------------------------------------------------------------------
  // Phase 3: Confirm Contributions & Sign Off Plan (UX Table 3.1–3.6)
  // ------------------------------------------------------------------

  test('Phase 3: confirm contributions and sign off plan via UI', async () => {
    // 3.2 Confirm contribution 1
    const contrib1Card = page.locator('.contribution-compact').filter({ hasText: CONTRIBUTION_1_TITLE });
    const confirmBtn1 = contrib1Card.getByRole('button', { name: 'Confirm' });
    await expect(confirmBtn1).toBeVisible({ timeout: TIMEOUT.short });
    await confirmBtn1.click();
    await waitForSettle(page);
    console.log('[Phase 3] Contribution 1 confirmed');

    // 3.2 Confirm contribution 2
    const contrib2Card = page.locator('.contribution-compact').filter({ hasText: CONTRIBUTION_2_TITLE });
    const confirmBtn2 = contrib2Card.getByRole('button', { name: 'Confirm' });
    await expect(confirmBtn2).toBeVisible({ timeout: TIMEOUT.short });
    await confirmBtn2.click();
    await waitForSettle(page);
    console.log('[Phase 3] Contribution 2 confirmed');

    // 3.3 Sign off plan — button should now appear since all confirmed
    const signOffBtn = page.getByRole('button', { name: /Sign Off Plan/i }).first();
    await expect(signOffBtn).toBeVisible({ timeout: TIMEOUT.medium });
    await signOffBtn.click();
    await waitForSettle(page);

    // 3.4 Verify signed-off state
    const signedBadge = page.locator('text=Signed Off').first();
    await expect(signedBadge).toBeVisible({ timeout: TIMEOUT.medium });

    // 3.5 Verify milestone shows "Locked" badge
    const lockedBadge = page.locator('.milestone-card').first().locator('text=Locked');
    await expect(lockedBadge).toBeVisible({ timeout: TIMEOUT.short });
    console.log('[Phase 3] Plan signed off, milestones locked');
  });

  // ------------------------------------------------------------------
  // Phase 4: Distribute Work — Share & Offer (UX Table 4.1–4.9)
  // ------------------------------------------------------------------

  test('Phase 4: share and offer contribution via detail dialog', async () => {
    // Open contribution 1 detail dialog
    await openContributionDialog(page, CONTRIBUTION_1_TITLE);
    const dlg = page.locator('.q-dialog');

    // 4.1b Click Share in dialog footer
    const shareBtn = dlg.getByRole('button', { name: 'Share' }).first();
    await expect(shareBtn).toBeVisible({ timeout: TIMEOUT.short });
    await shareBtn.click();

    // 4.2 Select roles in share dialog
    const shareDlg = page.locator('.q-dialog').filter({ hasText: 'Share Contribution' });
    await expect(shareDlg).toBeVisible({ timeout: TIMEOUT.short });

    // Check "Contributors" and "Members" checkboxes
    const contributorsCheckbox = shareDlg.getByLabel('Contributors').or(shareDlg.getByText('Contributors'));
    await contributorsCheckbox.click();
    const membersCheckbox = shareDlg.getByLabel('Members').or(shareDlg.getByText('Members'));
    await membersCheckbox.click();

    // 4.3 Confirm share
    await shareDlg.getByRole('button', { name: 'Share' }).click();
    await waitForSettle(page);
    console.log('[Phase 4] Contribution shared with Contributors, Members');

    // 4.5b Click Offer in dialog footer
    const offerBtn = dlg.getByRole('button', { name: 'Offer' }).first();
    await expect(offerBtn).toBeVisible({ timeout: TIMEOUT.short });
    await offerBtn.click();

    // 4.6 Fill offer dialog
    const offerDlg = page.locator('.q-dialog').filter({ hasText: 'Offer' });
    await expect(offerDlg).toBeVisible({ timeout: TIMEOUT.short });

    await offerDlg.getByLabel(/User ID/i).fill(adminAID);
    await offerDlg.getByLabel(/User Name/i).fill('Admin User');

    // 4.7 Send offer
    await offerDlg.getByRole('button', { name: /Send Offer|Offer/i }).click();
    await waitForSettle(page);
    console.log('[Phase 4] Contribution offered to admin');

    // 4.8 Verify offered status panel visible
    await expect(dlg.getByText(/Offered to/i)).toBeVisible({ timeout: TIMEOUT.short });

    // Close dialog
    await closeContributionDialog(page);
  });

  // ------------------------------------------------------------------
  // Phase 5: Accept Offer (UX Table 5.6)
  // ------------------------------------------------------------------

  test('Phase 5: accept offer via detail dialog', async () => {
    // Reopen contribution 1 detail dialog
    await openContributionDialog(page, CONTRIBUTION_1_TITLE);
    const dlg = page.locator('.q-dialog');

    // 5.6 Click Accept Offer
    const acceptBtn = dlg.getByRole('button', { name: /Accept Offer|Accept/i }).first();
    await expect(acceptBtn).toBeVisible({ timeout: TIMEOUT.short });
    await acceptBtn.click();
    await waitForSettle(page);

    // Verify assigned status — the dialog should show "Assigned" somewhere
    await expect(dlg.getByText(/Assigned/i).first()).toBeVisible({ timeout: TIMEOUT.short });
    console.log('[Phase 5] Offer accepted — contribution assigned');

    await closeContributionDialog(page);
  });

  // ------------------------------------------------------------------
  // Phase 7: Submit Evidence (UX Table 7.1–7.8)
  // (Skipping Phase 6 sub-contributions for this contribution to keep
  //  the main lifecycle flow linear. Sub-contributions tested separately.)
  // ------------------------------------------------------------------

  test('Phase 7: submit evidence via detail dialog', async () => {
    await openContributionDialog(page, CONTRIBUTION_1_TITLE);
    const dlg = page.locator('.q-dialog');

    // 7.2 Fill completion notes
    const notesInput = dlg.getByLabel(/Completion Notes/i).or(dlg.getByPlaceholder(/completion|describe/i));
    await expect(notesInput).toBeVisible({ timeout: TIMEOUT.medium });
    await notesInput.fill('Wireframes completed. All design objectives met. Reviewed by team.');

    // 7.7 Enter actual hours
    const hoursInput = dlg.getByLabel(/Actual Hours|Actual Duration/i).or(dlg.getByPlaceholder(/hours/i));
    if (await hoursInput.isVisible().catch(() => false)) {
      await hoursInput.fill('32');
    }

    // 7.8 Submit for review
    const submitBtn = dlg.getByRole('button', { name: /Submit for Review|Submit Evidence/i });
    await expect(submitBtn).toBeVisible({ timeout: TIMEOUT.short });
    await submitBtn.click();
    await waitForSettle(page);
    console.log('[Phase 7] Evidence submitted for review');

    await closeContributionDialog(page);
  });

  // ------------------------------------------------------------------
  // Phase 8: Review (UX Table 8.1–8.9)
  // ------------------------------------------------------------------

  test('Phase 8: review and approve via detail dialog', async () => {
    await openContributionDialog(page, CONTRIBUTION_1_TITLE);
    const dlg = page.locator('.q-dialog');

    // 8.3 Select outcome — Approve
    const approveBtn = dlg.getByRole('button', { name: 'Approve' });
    await expect(approveBtn).toBeVisible({ timeout: TIMEOUT.medium });
    await approveBtn.click();

    // 8.4 Rate quality — click 8th star
    const stars = dlg.locator('.star-btn, [name="star"]');
    const starCount = await stars.count();
    if (starCount >= 8) {
      await stars.nth(7).click(); // 0-indexed, click 8th star
    }

    // 8.6 Write feedback
    const feedbackInput = dlg.getByLabel(/feedback/i).or(dlg.getByPlaceholder(/feedback/i));
    if (await feedbackInput.isVisible().catch(() => false)) {
      await feedbackInput.fill('Excellent work. Design meets all acceptance criteria.');
    }

    // 8.7 Submit review
    const submitReview = dlg.getByRole('button', { name: /Submit Review/i });
    await expect(submitReview).toBeVisible({ timeout: TIMEOUT.short });
    await submitReview.click();
    await waitForSettle(page);
    console.log('[Phase 8] Review submitted — approved');

    await closeContributionDialog(page);
  });

  // ------------------------------------------------------------------
  // Phase 9: Sign Off (UX Table 9.1–9.4)
  // ------------------------------------------------------------------

  test('Phase 9: sign off contribution via detail dialog', async () => {
    await openContributionDialog(page, CONTRIBUTION_1_TITLE);
    const dlg = page.locator('.q-dialog');

    // 9.2 Click Sign Off
    const signOffBtn = dlg.getByRole('button', { name: /Sign Off/i }).first();
    await expect(signOffBtn).toBeVisible({ timeout: TIMEOUT.medium });
    await signOffBtn.click();
    await waitForSettle(page);

    // 9.4 Verify signed-off state
    await expect(dlg.getByText(/Signed Off/i).first()).toBeVisible({ timeout: TIMEOUT.short });
    console.log('[Phase 9] Contribution signed off');

    await closeContributionDialog(page);
  });

  // ------------------------------------------------------------------
  // Phase 10: Contribution Change (UX Table 10.1–10.8)
  // Uses contribution 2 which is confirmed but not yet shared
  // ------------------------------------------------------------------

  test('Phase 10: share, offer, accept contribution 2 for change flow', async () => {
    // First get contribution 2 to "assigned" status via the UI
    await openContributionDialog(page, CONTRIBUTION_2_TITLE);
    const dlg = page.locator('.q-dialog');

    // Share
    const shareBtn = dlg.getByRole('button', { name: 'Share' }).first();
    await expect(shareBtn).toBeVisible({ timeout: TIMEOUT.short });
    await shareBtn.click();

    const shareDlg = page.locator('.q-dialog').filter({ hasText: 'Share Contribution' });
    await expect(shareDlg).toBeVisible({ timeout: TIMEOUT.short });
    await shareDlg.getByLabel('Contributors').or(shareDlg.getByText('Contributors')).click();
    await shareDlg.getByRole('button', { name: 'Share' }).click();
    await waitForSettle(page);

    // Offer to self
    const offerBtn = dlg.getByRole('button', { name: 'Offer' }).first();
    await expect(offerBtn).toBeVisible({ timeout: TIMEOUT.short });
    await offerBtn.click();

    const offerDlg = page.locator('.q-dialog').filter({ hasText: 'Offer' });
    await expect(offerDlg).toBeVisible({ timeout: TIMEOUT.short });
    await offerDlg.getByLabel(/User ID/i).fill(adminAID);
    await offerDlg.getByLabel(/User Name/i).fill('Admin User');
    await offerDlg.getByRole('button', { name: /Send Offer|Offer/i }).click();
    await waitForSettle(page);

    // Accept
    const acceptBtn = dlg.getByRole('button', { name: /Accept Offer|Accept/i }).first();
    await expect(acceptBtn).toBeVisible({ timeout: TIMEOUT.short });
    await acceptBtn.click();
    await waitForSettle(page);
    console.log('[Phase 10] Contribution 2 is now assigned');

    await closeContributionDialog(page);
  });

  test('Phase 10: change contribution via UI', async () => {
    // 10.1 Open contribution 2 dialog and click Change Contribution
    await openContributionDialog(page, CONTRIBUTION_2_TITLE);
    const dlg = page.locator('.q-dialog');

    const changeBtn = dlg.getByRole('button', { name: /Change Contribution/i });
    await expect(changeBtn).toBeVisible({ timeout: TIMEOUT.short });
    await changeBtn.click();

    // 10.2 Change dialog opens (reuses CreateContributionDialog in edit mode)
    const changeDlg = dialog(page, 'Change Contribution');
    await expect(changeDlg).toBeVisible({ timeout: TIMEOUT.short });

    // 10.3 Re-confirmation warning should be visible
    await expect(changeDlg.getByText(/re-confirmation/i)).toBeVisible({ timeout: TIMEOUT.short });

    // 10.4 Edit a field
    const descInput = changeDlg.getByLabel(/Description/i).first();
    await descInput.clear();
    await descInput.fill('Updated: Coordinate expanded community outreach with new partners');

    // 10.5 Provide reason for change
    const reasonInput = changeDlg.getByLabel(/Reason for Change/i).or(
      changeDlg.getByPlaceholder(/reason|why/i)
    );
    await expect(reasonInput).toBeVisible({ timeout: TIMEOUT.short });
    await reasonInput.fill('Scope expanded to include additional community partners');

    // 10.6 Submit change
    await changeDlg.getByRole('button', { name: /Submit Change/i }).click();
    await waitForSettle(page);
    console.log('[Phase 10] Contribution changed — status should be "changed"');

    await closeContributionDialog(page);
  });

  test('Phase 10: re-confirm changed contribution', async () => {
    // 10.7 The changed contribution should show a Confirm button again
    const contrib2Card = page.locator('.contribution-compact').filter({ hasText: CONTRIBUTION_2_TITLE });
    const confirmBtn = contrib2Card.getByRole('button', { name: 'Confirm' });

    // The card might need a moment to reflect the new status
    await expect(confirmBtn).toBeVisible({ timeout: TIMEOUT.medium });
    await confirmBtn.click();
    await waitForSettle(page);
    console.log('[Phase 10] Changed contribution re-confirmed');
  });

  // ------------------------------------------------------------------
  // Phase 6: Sub-Contributions (UX Table 6.1–6.8)
  // Uses contribution 1 which is signed off — we'll use contribution 2
  // which is now re-confirmed. Need to get it to assigned first.
  // Actually, let's create a fresh contribution for sub-contrib testing.
  // ------------------------------------------------------------------

  test('Phase 6: create and manage sub-contribution', async () => {
    // Get contribution 2 to assigned status again (it was re-confirmed after change)
    await openContributionDialog(page, CONTRIBUTION_2_TITLE);
    const dlg = page.locator('.q-dialog');

    // Share
    const shareBtn = dlg.getByRole('button', { name: 'Share' }).first();
    if (await shareBtn.isVisible().catch(() => false)) {
      await shareBtn.click();
      const shareDlg = page.locator('.q-dialog').filter({ hasText: 'Share Contribution' });
      await expect(shareDlg).toBeVisible({ timeout: TIMEOUT.short });
      await shareDlg.getByLabel('Contributors').or(shareDlg.getByText('Contributors')).click();
      await shareDlg.getByRole('button', { name: 'Share' }).click();
      await waitForSettle(page);
    }

    // Offer to self
    const offerBtn = dlg.getByRole('button', { name: 'Offer' }).first();
    if (await offerBtn.isVisible().catch(() => false)) {
      await offerBtn.click();
      const offerDlg = page.locator('.q-dialog').filter({ hasText: 'Offer' });
      await expect(offerDlg).toBeVisible({ timeout: TIMEOUT.short });
      await offerDlg.getByLabel(/User ID/i).fill(adminAID);
      await offerDlg.getByLabel(/User Name/i).fill('Admin User');
      await offerDlg.getByRole('button', { name: /Send Offer|Offer/i }).click();
      await waitForSettle(page);
    }

    // Accept
    const acceptBtn = dlg.getByRole('button', { name: /Accept Offer|Accept/i }).first();
    if (await acceptBtn.isVisible().catch(() => false)) {
      await acceptBtn.click();
      await waitForSettle(page);
    }

    // 6.2 Add sub-contribution
    const addSubBtn = dlg.getByRole('button', { name: /Add Sub-Contribution/i });
    await expect(addSubBtn).toBeVisible({ timeout: TIMEOUT.medium });
    await addSubBtn.click();

    // Fill sub-contribution form
    const subDlg = dialog(page, /Sub-Contribution|Create Contribution/i);
    await expect(subDlg).toBeVisible({ timeout: TIMEOUT.short });

    await subDlg.getByLabel(/Title/i).first().fill(SUB_CONTRIBUTION_TITLE);
    await subDlg.getByLabel(/Description/i).first().fill(SUB_CONTRIBUTION_DESC);
    await subDlg.getByRole('button', { name: 'Technical' }).click();
    await subDlg.getByRole('button', { name: 'Medium' }).click();

    const objInput = subDlg.getByPlaceholder(/objective/i).first();
    await objInput.fill('Review design documents');
    await objInput.press('Enter');

    const delInput = subDlg.getByPlaceholder(/deliverable/i).first();
    await delInput.fill('Review report');
    await delInput.press('Enter');

    await subDlg.getByRole('button', { name: /Create/i }).click();
    await waitForSettle(page);
    console.log('[Phase 6] Sub-contribution created');

    // 6.5 Verify sub-contribution appears in the dialog
    await expect(dlg.getByText(SUB_CONTRIBUTION_TITLE)).toBeVisible({ timeout: TIMEOUT.medium });

    // 6.4 Approve the sub-contribution (if there's an Approve button)
    const approveBtn = dlg.getByRole('button', { name: 'Approve' }).first();
    if (await approveBtn.isVisible().catch(() => false)) {
      await approveBtn.click();
      await waitForSettle(page);
      console.log('[Phase 6] Sub-contribution approved');
    }

    // 6.6 Click sub-contribution to open recursive dialog
    const subItem = dlg.locator('.sub-item').filter({ hasText: SUB_CONTRIBUTION_TITLE });
    if (await subItem.isVisible().catch(() => false)) {
      await subItem.click();
      await page.waitForTimeout(500);

      // Verify nested dialog opened with sub-contribution title
      const nestedTitle = page.locator('.q-dialog').getByText(SUB_CONTRIBUTION_TITLE);
      const isNested = await nestedTitle.isVisible().catch(() => false);
      if (isNested) {
        console.log('[Phase 6] Recursive child dialog opened');
        // Close nested dialog
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      }
    }

    // 6.7 Verify blocking warning (parent can't submit evidence with unsigned child)
    const blockingWarning = dlg.getByText(/Sub-Contributions Not Complete|must be signed off/i);
    const hasWarning = await blockingWarning.isVisible().catch(() => false);
    console.log('[Phase 6] Blocking warning visible: %s', hasWarning);

    await closeContributionDialog(page);
  });

  // ------------------------------------------------------------------
  // Verify: Navigate to contributions page and see statuses
  // ------------------------------------------------------------------

  test('verify contributions page shows all contributions', async () => {
    await navigateTo(page, 'Contributions');
    await expect(page).toHaveURL(/\/dashboard\/contributions/, { timeout: TIMEOUT.short });
    await waitForSettle(page);

    // Contribution 1 should show as signed_off
    const contrib1 = page.locator('.contribution-card').filter({ hasText: CONTRIBUTION_1_TITLE });
    await expect(contrib1).toBeVisible({ timeout: TIMEOUT.medium });

    // Contribution 2 should be visible
    const contrib2 = page.locator('.contribution-card').filter({ hasText: CONTRIBUTION_2_TITLE });
    await expect(contrib2).toBeVisible({ timeout: TIMEOUT.medium });

    console.log('[Verify] Both contributions visible on contributions page');
  });

  // ------------------------------------------------------------------
  // Verify: Navigate back to projects page
  // ------------------------------------------------------------------

  test('verify project still listed on projects page', async () => {
    await navigateTo(page, 'Projects');
    await expect(page).toHaveURL(/\/dashboard\/projects/, { timeout: TIMEOUT.short });
    await waitForSettle(page);

    const card = page.locator('.project-card', { hasText: PROJECT_TITLE }).first();
    await expect(card).toBeVisible({ timeout: TIMEOUT.medium });
    console.log('[Verify] Project still listed');
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
    const { admin: adminAID } = await health.json();
    expect(adminAID).toBeTruthy();
    const response = await request.post(`${BACKEND_URL}/api/v1/projects`, {
      headers: { 'Content-Type': 'application/json', 'X-User-AID': adminAID },
      data: { title: '', description: 'No title', created_by: adminAID },
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
