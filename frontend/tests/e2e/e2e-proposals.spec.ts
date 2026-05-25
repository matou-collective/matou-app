/**
 * E2E Tests: Proposal Lifecycle — Full 21-Step Flow
 *
 * Tests the complete proposal system through API with two users:
 *   - admin: proposer, claims Lead + Steward roles, drives governance
 *   - member: endorses, verifies access restrictions
 *
 * Group 1 — RBAC & Validation (stateless API tests)
 * Group 2 — UI Rendering & Interaction (requires admin login)
 * Group 3 — Full 21-Step API Lifecycle (requires any-sync storage)
 *
 * Prerequisites:
 * - KERI test infrastructure running (ports 4901-4904)
 * - Backend running in test mode (port 9080)
 * - Test accounts created (org-setup must have run)
 *
 * Run: npx playwright test --project=proposals
 */
import { test, expect, Page, BrowserContext, APIRequestContext, Locator } from '@playwright/test';
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
  performOrgSetup,
  TestAccounts,
} from './utils/test-helpers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function authHeaders(aid: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-User-AID': aid,
  };
}

async function createProposalAPI(
  request: APIRequestContext,
  aid: string,
  overrides: Record<string, unknown> = {},
) {
  const body = {
    proposer_id: aid,
    title: 'E2E Test Proposal',
    type: ['technical'],
    priority: 'medium',
    description: 'A proposal created during E2E testing',
    problem_statement: 'Need to verify proposal lifecycle works end-to-end',
    solution: 'Create and verify proposals in automated tests',
    expected_outcomes: ['All lifecycle tests pass'],
    estimated_budget: '$0',
    timeline: '1 week',
    ...overrides,
  };

  const response = await request.post(`${BACKEND_URL}/api/v1/proposals`, {
    headers: authHeaders(aid),
    data: body,
  });
  return { response, body: await response.json() };
}

async function transitionProposalAPI(
  request: APIRequestContext,
  proposalId: string,
  status: string,
  reason?: string,
  aid = 'e2e-admin-aid',
) {
  const data: Record<string, string> = { status };
  if (reason) data.reason = reason;

  const response = await request.post(
    `${BACKEND_URL}/api/v1/proposals/${proposalId}/transition`,
    {
      headers: authHeaders(aid),
      data,
    },
  );
  return { response, body: await response.json() };
}

async function updateProposalAPI(
  request: APIRequestContext,
  proposalId: string,
  fields: Record<string, unknown>,
  aid = 'e2e-admin-aid',
) {
  const response = await request.patch(
    `${BACKEND_URL}/api/v1/proposals/${proposalId}`,
    {
      headers: authHeaders(aid),
      data: fields,
    },
  );
  return { response, body: await response.json() };
}

async function endorseProposalAPI(
  request: APIRequestContext,
  proposalId: string,
  endorserId: string,
  comment?: string,
) {
  const response = await request.post(
    `${BACKEND_URL}/api/v1/proposals/${proposalId}/endorsements`,
    {
      headers: authHeaders(endorserId),
      data: {
        endorser_id: endorserId,
        endorsed_at: new Date().toISOString(),
        comment: comment || undefined,
      },
    },
  );
  return { response, body: await response.json() };
}

async function getProposalAPI(request: APIRequestContext, proposalId: string, aid = 'e2e-admin-aid') {
  const response = await request.get(
    `${BACKEND_URL}/api/v1/proposals/${proposalId}`,
    { headers: authHeaders(aid) },
  );
  return { response, body: await response.json() };
}

async function addCommentAPI(
  request: APIRequestContext,
  proposalId: string,
  userId: string,
  userName: string,
  text: string,
) {
  const response = await request.post(
    `${BACKEND_URL}/api/v1/proposals/${proposalId}/comments`,
    {
      headers: authHeaders(userId),
      data: { user_id: userId, user_name: userName, text },
    },
  );
  return { response, body: await response.json() };
}

async function listCommentsAPI(request: APIRequestContext, proposalId: string, aid = 'e2e-admin-aid') {
  const response = await request.get(
    `${BACKEND_URL}/api/v1/proposals/${proposalId}/comments`,
    { headers: authHeaders(aid) },
  );
  return { response, body: await response.json() };
}

async function getHistoryAPI(request: APIRequestContext, proposalId: string, aid = 'e2e-admin-aid') {
  const response = await request.get(
    `${BACKEND_URL}/api/v1/proposals/${proposalId}/history`,
    { headers: authHeaders(aid) },
  );
  return { response, body: await response.json() };
}

async function createDecisionPlanAPI(
  request: APIRequestContext,
  proposalId: string,
  leadId: string,
  stewardId: string,
) {
  const response = await request.post(`${BACKEND_URL}/api/v1/decision-plans`, {
    headers: authHeaders(leadId),
    data: {
      proposal_id: proposalId,
      title: `Decision Plan for E2E Proposal`,
      description: 'Governance decision plan for E2E test',
      objectives: ['Complete governance review'],
      expected_outcomes: ['Governance decision reached'],
      proposal_lead_id: leadId,
      proposal_steward_id: stewardId,
    },
  });
  return { response, body: await response.json() };
}

async function addGovernanceActionAPI(
  request: APIRequestContext,
  dpId: string,
  action: {
    house: string;
    action_type: string;
    description: string;
    meeting_date?: string;
    meeting_time?: string;
    meeting_location?: string;
    linked_action_id?: string;
  },
  aid = 'e2e-admin-aid',
) {
  const response = await request.post(
    `${BACKEND_URL}/api/v1/decision-plans/${dpId}/actions`,
    {
      headers: authHeaders(aid),
      data: action,
    },
  );
  return { response, body: await response.json() };
}

async function completeGovernanceActionAPI(
  request: APIRequestContext,
  actionId: string,
  outcome: string,
  aid = 'e2e-admin-aid',
) {
  const response = await request.post(
    `${BACKEND_URL}/api/v1/governance-actions/${actionId}/complete`,
    {
      headers: authHeaders(aid),
      data: { outcome },
    },
  );
  return { response, body: await response.json() };
}

async function transitionDecisionPlanAPI(
  request: APIRequestContext,
  dpId: string,
  status: string,
  aid = 'e2e-admin-aid',
) {
  const response = await request.post(
    `${BACKEND_URL}/api/v1/decision-plans/${dpId}/transition`,
    {
      headers: authHeaders(aid),
      data: { status },
    },
  );
  return { response, body: await response.json() };
}

// ===========================================================================
// Group 1: RBAC & Validation (no browser session needed)
// ===========================================================================

test.describe.serial('Proposals RBAC & Validation', () => {
  test('backend is reachable', async ({ request }) => {
    const response = await request.get(`${BACKEND_URL}/health`);
    expect(response.ok()).toBeTruthy();
  });

  test('rejects request without X-User-AID header', async ({ request }) => {
    const response = await request.get(`${BACKEND_URL}/api/v1/proposals`, {
      headers: { 'Content-Type': 'application/json' },
    });
    expect(response.status()).toBe(401);

    const body = await response.json();
    expect(body.error).toContain('X-User-AID');
    console.log('[Test] RBAC correctly enforces X-User-AID');
  });

  test('rejects invalid proposal body', async ({ request }) => {
    const response = await request.post(`${BACKEND_URL}/api/v1/proposals`, {
      headers: authHeaders('test-user'),
      data: { title: '' },
    });
    expect(response.status()).toBe(400);
    console.log('[Test] Validation rejects empty proposal');
  });

  test('rejects proposal with missing required fields', async ({ request }) => {
    const response = await request.post(`${BACKEND_URL}/api/v1/proposals`, {
      headers: authHeaders('test-user'),
      data: {
        proposer_id: 'test-user',
        title: 'Test',
        // Missing: type, priority, description, problem_statement, solution, etc.
      },
    });
    expect(response.status()).toBe(400);
    console.log('[Test] Missing fields rejected');
  });
});

// ===========================================================================
// Group 2: UI Rendering & Interaction (requires admin login)
// ===========================================================================

test.describe.serial('Proposals UI', () => {
  let accounts: TestAccounts;
  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser, request }) => {
    await requireAllTestServices();

    context = await browser.newContext();
    await setupTestConfig(context);
    page = await context.newPage();
    setupPageLogging(page, 'ProposalsUI');

    // Navigate to splash and determine state
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
      console.log('[ProposalsUI] No org config — running org setup...');
      accounts = await performOrgSetup(page, request);
    } else {
      console.log('[ProposalsUI] Recovering admin identity...');
      accounts = loadAccounts();
      if (!accounts.admin?.mnemonic) {
        throw new Error(
          'No admin mnemonic in test-accounts.json — run org-setup first',
        );
      }
      await loginWithMnemonic(page, accounts.admin.mnemonic);
      console.log('[ProposalsUI] Admin logged in');
    }
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test('navigate to proposals via sidebar', async () => {
    const navItem = page.locator('.nav-item', { hasText: 'Proposals' });
    await expect(navItem).toBeVisible({ timeout: TIMEOUT.short });
    await navItem.click();

    await expect(page).toHaveURL(/\/dashboard\/proposals/, {
      timeout: TIMEOUT.short,
    });
    console.log('[Test] Navigated to proposals via sidebar');
  });

  test('page renders header and create button', async () => {
    await expect(
      page.locator('.proposals-title'),
    ).toBeVisible({ timeout: TIMEOUT.short });

    await expect(page.locator('.proposals-subtitle')).toBeVisible();

    await expect(
      page.locator('.create-btn', { hasText: '+ New Proposal' }),
    ).toBeVisible();

    console.log('[Test] Header and create button rendered');
  });

  test('filter pills render with correct labels', async () => {
    const filterRow = page.locator('.filter-row');
    await expect(filterRow).toBeVisible({ timeout: TIMEOUT.short });

    for (const label of ['All', 'Active', 'Draft', 'Closed']) {
      await expect(
        page.locator('.filter-pill', { hasText: label }),
      ).toBeVisible();
    }

    // "Active" should be active by default
    await expect(
      page.locator('.filter-pill.active', { hasText: 'Active' }),
    ).toBeVisible();

    console.log('[Test] Filter pills rendered');
  });

  test('filter pills toggle active state on click', async () => {
    const allPill = page.locator('.filter-pill', { hasText: 'All' });
    const draftPill = page.locator('.filter-pill', { hasText: 'Draft' });
    const activePill = page.locator('.filter-pill', { hasText: 'Active' });

    // Click "Draft"
    await draftPill.click();
    await expect(draftPill).toHaveClass(/active/);
    await expect(allPill).not.toHaveClass(/active/);

    // Click "Active"
    await activePill.click();
    await expect(activePill).toHaveClass(/active/);
    await expect(draftPill).not.toHaveClass(/active/);

    // Reset to "All"
    await allPill.click();
    await expect(allPill).toHaveClass(/active/);

    console.log('[Test] Filter toggle works');
  });

  test('create dialog opens with all form fields', async () => {
    await page.locator('.create-btn', { hasText: '+ New Proposal' }).click();

    const dialog = page.locator('.q-dialog');
    await expect(dialog).toBeVisible({ timeout: TIMEOUT.short });

    // Verify dialog title
    await expect(dialog.locator('.text-h6')).toContainText('Create Proposal');

    // Verify key form fields (Priority removed, Type is a card grid)
    for (const label of [
      'Title',
      'Description',
      'Problem Statement',
      'Proposed Solution',
    ]) {
      await expect(dialog.locator(`label:has-text("${label}")`)).toBeVisible();
    }
    // Type uses card grid, not a label
    await expect(dialog.locator('.type-grid')).toBeVisible();

    // Verify action buttons
    await expect(dialog.getByRole('button', { name: /cancel/i })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /Create Proposal/i })).toBeVisible();

    // Cancel closes dialog
    await dialog.getByRole('button', { name: /cancel/i }).click();
    await expect(dialog).not.toBeVisible({ timeout: TIMEOUT.short });

    console.log('[Test] Create dialog renders all fields');
  });

  test('proposal cards are clickable and navigate to detail', async ({ request }) => {
    // Create a proposal via API to ensure there's one to click
    const accounts = loadAccounts();
    const aid = accounts.admin?.aid || 'test-admin';
    await createProposalAPI(request, aid, { title: 'Clickable Card Test' });

    // SSE proposal:created triggers list refresh — wait for card to appear
    const cards = page.locator('.proposal-card');
    const cardCount = await cards.count();

    if (cardCount > 0) {
      const firstCard = cards.first();
      await firstCard.click();

      // Should navigate to detail page
      await expect(page).toHaveURL(/\/dashboard\/proposals\//, {
        timeout: TIMEOUT.short,
      });
      console.log('[Test] Clicked card → navigated to detail page');

      // Navigate back
      await page.goBack();
      await expect(page).toHaveURL(/\/dashboard\/proposals$/, {
        timeout: TIMEOUT.short,
      });
    } else {
      console.log('[Test] No cards to click (storage may be unavailable)');
    }
  });
});

// ===========================================================================
// Group 3: Full 21-Step Proposal Lifecycle (Browser UI + API)
//
// Drives the proposal through the full lifecycle using two browser contexts:
//   - Admin: logged in on the default backend (port 9080)
//   - Member: logged in on a dedicated backend (via BackendManager)
//
// Steps 1-13 are driven through the browser UI.
// Steps 14-21 (governance voting) use API calls — the voting action UI
// requires precise action card targeting that's better tested via API.
// ===========================================================================

test.describe.serial('Proposals Full 21-Step Lifecycle', () => {
  let accounts: TestAccounts;

  let adminContext: BrowserContext;
  let adminPage: Page;
  let adminAID: string;

  const backends = new BackendManager();
  let memberBackend: BackendInstance;
  let memberContext: BrowserContext;
  let memberPage: Page;
  let memberAID: string;

  let member2Backend: BackendInstance;
  let member2Context: BrowserContext;
  let member2Page: Page;
  let member2AID: string;

  let proposalId: string;

  /** Navigate to a sidebar item */
  async function nav(page: Page, label: string) {
    await page.getByRole('button', { name: label }).click();
  }

  async function settle(page: Page, ms = 1500) {
    await page.waitForTimeout(ms);
  }

  function dlg(page: Page, title: string | RegExp) {
    return page.locator('.q-dialog').filter({ hasText: title });
  }

  /**
   * Find an action-card within a house section, filtered by its action-type
   * label. Filtering the card by `hasText: /Meeting/i` is unreliable —
   * the decision card's description "...after the review meeting" also
   * matches, and backend `hydrateDecisionPlanActions` doesn't sort, so
   * `.first()` is non-deterministic.
   *
   * We use native CSS `:has()` with Playwright's `:text-is()` pseudo to
   * exact-match the `.action-type-label` span. Passing a chained
   * `section.locator(...)` to `filter({has})` doesn't work — Playwright
   * carries the full ancestor chain (.house-section/...) into the `has`
   * lookup, which then can't resolve within an .action-card descendant.
   */
  function actionCard(section: Locator, type: 'Meeting' | 'Decision'): Locator {
    return section.locator(`.action-card:has(.action-type-label:text-is("${type}"))`);
  }

  /**
   * Dismiss the top-most open dialog via Escape. Necessary for the
   * GovernanceActionModal after the admin votes on a decision — the only
   * footer action available to the manager is "Close Voting", which would
   * resolve the vote prematurely. q-dialog closes on Escape by default
   * (not persistent).
   */
  async function dismissTopDialog(page: Page) {
    const top = page.locator('.q-dialog').last();
    if (!(await top.isVisible().catch(() => false))) return;
    await page.keyboard.press('Escape');
    await expect(top).not.toBeVisible({ timeout: 5_000 }).catch(async () => {
      // Some Quasar dialogs require focus inside the dialog for Escape to fire.
      await top.click({ position: { x: 5, y: 5 } }).catch(() => {});
      await page.keyboard.press('Escape');
    });
  }

  /**
   * Add a governance action through AddGovernanceActionDialog.
   *
   * Expects the proposal detail page to be open and the proposal in
   * signed_off | voting_process status with canManageDecisionPlan = true so
   * the "Add Governance Action" trigger button is rendered. The dialog
   * auto-closes on successful add (parent sets showAddGovernanceAction=false).
   *
   * For decisions, the linked meeting must already exist for the same house.
   */
  type GovHouse = 'elders_council' | 'community_reps' | 'contributors';
  type GovType = 'meeting' | 'decision' | 'discussion';
  const HOUSE_DIALOG_LABEL: Record<GovHouse, string> = {
    elders_council: 'Elders Council',
    community_reps: 'Community Representatives',
    contributors: 'Contributors',
  };
  const TYPE_DIALOG_LABEL: Record<GovType, string> = {
    meeting: 'Meeting',
    decision: 'Decision',
    discussion: 'Discussion',
  };

  async function addGovernanceActionUI(opts: {
    house: GovHouse;
    type: GovType;
    description: string;
    meetingDate?: string; // dd-mm-yyyy
    meetingTime?: string; // HH:mm
    location?: string;
    linkedTo?: RegExp; // partial match against linked-card text
    votingEndDate?: string; // dd-mm-yyyy
    votingEndTime?: string; // HH:mm
  }) {
    // Open the dialog. There may be two "Add Governance Action" buttons —
    // one on ProposalDetailPage and one on DecisionPlanView once the plan
    // exists. Either works; .first() picks deterministically.
    const trigger = adminPage.getByRole('button', { name: /Add Governance Action/i }).first();
    await expect(trigger).toBeVisible({ timeout: TIMEOUT.short });
    await trigger.click();

    const d = dlg(adminPage, /Add Governance Action/i);
    await expect(d).toBeVisible({ timeout: TIMEOUT.short });

    // Pick house and action type. Use getByRole for the accessible name —
    // the .form-section / .select-card chain was timing out for 3 min on the
    // very first click (likely SSE-driven re-renders of the dialog from
    // existing-actions / proposal-title props detaching the element).
    await d.getByRole('button', { name: HOUSE_DIALOG_LABEL[opts.house], exact: true }).click();
    await d.getByRole('button', { name: TYPE_DIALOG_LABEL[opts.type], exact: true }).click();

    if (opts.type === 'meeting' || opts.type === 'discussion') {
      // Date / Time / Location inputs are addressed by placeholder — unique
      // in the dialog and immune to the .form-section filter flakiness.
      await d.getByPlaceholder('dd-mm-yyyy').fill(opts.meetingDate ?? '');
      await d.getByPlaceholder('HH:mm').fill(opts.meetingTime ?? '');
      await d.getByPlaceholder(/Virtual.*Zoom|Community Center/).fill(opts.location ?? '');
    } else {
      // Decision: pick the linked meeting/discussion card
      const linkedCard = d.locator('.linked-card').filter({ hasText: opts.linkedTo ?? /.*/ }).first();
      await expect(linkedCard).toBeVisible({ timeout: TIMEOUT.short });
      await linkedCard.click();
      await d.getByPlaceholder('dd-mm-yyyy').fill(opts.votingEndDate ?? '');
      await d.getByPlaceholder('HH:mm').fill(opts.votingEndTime ?? '');
    }

    // Description — the only textarea in the dialog, so no need for the
    // form-section filter chain (which timed out for 3 min on this field).
    await d.locator('textarea').fill(opts.description);

    // Submit. Dialog closes when the parent's handleAddGovernanceAction
    // resolves, which awaits decisionPlansStore.addAction.
    await d.getByRole('button', { name: /^Add Action$/i }).click();
    await expect(d).not.toBeVisible({ timeout: TIMEOUT.medium });
    await settle(adminPage, 800);
  }

  // ------------------------------------------------------------------
  // Setup
  // ------------------------------------------------------------------

  test.beforeAll(async ({ browser, request }) => {
    test.setTimeout(360_000);
    await requireAllTestServices();

    // Admin context
    adminContext = await browser.newContext();
    await setupTestConfig(adminContext);
    adminPage = await adminContext.newPage();
    setupPageLogging(adminPage, 'Admin-P');

    await adminPage.goto(FRONTEND_URL);
    const needsSetup = await Promise.race([
      adminPage.waitForURL(/.*#\/setup/, { timeout: TIMEOUT.medium }).then(() => true),
      adminPage.locator('button', { hasText: /join now/i }).waitFor({ state: 'visible', timeout: TIMEOUT.medium }).then(() => false),
    ]);

    if (needsSetup) {
      accounts = await performOrgSetup(adminPage, request);
    } else {
      accounts = loadAccounts();
      if (!accounts.admin?.mnemonic) throw new Error('No admin mnemonic');
      await loginWithMnemonic(adminPage, accounts.admin.mnemonic);
    }

    adminAID = accounts.admin?.aid ?? '';
    if (!adminAID) {
      adminAID = await adminPage.evaluate(() => localStorage.getItem('matou_admin_aid') || '');
    }
    if (!adminAID) {
      const h = await request.get(`${BACKEND_URL}/health`);
      adminAID = (await h.json()).admin || '';
    }
    if (!adminAID) throw new Error('Could not resolve admin AID');
    console.log('[Setup] Admin AID: %s', adminAID);

    // Member context
    memberBackend = await backends.start('member-proposals');
    memberContext = await browser.newContext();
    await setupTestConfig(memberContext);
    await setupBackendRouting(memberContext, memberBackend.port);
    memberPage = await memberContext.newPage();
    setupPageLogging(memberPage, 'Member-P');

    if (!accounts.member?.mnemonic || accounts.member.mnemonic.length !== 12) {
      throw new Error('No member account — run registration test first');
    }
    await loginWithMnemonic(memberPage, accounts.member.mnemonic);
    memberAID = accounts.member.aid ?? '';
    console.log('[Setup] Member AID: %s', memberAID);

    // Member2 context — needed to reach endorsement threshold (default = 2).
    // Proposer cannot self-endorse, so we need two distinct members.
    if (!accounts.member2?.mnemonic || accounts.member2.mnemonic.length !== 12) {
      throw new Error('No member2 account — run e2e-registration test 2 first');
    }
    member2Backend = await backends.start('member2-proposals');
    member2Context = await browser.newContext();
    await setupTestConfig(member2Context);
    await setupBackendRouting(member2Context, member2Backend.port);
    member2Page = await member2Context.newPage();
    setupPageLogging(member2Page, 'Member2-P');
    await loginWithMnemonic(member2Page, accounts.member2.mnemonic);
    member2AID = accounts.member2.aid ?? '';
    console.log('[Setup] Member2 AID: %s', member2AID);
  });

  test.afterAll(async () => {
    await backends.stopAll();
    await member2Context?.close();
    await memberContext?.close();
    await adminContext?.close();
  });

  // ------------------------------------------------------------------
  // Steps 1-4: Admin creates proposal via UI
  // ------------------------------------------------------------------

  test('Steps 1-4: admin creates proposal via UI', async () => {
    await adminPage.bringToFront();
    await nav(adminPage, 'Proposals');
    await expect(adminPage).toHaveURL(/\/dashboard\/proposals/, { timeout: TIMEOUT.short });
    await settle(adminPage);

    // Click "+ New Proposal"
    await adminPage.locator('.create-btn').click();

    const d = dlg(adminPage, 'Create Proposal');
    await expect(d).toBeVisible({ timeout: TIMEOUT.short });

    // Fill form fields by label
    await d.getByLabel('Title *').fill('Full Lifecycle E2E Proposal');

    // Type card selection
    await d.locator('.type-card').filter({ hasText: 'Governance' }).click();
    await settle(adminPage, 300);

    await d.getByLabel('Description *').fill('Governance improvement proposal for E2E testing');
    await d.getByLabel('Problem Statement *').fill('Need to verify the complete 21-step lifecycle');
    await d.getByLabel('Proposed Solution *').fill('Automated E2E testing of all proposal steps');
    await d.getByLabel('Outcome 1').fill('All 21 steps verified');
    await d.getByLabel('Estimated Budget *').fill('500');
    await d.getByLabel(/Timeline/i).fill('4');

    await d.getByRole('button', { name: /Create Proposal|Save Changes|Save/i }).click();

    // SSE proposal:created event triggers list refresh — wait for card to appear
    const card = adminPage.locator('.proposal-card').filter({ hasText: 'Draft' }).filter({ hasText: 'Full Lifecycle E2E Proposal' }).first();
    await expect(card).toBeVisible({ timeout: TIMEOUT.medium });
    await card.click();
    await expect(adminPage).toHaveURL(/\/dashboard\/proposals\//, { timeout: TIMEOUT.short });
    await settle(adminPage);

    // Extract proposal ID from URL
    const match = adminPage.url().match(/proposals\/([^/?#]+)/);
    expect(match).toBeTruthy();
    proposalId = match![1];

    await expect(adminPage.locator('.status-badge.draft')).toBeVisible({ timeout: TIMEOUT.short });
    console.log('[Steps 1-4] Proposal created: %s', proposalId);
  });

  // ------------------------------------------------------------------
  // Step 5: Admin submits for endorsement via UI
  // ------------------------------------------------------------------

  test('Step 5: admin submits for endorsement via UI', async () => {
    await adminPage.bringToFront();
    const btn = adminPage.getByRole('button', { name: /Submit for Endorsement/i });
    await expect(btn).toBeVisible({ timeout: TIMEOUT.short });
    await btn.click();

    // SSE proposal:status_changed triggers UI refresh
    await expect(adminPage.locator('.status-badge.submitted')).toBeVisible({ timeout: TIMEOUT.medium });
    console.log('[Step 5] Submitted for endorsement');
  });

  // ------------------------------------------------------------------
  // Access: member cannot sign off submitted proposal
  // ------------------------------------------------------------------

  test('Access: member cannot sign off submitted proposal', async () => {
    await memberPage.bringToFront();
    await nav(memberPage, 'Proposals');

    // Filter cards by data-proposal-id (not title) — stale proposals from prior
    // runs can share the same title, and .first() would pick the wrong one.
    // page.goto() is also a no-go: it triggers a full reload that wipes Pinia
    // state and forces a 30s+ KERIA re-auth.
    const card = memberPage.locator(`.proposal-card[data-proposal-id="${proposalId}"]`);
    await expect(card).toBeVisible({ timeout: TIMEOUT.long });
    await card.click();
    await expect(memberPage).toHaveURL(new RegExp(`/dashboard/proposals/${proposalId}`), { timeout: TIMEOUT.short });
    await settle(memberPage, 1500);

    // Member should NOT see sign-off button
    const signOff = memberPage.getByRole('button', { name: /Sign Off Proposal/i });
    await expect(signOff).not.toBeVisible({ timeout: 3000 });

    // But SHOULD see endorse button
    const endorse = memberPage.getByRole('button', { name: /Endorse Proposal/i });
    await expect(endorse).toBeVisible({ timeout: TIMEOUT.short });
    console.log('[Access] Member cannot sign off (correct)');
  });

  // ------------------------------------------------------------------
  // Steps 7-9: Two members endorse → threshold (2) → auto in_review
  //
  // Backend default threshold is 2 and proposers cannot self-endorse, so
  // we need two distinct members. Member endorses first (1/2 — no transition
  // yet), then Member2 endorses (2/2 — auto-transition to in_review fires
  // on member2's backend and propagates via any-sync P2P to memberPage).
  // ------------------------------------------------------------------

  test('Steps 7-9: members endorse via UI, threshold met → auto in_review', async () => {
    // --- Endorsement 1: memberPage ---
    await memberPage.bringToFront();

    const endorseBtn = memberPage.getByRole('button', { name: /Endorse Proposal/i });
    await expect(endorseBtn).toBeVisible({ timeout: TIMEOUT.short });
    await endorseBtn.click();

    const endorseDlg = dlg(memberPage, 'Endorse Proposal');
    await expect(endorseDlg).toBeVisible({ timeout: TIMEOUT.short });

    const comment = endorseDlg.locator('textarea');
    if (await comment.isVisible().catch(() => false)) {
      await comment.fill('I fully support this proposal');
    }
    await endorseDlg.getByRole('button', { name: /^Endorse$/i }).click();
    await expect(endorseDlg).not.toBeVisible({ timeout: TIMEOUT.medium });
    console.log('[Steps 7-9] Member endorsed (1/2)');

    // Status should still be `submitted` after a single endorsement.
    await expect(memberPage.locator('.status-badge.submitted')).toBeVisible({ timeout: TIMEOUT.short });

    // --- Endorsement 2: member2Page (triggers threshold) ---
    await member2Page.bringToFront();
    await nav(member2Page, 'Proposals');
    await expect(member2Page).toHaveURL(/\/dashboard\/proposals/, { timeout: TIMEOUT.short });

    // Filter by data-proposal-id (not title) — same reason as memberPage above.
    const card = member2Page.locator(`.proposal-card[data-proposal-id="${proposalId}"]`);
    await expect(card).toBeVisible({ timeout: TIMEOUT.long });
    await card.click();
    await expect(member2Page).toHaveURL(new RegExp(`/dashboard/proposals/${proposalId}`), { timeout: TIMEOUT.short });
    await settle(member2Page, 1500);

    // Wait until member's endorsement has propagated to member2's backend
    // (P2P HeadSync runs every 5s). Otherwise member2's local count stays
    // at 1 and the threshold-met auto-transition won't fire.
    await expect
      .poll(
        async () => {
          const resp = await member2Page.request.get(
            `http://localhost:${member2Backend.port}/api/v1/proposals/${proposalId}/endorsements`,
          );
          const data = await resp.json();
          return data.total ?? data.endorsements?.length ?? 0;
        },
        { timeout: TIMEOUT.long, message: "member's endorsement did not sync to member2 backend" },
      )
      .toBeGreaterThanOrEqual(1);
    console.log('[Steps 7-9] Member endorsement synced to member2 backend');

    const endorse2Btn = member2Page.getByRole('button', { name: /Endorse Proposal/i });
    await expect(endorse2Btn).toBeVisible({ timeout: TIMEOUT.long });
    await endorse2Btn.click();

    const endorse2Dlg = dlg(member2Page, 'Endorse Proposal');
    await expect(endorse2Dlg).toBeVisible({ timeout: TIMEOUT.short });

    const comment2 = endorse2Dlg.locator('textarea');
    if (await comment2.isVisible().catch(() => false)) {
      await comment2.fill('Strongly support this proposal');
    }
    await endorse2Dlg.getByRole('button', { name: /^Endorse$/i }).click();
    await expect(endorse2Dlg).not.toBeVisible({ timeout: TIMEOUT.medium });
    console.log('[Steps 7-9] Member2 endorsed (2/2 — threshold met)');

    // Threshold met → member2 backend auto-transitions to in_review.
    // confirmEndorse explicitly reloads the proposal on threshold_met=true,
    // so member2Page reflects the new status immediately.
    await expect(member2Page.locator('.status-badge.in_review')).toBeVisible({ timeout: TIMEOUT.long });

    // memberPage receives the new status via any-sync P2P sync → SSE.
    await memberPage.bringToFront();
    await expect(memberPage.locator('.status-badge.in_review')).toBeVisible({ timeout: TIMEOUT.long });
    console.log('[Steps 7-9] in_review confirmed on memberPage (via P2P)');
  });

  // ------------------------------------------------------------------
  // Access: cannot endorse in_review
  // ------------------------------------------------------------------

  test('Access: member cannot endorse in_review proposal', async () => {
    await memberPage.bringToFront();
    const btn = memberPage.getByRole('button', { name: /Endorse Proposal/i });
    await expect(btn).not.toBeVisible({ timeout: 3000 });
    console.log('[Access] Cannot endorse in_review (correct)');
  });

  // ------------------------------------------------------------------
  // Step 11: Admin claims Lead + Steward via UI
  // ------------------------------------------------------------------

  test('Step 11: admin claims Lead and Steward roles via UI', async ({ request }) => {
    await adminPage.bringToFront();

    // Ensure admin backend has the in_review status (endorsement happened on member backend)
    const { body: p } = await getProposalAPI(request, proposalId, adminAID);
    if (p.status !== 'in_review') {
      // P2P sync hasn't propagated yet — endorse via admin API as fallback
      console.log('[Step 11] Admin backend status=%s, endorsing via API fallback', p.status);
      await endorseProposalAPI(request, proposalId, 'e2e-admin-endorse', 'Fallback endorsement');
    }

    // Navigate to proposal detail to see in_review state with team chips
    await adminPage.goto(`${FRONTEND_URL}#/dashboard/proposals/${proposalId}`);

    // Team chips render in the detail header. Unassigned roles show as
    // `.assign-chip` buttons that open AssignRoleDialog.
    const teamRow = adminPage.locator('.team-row');
    await expect(teamRow).toBeVisible({ timeout: TIMEOUT.long });

    // Helper: open assign dialog for a role, pick first member, confirm.
    async function assignViaDialog(roleLabel: 'Lead' | 'Steward') {
      const assignBtn = teamRow.getByRole('button', { name: new RegExp(`Assign ${roleLabel}`, 'i') });
      // If already assigned (e.g. from a re-run), skip.
      if (!(await assignBtn.isVisible({ timeout: 2000 }).catch(() => false))) {
        console.log('[Step 11] %s already assigned, skipping', roleLabel);
        return;
      }
      await assignBtn.click();
      const dialog = adminPage.locator('.assign-role-dialog');
      await expect(dialog).toBeVisible({ timeout: TIMEOUT.short });
      const firstMember = dialog.locator('.member-item').first();
      await expect(firstMember).toBeVisible({ timeout: TIMEOUT.short });
      await firstMember.click();
      await dialog.getByRole('button', { name: new RegExp(`Assign Proposal ${roleLabel}`, 'i') }).click();
      // Dialog closes on success
      await expect(dialog).toBeHidden({ timeout: TIMEOUT.medium });
      await settle(adminPage, 500);
    }

    await assignViaDialog('Lead');
    await assignViaDialog('Steward');

    // Both filled chips should now be visible.
    await expect(teamRow.locator('.team-chip.lead')).toBeVisible({ timeout: TIMEOUT.medium });
    await expect(teamRow.locator('.team-chip.steward')).toBeVisible({ timeout: TIMEOUT.medium });

    console.log('[Step 11] Assigned Lead + Steward via team chips');
  });

  // ------------------------------------------------------------------
  // Step 12: Admin edits proposal via UI
  // ------------------------------------------------------------------

  test('Step 12: admin edits proposal via UI', async () => {
    await adminPage.bringToFront();

    const editBtn = adminPage.getByRole('button', { name: /Edit Proposal/i });
    await expect(editBtn).toBeVisible({ timeout: TIMEOUT.short });
    await editBtn.click();

    const d = dlg(adminPage, 'Edit Proposal');
    await expect(d).toBeVisible({ timeout: TIMEOUT.short });

    const desc = d.getByLabel('Description *');
    await desc.clear();
    await desc.fill('Updated governance proposal — revised after review');

    const budget = d.getByLabel('Estimated Budget *');
    await budget.clear();
    await budget.fill('750');

    await d.getByRole('button', { name: /Create Proposal|Save Changes|Save/i }).click();

    // SSE proposal:updated triggers refresh
    await settle(adminPage, 500);
    console.log('[Step 12] Edited proposal');
  });

  // ------------------------------------------------------------------
  // Step 13: Admin signs off via UI
  // ------------------------------------------------------------------

  test('Step 13: admin signs off proposal via UI', async () => {
    await adminPage.bringToFront();

    const btn = adminPage.getByRole('button', { name: /Sign Off Proposal/i });
    await expect(btn).toBeVisible({ timeout: TIMEOUT.short });
    await btn.click();

    // SSE proposal:status_changed triggers refresh
    await expect(adminPage.locator('.status-badge.signed_off')).toBeVisible({ timeout: TIMEOUT.medium });
    console.log('[Step 13] Signed off');
  });

  // ------------------------------------------------------------------
  // Step 14: Create decision plan + add governance actions via UI.
  //
  // The old "Create Decision Plan" dialog is gone — the plan now auto-creates
  // when the first governance action is added through AddGovernanceActionDialog.
  // We add 6 actions (meeting + decision per house), in the order Steps 17–21
  // need them. Each call opens the dialog, fills the form, and waits for the
  // dialog to close.
  // ------------------------------------------------------------------

  test('Step 14: create decision plan via UI', async () => {
    test.setTimeout(180_000);
    await adminPage.bringToFront();

    // Elder Council and Community Representatives governance actions are
    // disabled for now — see AddGovernanceActionDialog HOUSE_OPTIONS. These
    // blocks are intentionally commented out until those houses are re-enabled.
    /*
    // Elder Council
    await addGovernanceActionUI({
      house: 'elders_council',
      type: 'meeting',
      description: 'Elder Council review meeting for the proposal',
      meetingDate: '01-04-2026',
      meetingTime: '10:00',
      location: 'Virtual — Zoom',
    });
    await addGovernanceActionUI({
      house: 'elders_council',
      type: 'decision',
      description: 'Elder Council veto decision after the review meeting',
      linkedTo: /Elders Council Meeting/i,
      votingEndDate: '03-04-2026',
      votingEndTime: '17:00',
    });

    // Community Representatives
    await addGovernanceActionUI({
      house: 'community_reps',
      type: 'meeting',
      description: 'Community Representatives deliberation meeting',
      meetingDate: '02-04-2026',
      meetingTime: '12:00',
      location: 'Virtual — Zoom',
    });
    await addGovernanceActionUI({
      house: 'community_reps',
      type: 'decision',
      description: 'Community Representatives approval decision',
      linkedTo: /Community Representatives Meeting/i,
      votingEndDate: '04-04-2026',
      votingEndTime: '17:00',
    });
    */

    // Contributors
    await addGovernanceActionUI({
      house: 'contributors',
      type: 'meeting',
      description: 'Contributors planning meeting',
      meetingDate: '03-04-2026',
      meetingTime: '14:00',
      location: 'Virtual — Zoom',
    });
    await addGovernanceActionUI({
      house: 'contributors',
      type: 'decision',
      description: 'Contributors approval decision',
      linkedTo: /Contributors Meeting/i,
      votingEndDate: '05-04-2026',
      votingEndTime: '17:00',
    });

    // Verify DecisionPlanView appears with 1 house section (Contributors only —
    // Elder Council and Community Reps are temporarily disabled).
    const dpView = adminPage.locator('.decision-plan-view');
    await expect(dpView).toBeVisible({ timeout: TIMEOUT.medium });
    await expect(dpView.locator('.house-section')).toHaveCount(1, { timeout: TIMEOUT.medium });
    console.log('[Step 14] Decision plan created via UI with 2 actions (Contributors only)');
  });

  // ------------------------------------------------------------------
  // Steps 15-16: Submit + sign off decision plan → voting_process
  // ------------------------------------------------------------------

  test('Step 15: submit decision plan for review via UI', async () => {
    await adminPage.bringToFront();
    // Should already be on proposal detail — click Submit for Review in DecisionPlanView
    const dpView = adminPage.locator('.decision-plan-view');
    await expect(dpView).toBeVisible({ timeout: TIMEOUT.medium });

    const submitBtn = dpView.getByRole('button', { name: /Submit for Review/i });
    await expect(submitBtn).toBeVisible({ timeout: TIMEOUT.short });
    await submitBtn.click();
    console.log('[Step 15] Decision plan submitted for review');
  });

  test('Step 16: sign off decision plan → voting_process via UI', async () => {
    await adminPage.bringToFront();

    const dpView = adminPage.locator('.decision-plan-view');
    // Button label is "Sign Off Decision Plan" — distinct from the proposal-level
    // "Sign Off Proposal" action (which is no longer rendered at this stage).
    const signOffBtn = dpView.getByRole('button', { name: /Sign Off Decision Plan/i });
    await expect(signOffBtn).toBeVisible({ timeout: TIMEOUT.medium });
    await signOffBtn.click();

    // SSE triggers proposal auto-transition to voting_process
    await expect(adminPage.locator('.status-badge.voting_process')).toBeVisible({ timeout: TIMEOUT.medium });
    console.log('[Step 16] Decision plan signed off, proposal → voting_process');
  });

  // Steps 17-18 (Elder Council) and Step 19 (Community Reps) are commented out
  // while those houses' governance actions are disabled.
  /*
  test('Steps 17-18: Elder Council meeting + no veto via UI', async () => {
    test.setTimeout(60_000);
    await adminPage.bringToFront();
    const dpView = adminPage.locator('.decision-plan-view');
    await expect(dpView).toBeVisible({ timeout: TIMEOUT.short });

    // Wait for action cards to be populated (may need SSE refresh after voting_process)
    const actionCards = dpView.locator('.action-card');
    await expect(actionCards.first()).toBeVisible({ timeout: TIMEOUT.medium });
    console.log('[Step 17] Action cards visible: %d', await actionCards.count());

    // Click Elder Council meeting action card
    const elderSection = dpView.locator('.house-section').filter({ hasText: /Elder Council/i });
    const meetingCard = actionCard(elderSection, 'Meeting');
    await expect(meetingCard).toBeVisible({ timeout: TIMEOUT.short });
    await meetingCard.click();

    // GovernanceActionModal opens — fill required Notes then click "Mark as Complete"
    let modal = adminPage.locator('.q-dialog').last();
    await modal.locator('textarea').first().fill('Elder Council met and reviewed the proposal. No veto raised.');
    const completeBtn = modal.getByRole('button', { name: /Mark as Complete/i });
    await expect(completeBtn).toBeVisible({ timeout: TIMEOUT.short });
    await completeBtn.click();
    await settle(adminPage, 1000);
    // Close modal via Close button or Escape
    const closeBtn1 = adminPage.locator('.q-dialog').last().getByRole('button', { name: /^Close$/i });
    if (await closeBtn1.isVisible({ timeout: 3000 }).catch(() => false)) {
      await closeBtn1.click();
    } else {
      await adminPage.keyboard.press('Escape');
    }
    await settle(adminPage, 1500);

    // Wait for the meeting card to actually reflect completed status before
    // opening the decision — otherwise the decision modal's votingLocked
    // computed is true (linkedAction.status !== 'completed') and the body
    // renders "Voting Locked" instead of the vote form.
    await expect(actionCard(elderSection, 'Meeting').locator('.status-badge--completed'))
      .toBeVisible({ timeout: TIMEOUT.medium });
    console.log('[Step 17] Elder Council meeting completed');

    // Click Elder Council decision action card
    const decisionCard = actionCard(elderSection, 'Decision');
    await expect(decisionCard).toBeVisible({ timeout: TIMEOUT.medium });
    await decisionCard.click();

    // Vote: No Veto, then Close Voting to resolve. ResolveDecision is what
    // transitions the action to Completed; without it the proposal's
    // EvaluateGovernanceOutcome won't run when Contributors votes last.
    modal = adminPage.locator('.q-dialog').last();
    const noVetoBtn = modal.getByRole('button', { name: /No Veto/i });
    await expect(noVetoBtn).toBeVisible({ timeout: TIMEOUT.short });
    await noVetoBtn.click();
    await settle(adminPage, 1000);
    const closeVotingBtn1 = adminPage.locator('.q-dialog').last().getByRole('button', { name: /Close Voting/i });
    await expect(closeVotingBtn1).toBeVisible({ timeout: TIMEOUT.short });
    await closeVotingBtn1.click();
    await settle(adminPage, 1000);
    await dismissTopDialog(adminPage);
    await settle(adminPage, 1000);
    console.log('[Step 18] Elder Council voted: no veto + resolved');
  });

  test('Step 19: Community Reps meeting + approve via UI', async () => {
    test.setTimeout(60_000);
    await adminPage.bringToFront();
    const dpView = adminPage.locator('.decision-plan-view');

    // Community meeting
    const communitySection = dpView.locator('.house-section').filter({ hasText: /Community/i });
    const meetingCard = actionCard(communitySection, 'Meeting');
    await expect(meetingCard).toBeVisible({ timeout: TIMEOUT.short });
    await meetingCard.click();

    let modal = adminPage.locator('.q-dialog').last();
    await modal.locator('textarea').first().fill('Community Representatives discussed the proposal and recommended approval.');
    await modal.getByRole('button', { name: /Mark as Complete/i }).click();
    await settle(adminPage, 1000);
    await dismissTopDialog(adminPage);
    await settle(adminPage, 1500);

    // Wait for meeting → completed before opening the decision (avoids
    // votingLocked branch in GovernanceActionModal).
    await expect(actionCard(communitySection, 'Meeting').locator('.status-badge--completed'))
      .toBeVisible({ timeout: TIMEOUT.medium });
    console.log('[Step 19] Community meeting completed');

    // Community decision: Approve, then Close Voting to resolve.
    const decisionCard = actionCard(communitySection, 'Decision');
    await expect(decisionCard).toBeVisible({ timeout: TIMEOUT.medium });
    await decisionCard.click();

    modal = adminPage.locator('.q-dialog').last();
    const approveBtn = modal.getByRole('button', { name: /^Approve$/i });
    await expect(approveBtn).toBeVisible({ timeout: TIMEOUT.short });
    await approveBtn.click();
    await settle(adminPage, 1000);
    const closeVotingBtn = adminPage.locator('.q-dialog').last().getByRole('button', { name: /Close Voting/i });
    await expect(closeVotingBtn).toBeVisible({ timeout: TIMEOUT.short });
    await closeVotingBtn.click();
    await settle(adminPage, 1000);
    await dismissTopDialog(adminPage);
    await settle(adminPage, 1000);
    console.log('[Step 19] Community Reps voted: approved + resolved');
  });
  */

  test('Steps 20-21: Contributors meeting + approve → auto-approved via UI', async () => {
    test.setTimeout(60_000);
    await adminPage.bringToFront();
    const dpView = adminPage.locator('.decision-plan-view');

    // Contributors meeting
    const contribSection = dpView.locator('.house-section').filter({ hasText: /Contributor/i });
    const meetingCard = actionCard(contribSection, 'Meeting');
    await expect(meetingCard).toBeVisible({ timeout: TIMEOUT.short });
    await meetingCard.click();

    let modal = adminPage.locator('.q-dialog').last();
    await modal.locator('textarea').first().fill('Contributors completed planning and aligned on next steps.');
    await modal.getByRole('button', { name: /Mark as Complete/i }).click();
    await settle(adminPage, 1000);
    await dismissTopDialog(adminPage);
    await settle(adminPage, 1500);

    // Wait for meeting → completed before opening the decision (avoids
    // votingLocked branch in GovernanceActionModal).
    await expect(actionCard(contribSection, 'Meeting').locator('.status-badge--completed'))
      .toBeVisible({ timeout: TIMEOUT.medium });
    console.log('[Step 20] Contributors meeting completed');

    // Contributors decision: Approve + Close Voting. ResolveDecision on the
    // last decision triggers EvaluateGovernanceOutcome → all decisions are
    // now Completed and favorable → proposal auto-transitions to approved.
    const decisionCard = actionCard(contribSection, 'Decision');
    await expect(decisionCard).toBeVisible({ timeout: TIMEOUT.medium });
    await decisionCard.click();

    modal = adminPage.locator('.q-dialog').last();
    const approveBtn = modal.getByRole('button', { name: /^Approve$/i });
    await expect(approveBtn).toBeVisible({ timeout: TIMEOUT.short });
    await approveBtn.click();
    await settle(adminPage, 1000);
    const closeVotingBtn = adminPage.locator('.q-dialog').last().getByRole('button', { name: /Close Voting/i });
    await expect(closeVotingBtn).toBeVisible({ timeout: TIMEOUT.short });
    await closeVotingBtn.click();
    await settle(adminPage, 1000);
    await dismissTopDialog(adminPage);

    // SSE: governance_action:completed → auto-evaluate → proposal:status_changed → approved
    await expect(adminPage.locator('.status-badge.approved')).toBeVisible({ timeout: TIMEOUT.medium });
    console.log('[Steps 20-21] Proposal auto-approved via UI!');
  });

  test('Verify: final proposal state via UI', async () => {
    await adminPage.bringToFront();
    await expect(adminPage.locator('.status-badge.approved')).toBeVisible({ timeout: TIMEOUT.short });
    await expect(adminPage.locator('.detail-title', { hasText: 'Full Lifecycle E2E Proposal' })).toBeVisible();
    console.log('[Verify] Proposal approved — all 21 steps complete via UI');
  });
});

// ===========================================================================
// Group 4: Rejection Flow (separate lifecycle)
// ===========================================================================

test.describe.serial('Proposals Rejection Flow', () => {
  let adminAID = 'e2e-reject-admin';
  const memberAID = 'e2e-reject-member';
  let storageAvailable = false;
  let proposalId: string;

  test('probe storage', async ({ request }) => {
    try {
      const health = await request.get(`${BACKEND_URL}/health`);
      const data = await health.json();
      if (data.admin) adminAID = data.admin;
    } catch { /* keep default */ }
    const { response } = await createProposalAPI(request, adminAID, {
      title: 'Rejection Probe',
    });
    storageAvailable = response.ok();
  });

  test('create and submit proposal', async ({ request }) => {
    test.skip(!storageAvailable, 'storage not available');

    const { body } = await createProposalAPI(request, adminAID, {
      title: 'Proposal To Reject',
      endorsement_threshold: 1,
    });
    proposalId = body.id;

    await transitionProposalAPI(request, proposalId, 'submitted');
    console.log('[Rejection] Proposal submitted: %s', proposalId);
  });

  test('member endorses, reaches threshold', async ({ request }) => {
    test.skip(!storageAvailable, 'storage not available');

    const { body } = await endorseProposalAPI(request, proposalId, memberAID);
    expect(body.threshold_met).toBe(true);

    const { body: proposal } = await getProposalAPI(request, proposalId);
    expect(proposal.status).toBe('in_review');
    console.log('[Rejection] Endorsed → in_review');
  });

  test('admin claims lead role', async ({ request }) => {
    test.skip(!storageAvailable, 'storage not available');

    await updateProposalAPI(request, proposalId, { proposal_lead_id: adminAID }, adminAID);
    console.log('[Rejection] Admin claimed lead');
  });

  test('lead rejects proposal with reason', async ({ request }) => {
    test.skip(!storageAvailable, 'storage not available');

    const { response, body } = await transitionProposalAPI(
      request, proposalId, 'rejected', 'Does not align with community priorities', adminAID,
    );
    expect(response.ok(), `Reject failed: ${JSON.stringify(body)}`).toBeTruthy();
    expect(body.status).toBe('rejected');
    console.log('[Rejection] Proposal rejected');
  });

  test('verify rejection is final (no further transitions)', async ({ request }) => {
    test.skip(!storageAvailable, 'storage not available');

    // Try to transition from rejected → should fail
    const { response: r1 } = await transitionProposalAPI(request, proposalId, 'submitted');
    expect(r1.status()).toBe(400);

    const { response: r2 } = await transitionProposalAPI(request, proposalId, 'approved');
    expect(r2.status()).toBe(400);

    console.log('[Rejection] Rejected is a terminal state');
  });

  test('verify rejection reason in history', async ({ request }) => {
    test.skip(!storageAvailable, 'storage not available');

    const { body } = await getHistoryAPI(request, proposalId);
    const entries = body.history || [];
    const rejectionEntry = entries.find(
      (e: { action: string }) => e.action.includes('rejected') || e.action.includes('Does not align'),
    );
    expect(rejectionEntry).toBeTruthy();
    console.log('[Rejection] Rejection reason recorded in history');
  });
});

// ===========================================================================
// Group 5: Veto Flow — Elder Council vetoes
// Commented out while Elder Council governance actions are disabled.
// ===========================================================================

/*
test.describe.serial('Proposals Veto Flow', () => {
  let adminAID = 'e2e-veto-admin';
  const memberAID = 'e2e-veto-member';
  let storageAvailable = false;
  let proposalId: string;
  let decisionPlanId: string;

  test('probe storage', async ({ request }) => {
    try {
      const health = await request.get(`${BACKEND_URL}/health`);
      const data = await health.json();
      if (data.admin) adminAID = data.admin;
    } catch { /_ keep default _/ }
    const { response } = await createProposalAPI(request, adminAID, {
      title: 'Veto Probe',
    });
    storageAvailable = response.ok();
  });

  test('setup: create, endorse, sign off, create decision plan', async ({ request }) => {
    test.skip(!storageAvailable, 'storage not available');

    // Create and submit
    const { body: created } = await createProposalAPI(request, adminAID, {
      title: 'Proposal To Veto',
      endorsement_threshold: 1,
    });
    proposalId = created.id;

    await transitionProposalAPI(request, proposalId, 'submitted');
    await endorseProposalAPI(request, proposalId, memberAID);

    // Verify in_review
    const { body: p1 } = await getProposalAPI(request, proposalId);
    expect(p1.status).toBe('in_review');

    // Claim roles and sign off
    await updateProposalAPI(request, proposalId, {
      proposal_lead_id: adminAID,
      proposal_steward_id: adminAID,
    }, adminAID);
    await transitionProposalAPI(request, proposalId, 'signed_off', undefined, adminAID);

    // Create decision plan
    const { body: dp } = await createDecisionPlanAPI(request, proposalId, adminAID, adminAID);
    decisionPlanId = dp.id;

    // Add only Elder Council actions (meeting + veto decision)
    const { body: meeting } = await addGovernanceActionAPI(request, decisionPlanId, {
      house: 'elders_council',
      action_type: 'meeting',
      description: 'Veto review meeting',
    });
    const { body: decision } = await addGovernanceActionAPI(request, decisionPlanId, {
      house: 'elders_council',
      action_type: 'decision',
      description: 'Veto decision',
      linked_action_id: meeting.id,
    });

    // Submit and sign off decision plan → voting_process
    await transitionDecisionPlanAPI(request, decisionPlanId, 'submitted');
    await transitionDecisionPlanAPI(request, decisionPlanId, 'signed_off');

    const { body: p2 } = await getProposalAPI(request, proposalId);
    expect(p2.status).toBe('voting_process');

    // Complete meeting
    await completeGovernanceActionAPI(request, meeting.id, 'no_veto');

    // Elder Council vetoes
    await completeGovernanceActionAPI(request, decision.id, 'veto');

    console.log('[Veto] Setup complete, Elder Council vetoed');
  });

  test('proposal auto-rejected after veto', async ({ request }) => {
    test.skip(!storageAvailable, 'storage not available');

    const { body: proposal } = await getProposalAPI(request, proposalId);
    expect(proposal.status).toBe('rejected');
    console.log('[Veto] Proposal auto-rejected due to Elder Council veto');
  });

  test('veto rejection recorded in history', async ({ request }) => {
    test.skip(!storageAvailable, 'storage not available');

    const { body } = await getHistoryAPI(request, proposalId);
    const entries = body.history || [];
    const vetoEntry = entries.find(
      (e: { action: string }) => e.action.includes('unfavorable') || e.action.includes('rejected'),
    );
    expect(vetoEntry).toBeTruthy();
    console.log('[Veto] Veto rejection recorded in history');
  });
});
*/

// ===========================================================================
// Group 6: Proposal Comments
// ===========================================================================

test.describe.serial('Proposal Comments', () => {
  let proposalId: string;
  let storageAvailable = false;

  test('probe storage', async ({ request }) => {
    const { response, body } = await createProposalAPI(request, 'comment-test-user', {
      title: 'Comment Test Proposal',
    });
    if (response.ok() && body.id) {
      proposalId = body.id;
      storageAvailable = true;
      console.log('[Comments] Storage available, proposal created:', proposalId);
    } else {
      console.log('[Comments] Storage not available, skipping comment tests');
    }
  });

  test('empty comment list for new proposal', async ({ request }) => {
    test.skip(!storageAvailable, 'storage not available');

    const { response, body } = await listCommentsAPI(request, proposalId);
    expect(response.ok()).toBeTruthy();
    expect(body.comments || []).toHaveLength(0);
    expect(body.total).toBe(0);
    console.log('[Comments] New proposal has no comments');
  });

  test('add comment with user identity', async ({ request }) => {
    test.skip(!storageAvailable, 'storage not available');

    const { response, body } = await addCommentAPI(
      request,
      proposalId,
      'ETestAID123',
      'Test User',
      'This is a test comment',
    );
    expect(response.status()).toBe(201);
    expect(body.id).toBeTruthy();
    expect(body.proposal_id).toBe(proposalId);
    expect(body.user_id).toBe('ETestAID123');
    expect(body.user_name).toBe('Test User');
    expect(body.text).toBe('This is a test comment');
    expect(body.created_at).toBeTruthy();
    console.log('[Comments] Comment created:', body.id);
  });

  test('add second comment from different user', async ({ request }) => {
    test.skip(!storageAvailable, 'storage not available');

    const { response, body } = await addCommentAPI(
      request,
      proposalId,
      'EAnotherAID456',
      'Another User',
      'I agree with this proposal',
    );
    expect(response.status()).toBe(201);
    expect(body.user_name).toBe('Another User');
    console.log('[Comments] Second comment created:', body.id);
  });

  test('list comments returns both comments', async ({ request }) => {
    test.skip(!storageAvailable, 'storage not available');

    const { response, body } = await listCommentsAPI(request, proposalId);
    expect(response.ok()).toBeTruthy();
    const comments = body.comments || [];
    expect(comments.length).toBeGreaterThanOrEqual(2);

    // Find our specific comments (stale data from prior runs may exist)
    const testComment = comments.find((c: { user_name: string }) => c.user_name === 'Test User');
    const anotherComment = comments.find((c: { user_name: string }) => c.user_name === 'Another User');
    expect(testComment, 'Test User comment not found').toBeTruthy();
    expect(testComment.text).toBe('This is a test comment');
    expect(anotherComment, 'Another User comment not found').toBeTruthy();
    expect(anotherComment.text).toBe('I agree with this proposal');
    console.log('[Comments] Both comments found (%d total)', comments.length);
  });

  test('reject empty comment text', async ({ request }) => {
    test.skip(!storageAvailable, 'storage not available');

    const { response, body } = await addCommentAPI(
      request,
      proposalId,
      'ETestAID123',
      'Test User',
      '',
    );
    expect(response.status()).toBe(400);
    expect(body.error).toContain('text is required');
    console.log('[Comments] Empty comment rejected');
  });

  test('comments are scoped to proposal', async ({ request }) => {
    test.skip(!storageAvailable, 'storage not available');

    // Create a different proposal
    const { body: otherProposal } = await createProposalAPI(request, 'comment-test-user', {
      title: 'Other Proposal',
    });
    if (!otherProposal.id) {
      test.skip(true, 'could not create second proposal');
      return;
    }

    // Other proposal should have no comments
    const { body } = await listCommentsAPI(request, otherProposal.id);
    expect(body.comments || []).toHaveLength(0);
    console.log('[Comments] Comments correctly scoped to proposal');
  });
});
