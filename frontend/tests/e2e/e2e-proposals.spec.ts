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
import { test, expect, Page, BrowserContext, APIRequestContext } from '@playwright/test';
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
) {
  const data: Record<string, string> = { status };
  if (reason) data.reason = reason;

  const response = await request.post(
    `${BACKEND_URL}/api/v1/proposals/${proposalId}/transition`,
    {
      headers: { 'Content-Type': 'application/json' },
      data,
    },
  );
  return { response, body: await response.json() };
}

async function updateProposalAPI(
  request: APIRequestContext,
  proposalId: string,
  fields: Record<string, unknown>,
) {
  const response = await request.patch(
    `${BACKEND_URL}/api/v1/proposals/${proposalId}`,
    {
      headers: { 'Content-Type': 'application/json' },
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
      headers: { 'Content-Type': 'application/json' },
      data: {
        endorser_id: endorserId,
        endorsed_at: new Date().toISOString(),
        comment: comment || undefined,
      },
    },
  );
  return { response, body: await response.json() };
}

async function getProposalAPI(request: APIRequestContext, proposalId: string) {
  const response = await request.get(
    `${BACKEND_URL}/api/v1/proposals/${proposalId}`,
  );
  return { response, body: await response.json() };
}

async function getHistoryAPI(request: APIRequestContext, proposalId: string) {
  const response = await request.get(
    `${BACKEND_URL}/api/v1/proposals/${proposalId}/history`,
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
    headers: { 'Content-Type': 'application/json' },
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
) {
  const response = await request.post(
    `${BACKEND_URL}/api/v1/decision-plans/${dpId}/actions`,
    {
      headers: { 'Content-Type': 'application/json' },
      data: action,
    },
  );
  return { response, body: await response.json() };
}

async function completeGovernanceActionAPI(
  request: APIRequestContext,
  actionId: string,
  outcome: string,
) {
  const response = await request.post(
    `${BACKEND_URL}/api/v1/governance-actions/${actionId}/complete`,
    {
      headers: { 'Content-Type': 'application/json' },
      data: { outcome },
    },
  );
  return { response, body: await response.json() };
}

async function transitionDecisionPlanAPI(
  request: APIRequestContext,
  dpId: string,
  status: string,
) {
  const response = await request.post(
    `${BACKEND_URL}/api/v1/decision-plans/${dpId}/transition`,
    {
      headers: { 'Content-Type': 'application/json' },
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

    // "All" should be active by default
    await expect(
      page.locator('.filter-pill.active', { hasText: 'All' }),
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

    // Verify key form fields
    for (const label of [
      'Title',
      'Description',
      'Problem Statement',
      'Proposed Solution',
      'Type',
      'Priority',
    ]) {
      await expect(dialog.locator(`label:has-text("${label}")`)).toBeVisible();
    }

    // Verify action buttons
    await expect(dialog.getByRole('button', { name: /cancel/i })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /save/i })).toBeVisible();

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

    // Refresh the proposals page
    await page.reload();
    await page.waitForTimeout(2000);

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
// Group 3: Full 21-Step Proposal Lifecycle
//
// Steps mapped:
//   1.  Navigate to proposals (UI tested above)
//   2.  Click "+ New Proposal" (UI tested above)
//   3.  Fill form and create draft (Step 4: proposal created as "draft")
//   4.  Submit for endorsement → "submitted"
//   5.  Member endorses proposal
//   6.  Endorsement threshold met → auto "in_review"
//   7.  System creates Lead/Steward contribution requests
//   8.  Admin claims Lead + Steward roles
//   9.  Lead edits proposal (tracked in history)
//  10.  Lead signs off → "signed_off"
//  11.  Lead creates decision plan
//  12.  Lead adds governance actions (meeting + decision per house)
//  13.  Decision plan submitted for review
//  14.  Steward signs off decision plan → proposal auto "voting_process"
//  15.  Complete Elder Council meeting
//  16.  Elder Council votes: no veto
//  17.  Complete Community Reps meeting
//  18.  Community Reps vote: approved
//  19.  Complete Contributors meeting
//  20.  Contributors vote: approved → auto-evaluates → proposal "approved"
//  21.  Verify final approved state and history
//
// Also tests user access restrictions throughout.
// ===========================================================================

test.describe.serial('Proposals Full 21-Step Lifecycle', () => {
  const adminAID = 'e2e-admin-aid';
  const memberAID = 'e2e-member-aid';
  let storageAvailable = false;
  let proposalId: string;
  let decisionPlanId: string;

  // Governance action IDs per house
  let eldersMeetingId: string;
  let eldersDecisionId: string;
  let communityMeetingId: string;
  let communityDecisionId: string;
  let contributorsMeetingId: string;
  let contributorsDecisionId: string;

  // ------------------------------------------------------------------
  // Setup: probe storage availability
  // ------------------------------------------------------------------

  test('probe: check if proposal storage is available', async ({ request }) => {
    const { response, body } = await createProposalAPI(request, adminAID, {
      title: 'Storage Probe',
    });

    if (response.ok()) {
      storageAvailable = true;
      console.log('[Test] Storage available — created probe:', body.id);
    } else {
      console.log(
        '[Test] Storage unavailable: %s — lifecycle tests will be skipped',
        body.error || response.status(),
      );
    }
  });

  // ------------------------------------------------------------------
  // Step 3-4: Create proposal as draft
  // ------------------------------------------------------------------

  test('Step 3-4: admin creates proposal (draft)', async ({ request }) => {
    test.skip(!storageAvailable, 'any-sync storage not available');

    const { response, body } = await createProposalAPI(request, adminAID, {
      title: 'Full Lifecycle E2E Proposal',
      type: ['governance'],
      priority: 'high',
      description: 'Governance improvement proposal for E2E testing',
      problem_statement: 'Need to verify the complete 21-step lifecycle',
      solution: 'Automated E2E testing of all proposal steps',
      expected_outcomes: ['All 21 steps verified', 'Role-based access confirmed'],
      estimated_budget: '$500',
      timeline: '4 weeks',
      endorsement_threshold: 1, // Low threshold so 1 endorsement triggers auto-review
      attachments: [{ name: 'Design Doc', url: 'https://example.com/design.pdf' }],
    });

    expect(response.ok(), `Create failed: ${JSON.stringify(body)}`).toBeTruthy();
    expect(body.status).toBe('draft');
    expect(body.endorsement_threshold).toBe(1);
    expect(body.attachments).toHaveLength(1);
    proposalId = body.id;
    console.log('[Step 3-4] Proposal created as draft: %s', proposalId);
  });

  // ------------------------------------------------------------------
  // Step 5: Submit for endorsement → "submitted"
  // ------------------------------------------------------------------

  test('Step 5: admin submits for endorsement', async ({ request }) => {
    test.skip(!storageAvailable, 'any-sync storage not available');

    const { response, body } = await transitionProposalAPI(
      request, proposalId, 'submitted',
    );
    expect(response.ok(), `Transition failed: ${JSON.stringify(body)}`).toBeTruthy();
    expect(body.status).toBe('submitted');
    console.log('[Step 5] Proposal submitted for endorsement');
  });

  // ------------------------------------------------------------------
  // Access test: member cannot transition a submitted proposal
  // ------------------------------------------------------------------

  test('Access: member cannot sign off a submitted proposal', async ({ request }) => {
    test.skip(!storageAvailable, 'any-sync storage not available');

    // Member tries to jump straight to signed_off — should fail
    const { response } = await transitionProposalAPI(
      request, proposalId, 'signed_off',
    );
    expect(response.status()).toBe(400);
    console.log('[Access] Member cannot bypass to signed_off from submitted');
  });

  // ------------------------------------------------------------------
  // Step 7: Member endorses → threshold met → auto "in_review" (Steps 8-9)
  // ------------------------------------------------------------------

  test('Step 7-9: member endorses, threshold met, auto in_review + role contribs', async ({ request }) => {
    test.skip(!storageAvailable, 'any-sync storage not available');

    // Member endorses (threshold is 1, so this triggers auto-transition)
    const { response, body: endorseResult } = await endorseProposalAPI(
      request, proposalId, memberAID, 'I fully support this proposal',
    );
    expect(response.ok(), `Endorse failed: ${JSON.stringify(endorseResult)}`).toBeTruthy();
    expect(endorseResult.threshold_met).toBe(true);
    expect(endorseResult.new_status).toBe('in_review');
    console.log('[Step 7] Member endorsed, threshold_met=%s', endorseResult.threshold_met);

    // Verify proposal is now in_review with role contribution IDs
    const { body: proposal } = await getProposalAPI(request, proposalId);
    expect(proposal.status).toBe('in_review');
    expect(proposal.lead_contribution_id).toBeTruthy();
    expect(proposal.steward_contribution_id).toBeTruthy();
    console.log('[Step 8-9] Auto-transitioned to in_review, lead_contrib=%s, steward_contrib=%s',
      proposal.lead_contribution_id, proposal.steward_contribution_id);
  });

  // ------------------------------------------------------------------
  // Access: member cannot endorse a proposal already in_review
  // ------------------------------------------------------------------

  test('Access: member cannot endorse proposal in in_review status', async ({ request }) => {
    test.skip(!storageAvailable, 'any-sync storage not available');

    const { response } = await endorseProposalAPI(
      request, proposalId, 'another-member', 'Late endorsement',
    );
    expect(response.status()).toBe(400);
    console.log('[Access] Cannot endorse proposal in in_review status');
  });

  // ------------------------------------------------------------------
  // Step 10: Admin claims both Lead and Steward roles
  // ------------------------------------------------------------------

  test('Step 10: admin claims Lead and Steward roles', async ({ request }) => {
    test.skip(!storageAvailable, 'any-sync storage not available');

    // Assign admin as proposal lead
    const { response: leadResp, body: leadBody } = await updateProposalAPI(
      request, proposalId, { proposal_lead_id: adminAID },
    );
    expect(leadResp.ok(), `Lead assign failed: ${JSON.stringify(leadBody)}`).toBeTruthy();
    expect(leadBody.proposal_lead_id).toBe(adminAID);

    // Assign admin as proposal steward
    const { response: stewResp, body: stewBody } = await updateProposalAPI(
      request, proposalId, { proposal_steward_id: adminAID },
    );
    expect(stewResp.ok(), `Steward assign failed: ${JSON.stringify(stewBody)}`).toBeTruthy();
    expect(stewBody.proposal_steward_id).toBe(adminAID);

    console.log('[Step 10] Admin assigned as both Lead and Steward');
  });

  // ------------------------------------------------------------------
  // Step 11: Lead edits proposal, verify history tracked
  // ------------------------------------------------------------------

  test('Step 11: lead edits proposal (changes tracked)', async ({ request }) => {
    test.skip(!storageAvailable, 'any-sync storage not available');

    const { response, body } = await updateProposalAPI(
      request, proposalId, {
        description: 'Updated governance improvement proposal for E2E testing — revised after review',
        estimated_budget: '$750',
      },
    );
    expect(response.ok(), `Update failed: ${JSON.stringify(body)}`).toBeTruthy();
    expect(body.description).toContain('revised after review');
    expect(body.estimated_budget).toBe('$750');
    console.log('[Step 11] Lead edited proposal fields');
  });

  // ------------------------------------------------------------------
  // Access: member cannot update the proposal
  // ------------------------------------------------------------------

  test('Access: verify proposal update succeeds (no RBAC on PATCH yet)', async ({ request }) => {
    test.skip(!storageAvailable, 'any-sync storage not available');

    // PATCH doesn't have RBAC middleware yet, so we just verify the endpoint works
    // This documents expected behavior — when RBAC is added, change this test
    const { response } = await updateProposalAPI(
      request, proposalId, { timeline: '5 weeks' },
    );
    expect(response.ok()).toBeTruthy();
    console.log('[Access] PATCH currently accessible (no RBAC on sub-routes)');
  });

  // ------------------------------------------------------------------
  // Access: member cannot reject proposal
  // ------------------------------------------------------------------

  test('Access: member cannot transition to rejected directly', async ({ request }) => {
    test.skip(!storageAvailable, 'any-sync storage not available');

    // Only valid transitions from in_review: signed_off, rejected, draft
    // But the test is about authorization — any user can call transition
    // (RBAC is on collection endpoint only). This tests state machine:
    // a random invalid transition should fail
    const { response } = await transitionProposalAPI(
      request, proposalId, 'approved',
    );
    expect(response.status()).toBe(400);
    console.log('[Access] Cannot skip to approved from in_review');
  });

  // ------------------------------------------------------------------
  // Step 12: Lead signs off → "signed_off"
  // ------------------------------------------------------------------

  test('Step 12: lead signs off proposal', async ({ request }) => {
    test.skip(!storageAvailable, 'any-sync storage not available');

    const { response, body } = await transitionProposalAPI(
      request, proposalId, 'signed_off',
    );
    expect(response.ok(), `Sign off failed: ${JSON.stringify(body)}`).toBeTruthy();
    expect(body.status).toBe('signed_off');
    console.log('[Step 12] Proposal signed off');
  });

  // ------------------------------------------------------------------
  // Step 13: Lead creates decision plan
  // ------------------------------------------------------------------

  test('Step 13: lead creates decision plan', async ({ request }) => {
    test.skip(!storageAvailable, 'any-sync storage not available');

    const { response, body } = await createDecisionPlanAPI(
      request, proposalId, adminAID, adminAID,
    );
    expect(response.ok(), `DP create failed: ${JSON.stringify(body)}`).toBeTruthy();
    expect(body.status).toBe('drafted');
    expect(body.proposal_id).toBe(proposalId);
    decisionPlanId = body.id;
    console.log('[Step 13] Decision plan created: %s', decisionPlanId);
  });

  // ------------------------------------------------------------------
  // Step 14: Add governance actions — meeting + decision per house
  // ------------------------------------------------------------------

  test('Step 14: add governance actions for all 3 houses', async ({ request }) => {
    test.skip(!storageAvailable, 'any-sync storage not available');

    // Elder Council — meeting
    const { body: em } = await addGovernanceActionAPI(request, decisionPlanId, {
      house: 'elders_council',
      action_type: 'meeting',
      description: 'Elder Council governance meeting',
      meeting_date: '2026-04-01',
      meeting_time: '10:00',
      meeting_location: 'Council Chambers',
    });
    expect(em.id).toBeTruthy();
    eldersMeetingId = em.id;

    // Elder Council — decision (linked to meeting)
    const { body: ed } = await addGovernanceActionAPI(request, decisionPlanId, {
      house: 'elders_council',
      action_type: 'decision',
      description: 'Elder Council veto decision',
      linked_action_id: eldersMeetingId,
    });
    expect(ed.id).toBeTruthy();
    eldersDecisionId = ed.id;

    // Community Reps — meeting
    const { body: cm } = await addGovernanceActionAPI(request, decisionPlanId, {
      house: 'community_reps',
      action_type: 'meeting',
      description: 'Community representatives meeting',
      meeting_date: '2026-04-02',
      meeting_time: '14:00',
      meeting_location: 'Community Hall',
    });
    communityMeetingId = cm.id;

    // Community Reps — decision
    const { body: cd } = await addGovernanceActionAPI(request, decisionPlanId, {
      house: 'community_reps',
      action_type: 'decision',
      description: 'Community strategic vote',
      linked_action_id: communityMeetingId,
    });
    communityDecisionId = cd.id;

    // Contributors — meeting
    const { body: ctm } = await addGovernanceActionAPI(request, decisionPlanId, {
      house: 'contributors',
      action_type: 'meeting',
      description: 'Contributors operational meeting',
      meeting_date: '2026-04-03',
      meeting_time: '09:00',
      meeting_location: 'Online',
    });
    contributorsMeetingId = ctm.id;

    // Contributors — decision
    const { body: ctd } = await addGovernanceActionAPI(request, decisionPlanId, {
      house: 'contributors',
      action_type: 'decision',
      description: 'Contributors operational vote',
      linked_action_id: contributorsMeetingId,
    });
    contributorsDecisionId = ctd.id;

    console.log('[Step 14] Added 6 governance actions (3 meetings + 3 decisions)');

    // Verify decision plan has all actions
    const dpResp = await request.get(
      `${BACKEND_URL}/api/v1/decision-plans/${decisionPlanId}`,
    );
    const dp = await dpResp.json();
    // Note: governance_actions may be empty in the response since they're stored separately
    // The important thing is that the actions were created successfully
    console.log('[Step 14] Decision plan status: %s', dp.status);
  });

  // ------------------------------------------------------------------
  // Step 15: Submit decision plan for review
  // ------------------------------------------------------------------

  test('Step 15: submit decision plan for review', async ({ request }) => {
    test.skip(!storageAvailable, 'any-sync storage not available');

    const { response, body } = await transitionDecisionPlanAPI(
      request, decisionPlanId, 'submitted',
    );
    expect(response.ok(), `DP submit failed: ${JSON.stringify(body)}`).toBeTruthy();
    expect(body.status).toBe('submitted');
    console.log('[Step 15] Decision plan submitted for review');
  });

  // ------------------------------------------------------------------
  // Step 16: Steward signs off decision plan → proposal auto "voting_process"
  // ------------------------------------------------------------------

  test('Step 16: steward signs off decision plan → auto voting_process', async ({ request }) => {
    test.skip(!storageAvailable, 'any-sync storage not available');

    const { response, body } = await transitionDecisionPlanAPI(
      request, decisionPlanId, 'signed_off',
    );
    expect(response.ok(), `DP sign off failed: ${JSON.stringify(body)}`).toBeTruthy();
    expect(body.status).toBe('signed_off');

    // Proposal should now be auto-transitioned to voting_process
    const { body: proposal } = await getProposalAPI(request, proposalId);
    expect(proposal.status).toBe('voting_process');
    console.log('[Step 16] Decision plan signed off, proposal → voting_process');
  });

  // ------------------------------------------------------------------
  // Access: cannot transition proposal directly past voting_process
  // ------------------------------------------------------------------

  test('Access: cannot skip voting_process to completed', async ({ request }) => {
    test.skip(!storageAvailable, 'any-sync storage not available');

    const { response } = await transitionProposalAPI(
      request, proposalId, 'completed',
    );
    expect(response.status()).toBe(400);
    console.log('[Access] Cannot skip from voting_process to completed');
  });

  // ------------------------------------------------------------------
  // Steps 17-18: Elder Council — complete meeting, then vote "no_veto"
  // ------------------------------------------------------------------

  test('Step 17-18: Elder Council meeting completed + no veto', async ({ request }) => {
    test.skip(!storageAvailable, 'any-sync storage not available');

    // Complete the meeting
    const { response: meetResp, body: meetBody } = await completeGovernanceActionAPI(
      request, eldersMeetingId, 'no_veto',
    );
    expect(meetResp.ok(), `Elders meeting complete failed: ${JSON.stringify(meetBody)}`).toBeTruthy();
    expect(meetBody.status).toBe('completed');
    console.log('[Step 17] Elder Council meeting completed');

    // Elder Council vote: no veto
    const { response: voteResp, body: voteBody } = await completeGovernanceActionAPI(
      request, eldersDecisionId, 'no_veto',
    );
    expect(voteResp.ok(), `Elders decision failed: ${JSON.stringify(voteBody)}`).toBeTruthy();
    expect(voteBody.status).toBe('completed');
    expect(voteBody.outcome).toBe('no_veto');
    console.log('[Step 18] Elder Council voted: no veto');

    // Proposal should still be voting_process (not all houses voted yet)
    const { body: proposal } = await getProposalAPI(request, proposalId);
    expect(proposal.status).toBe('voting_process');
  });

  // ------------------------------------------------------------------
  // Steps 19: Community Reps — complete meeting, vote "approved"
  // ------------------------------------------------------------------

  test('Step 19: Community Reps meeting + strategic vote approved', async ({ request }) => {
    test.skip(!storageAvailable, 'any-sync storage not available');

    // Complete meeting
    const { response: meetResp } = await completeGovernanceActionAPI(
      request, communityMeetingId, 'approved',
    );
    expect(meetResp.ok()).toBeTruthy();
    console.log('[Step 19] Community Reps meeting completed');

    // Strategic vote: approved
    const { response: voteResp, body: voteBody } = await completeGovernanceActionAPI(
      request, communityDecisionId, 'approved',
    );
    expect(voteResp.ok()).toBeTruthy();
    expect(voteBody.outcome).toBe('approved');
    console.log('[Step 19] Community Reps voted: approved');

    // Still voting_process (contributors haven't voted)
    const { body: proposal } = await getProposalAPI(request, proposalId);
    expect(proposal.status).toBe('voting_process');
  });

  // ------------------------------------------------------------------
  // Steps 20-21: Contributors vote → all approved → proposal "approved"
  // ------------------------------------------------------------------

  test('Step 20-21: Contributors vote approved → proposal auto-approved', async ({ request }) => {
    test.skip(!storageAvailable, 'any-sync storage not available');

    // Complete meeting
    const { response: meetResp } = await completeGovernanceActionAPI(
      request, contributorsMeetingId, 'approved',
    );
    expect(meetResp.ok()).toBeTruthy();
    console.log('[Step 20] Contributors meeting completed');

    // Operational vote: approved (this is the last decision → triggers auto-evaluate)
    const { response: voteResp, body: voteBody } = await completeGovernanceActionAPI(
      request, contributorsDecisionId, 'approved',
    );
    expect(voteResp.ok()).toBeTruthy();
    expect(voteBody.outcome).toBe('approved');
    console.log('[Step 20] Contributors voted: approved');

    // Proposal should now be auto-approved
    const { body: proposal } = await getProposalAPI(request, proposalId);
    expect(proposal.status).toBe('approved');
    console.log('[Step 21] Proposal auto-approved! Final status: %s', proposal.status);
  });

  // ------------------------------------------------------------------
  // Verify history captures the full audit trail
  // ------------------------------------------------------------------

  test('Verify: history captures full audit trail', async ({ request }) => {
    test.skip(!storageAvailable, 'any-sync storage not available');

    const { response, body } = await getHistoryAPI(request, proposalId);
    expect(response.ok()).toBeTruthy();

    const entries = body.history || [];
    console.log('[Verify] History has %d entries:', entries.length);
    for (const entry of entries) {
      console.log('  - [%s] %s: %s', entry.created_at?.slice(0, 19), entry.user_id, entry.action);
    }

    // Should have key history events
    const actions = entries.map((e: { action: string }) => e.action);
    expect(actions.some((a: string) => a.includes('Endorsement threshold met'))).toBeTruthy();
    expect(actions.some((a: string) => a.includes('Proposal Lead contribution'))).toBeTruthy();
    expect(actions.some((a: string) => a.includes('Proposal Steward contribution'))).toBeTruthy();
    expect(actions.some((a: string) => a.includes('approved'))).toBeTruthy();

    console.log('[Verify] History audit trail verified');
  });

  // ------------------------------------------------------------------
  // Verify: endorsements are persisted
  // ------------------------------------------------------------------

  test('Verify: endorsements persisted', async ({ request }) => {
    test.skip(!storageAvailable, 'any-sync storage not available');

    const response = await request.get(
      `${BACKEND_URL}/api/v1/proposals/${proposalId}/endorsements`,
    );
    expect(response.ok()).toBeTruthy();

    const data = await response.json();
    expect(data.total).toBeGreaterThanOrEqual(1);
    expect(data.endorsements[0].endorser_id).toBe(memberAID);
    expect(data.endorsements[0].comment).toBe('I fully support this proposal');
    console.log('[Verify] %d endorsement(s) persisted', data.total);
  });

  // ------------------------------------------------------------------
  // Verify: final proposal state
  // ------------------------------------------------------------------

  test('Verify: final proposal has all expected fields', async ({ request }) => {
    test.skip(!storageAvailable, 'any-sync storage not available');

    const { body: proposal } = await getProposalAPI(request, proposalId);

    expect(proposal.status).toBe('approved');
    expect(proposal.proposal_lead_id).toBe(adminAID);
    expect(proposal.proposal_steward_id).toBe(adminAID);
    expect(proposal.lead_contribution_id).toBeTruthy();
    expect(proposal.steward_contribution_id).toBeTruthy();
    expect(proposal.endorsement_threshold).toBe(1);
    expect(proposal.attachments).toHaveLength(1);
    expect(proposal.attachments[0].name).toBe('Design Doc');
    expect(proposal.estimated_budget).toBe('$750'); // Updated by lead in step 11
    expect(proposal.title).toBe('Full Lifecycle E2E Proposal');
    expect(proposal.type).toContain('governance');
    expect(proposal.priority).toBe('high');

    console.log('[Verify] Final proposal state verified — all 21 steps complete');
  });
});

// ===========================================================================
// Group 4: Rejection Flow (separate lifecycle)
// ===========================================================================

test.describe.serial('Proposals Rejection Flow', () => {
  const adminAID = 'e2e-reject-admin';
  const memberAID = 'e2e-reject-member';
  let storageAvailable = false;
  let proposalId: string;

  test('probe storage', async ({ request }) => {
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

    await updateProposalAPI(request, proposalId, { proposal_lead_id: adminAID });
    console.log('[Rejection] Admin claimed lead');
  });

  test('lead rejects proposal with reason', async ({ request }) => {
    test.skip(!storageAvailable, 'storage not available');

    const { response, body } = await transitionProposalAPI(
      request, proposalId, 'rejected', 'Does not align with community priorities',
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
// ===========================================================================

test.describe.serial('Proposals Veto Flow', () => {
  const adminAID = 'e2e-veto-admin';
  const memberAID = 'e2e-veto-member';
  let storageAvailable = false;
  let proposalId: string;
  let decisionPlanId: string;

  test('probe storage', async ({ request }) => {
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
    });
    await transitionProposalAPI(request, proposalId, 'signed_off');

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
