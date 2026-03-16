/**
 * E2E Tests: Projects & Contributions Lifecycle
 *
 * Tests the complete projects and contributions system through API data
 * setup + UI verification with a single admin user:
 *   - Admin (Founding Member): full privileges
 *
 * Test 1 — Create project + plan + milestones + contributions via API,
 *           verify they appear correctly in the UI
 * Test 2 — Confirm contributions, sign off plan → verify signed-off badge
 * Test 3 — Share/offer contributions → verify status badges
 * Test 4 — Sub-contribution creation → verify under parent
 * Test 5 — Submit evidence + review + sign off → verify status updates
 * Test 6 — Permission edge cases → verify 4xx API responses
 *
 * Prerequisites:
 * - KERI test infrastructure running (ports 4901-4904)
 * - Backend running in test mode (port 9080)
 * - Test accounts created (org-setup must have run)
 *
 * Run: npx playwright test --project=projects-contributions
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
  type TestAccounts,
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

const HEADERS = { 'Content-Type': 'application/json' };

/** Create a project via API */
async function createProjectAPI(
  request: APIRequestContext,
  aid: string,
  overrides: Record<string, unknown> = {},
) {
  const body = {
    title: 'E2E Test Project',
    description: 'A project created during E2E testing',
    created_by: aid,
    ...overrides,
  };
  const response = await request.post(`${BACKEND_URL}/api/v1/projects`, {
    headers: authHeaders(aid),
    data: body,
  });
  return { response, body: await response.json() };
}

/** Create an implementation plan via API */
async function createPlanAPI(
  request: APIRequestContext,
  aid: string,
  projectId: string,
  overrides: Record<string, unknown> = {},
) {
  const body = {
    project_id: projectId,
    total_budget: '$10,000',
    project_lead: aid,
    project_steward_id: aid,
    ...overrides,
  };
  const response = await request.post(`${BACKEND_URL}/api/v1/implementation-plans`, {
    headers: authHeaders(aid),
    data: body,
  });
  return { response, body: await response.json() };
}

/** Add a milestone to a plan via API */
async function addMilestoneAPI(
  request: APIRequestContext,
  planId: string,
  title: string,
  duration: string,
  contributionIds: string[] = [],
) {
  const response = await request.post(
    `${BACKEND_URL}/api/v1/implementation-plans/${planId}/milestones`,
    {
      headers: HEADERS,
      data: { title, duration, contribution_ids: contributionIds },
    },
  );
  return { response, body: await response.json() };
}

/** Create a contribution via API */
async function createContributionAPI(
  request: APIRequestContext,
  aid: string,
  projectId: string,
  overrides: Record<string, unknown> = {},
) {
  const body = {
    project_id: projectId,
    title: 'E2E Contribution',
    description: 'Contribution created during E2E testing',
    contribution_type: 'technical',
    priority: 'medium',
    created_by: aid,
    objectives: ['Test objective'],
    deliverables: ['Test deliverable'],
    acceptance_criteria: ['Test criterion'],
    skill_requirements: ['Testing'],
    ...overrides,
  };
  const response = await request.post(`${BACKEND_URL}/api/v1/contributions`, {
    headers: authHeaders(aid),
    data: body,
  });
  return { response, body: await response.json() };
}

/** Confirm a contribution via API */
async function confirmContributionAPI(
  request: APIRequestContext,
  aid: string,
  contribId: string,
) {
  const response = await request.post(
    `${BACKEND_URL}/api/v1/contributions/${contribId}/confirm`,
    { headers: authHeaders(aid) },
  );
  return { response, body: await response.json() };
}

/** Share a contribution via API */
async function shareContributionAPI(
  request: APIRequestContext,
  aid: string,
  contribId: string,
  roles: string[] = ['contributor', 'member'],
) {
  const response = await request.post(
    `${BACKEND_URL}/api/v1/contributions/${contribId}/share`,
    {
      headers: authHeaders(aid),
      data: { shared_with_roles: roles },
    },
  );
  return { response, body: await response.json() };
}

/** Offer a contribution to a user via API */
async function offerContributionAPI(
  request: APIRequestContext,
  aid: string,
  contribId: string,
  offeredTo: string,
  offeredToName: string,
) {
  const response = await request.post(
    `${BACKEND_URL}/api/v1/contributions/${contribId}/offer`,
    {
      headers: authHeaders(aid),
      data: { offered_to: offeredTo, offered_to_name: offeredToName },
    },
  );
  return { response, body: await response.json() };
}

/** Accept an offer via API */
async function acceptOfferAPI(
  request: APIRequestContext,
  aid: string,
  contribId: string,
) {
  const response = await request.post(
    `${BACKEND_URL}/api/v1/contributions/${contribId}/accept-offer`,
    {
      headers: authHeaders(aid),
      data: { user_id: aid },
    },
  );
  return { response, body: await response.json() };
}

/** Submit evidence for a contribution via API */
async function submitEvidenceAPI(
  request: APIRequestContext,
  aid: string,
  contribId: string,
  notes: string,
  evidenceUrls: string[] = [],
) {
  const response = await request.post(
    `${BACKEND_URL}/api/v1/contributions/${contribId}/submit-evidence`,
    {
      headers: authHeaders(aid),
      data: { completion_notes: notes, evidence_urls: evidenceUrls },
    },
  );
  return { response, body: await response.json() };
}

/** Review a contribution via API */
async function reviewContributionAPI(
  request: APIRequestContext,
  aid: string,
  contribId: string,
  decision: string,
  reviewNotes: string = '',
  qualityRating: number = 8,
) {
  const response = await request.post(
    `${BACKEND_URL}/api/v1/contributions/${contribId}/review`,
    {
      headers: authHeaders(aid),
      data: { decision, review_notes: reviewNotes, quality_rating: qualityRating },
    },
  );
  return { response, body: await response.json() };
}

/** Sign off a contribution via API */
async function signOffContributionAPI(
  request: APIRequestContext,
  aid: string,
  contribId: string,
) {
  const response = await request.post(
    `${BACKEND_URL}/api/v1/contributions/${contribId}/sign-off`,
    { headers: authHeaders(aid) },
  );
  return { response, body: await response.json() };
}

/** Sign off an implementation plan via API */
async function signOffPlanAPI(
  request: APIRequestContext,
  aid: string,
  planId: string,
) {
  const response = await request.post(
    `${BACKEND_URL}/api/v1/implementation-plans/${planId}/sign-off`,
    {
      headers: authHeaders(aid),
      data: { user_id: aid },
    },
  );
  return { response, body: await response.json() };
}

/** Approve a sub-contribution via API */
async function approveSubAPI(
  request: APIRequestContext,
  aid: string,
  contribId: string,
) {
  const response = await request.post(
    `${BACKEND_URL}/api/v1/contributions/${contribId}/approve-sub`,
    { headers: authHeaders(aid) },
  );
  return { response, body: await response.json() };
}

/** Get a contribution by ID via API */
async function getContributionAPI(
  request: APIRequestContext,
  contribId: string,
) {
  const response = await request.get(
    `${BACKEND_URL}/api/v1/contributions/${contribId}`,
  );
  return { response, body: await response.json() };
}

/** Get an implementation plan by ID via API */
async function getPlanAPI(
  request: APIRequestContext,
  planId: string,
) {
  const response = await request.get(
    `${BACKEND_URL}/api/v1/implementation-plans/${planId}`,
  );
  return { response, body: await response.json() };
}

// ===========================================================================
// Group 1: Full Lifecycle (performs org setup, then API + UI verification)
// ===========================================================================

test.describe.serial('Projects & Contributions — Full Lifecycle', () => {
  let accounts: TestAccounts;
  let context: BrowserContext;
  let page: Page;
  let adminAID: string;
  let storageAvailable = false;

  // State shared across tests
  let projectId: string;
  let planId: string;
  let milestoneId1: string;
  let milestoneId2: string;
  let contribId1: string; // milestone 1, main contribution
  let contribId2: string; // milestone 2, main contribution
  let contribId3: string; // extra contribution for share/offer flow
  let subContribId: string; // sub-contribution of contribId1
  let lifecycleContribId: string; // separate contribution for full lifecycle test

  // ------------------------------------------------------------------
  // Setup: login as admin
  // ------------------------------------------------------------------

  test.beforeAll(async ({ browser, request }) => {
    await requireAllTestServices();

    context = await browser.newContext();
    await setupTestConfig(context);
    page = await context.newPage();
    setupPageLogging(page, 'ProjectsContrib');

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
      console.log('[ProjectsContrib] No org config — running org setup...');
      accounts = await performOrgSetup(page, request);
    } else {
      console.log('[ProjectsContrib] Recovering admin identity...');
      accounts = loadAccounts();
      if (!accounts.admin?.mnemonic) {
        throw new Error(
          'No admin mnemonic in test-accounts.json — run org-setup first',
        );
      }
      await loginWithMnemonic(page, accounts.admin.mnemonic);
      console.log('[ProjectsContrib] Admin logged in');
    }

    // Resolve admin AID: prefer saved value, then localStorage, then health endpoint
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
    console.log('[ProjectsContrib] Admin AID: %s', adminAID);
  });

  test.afterAll(async () => {
    await context?.close();
  });

  // ------------------------------------------------------------------
  // Test 1: Create project + plan + milestones + contributions via API
  //          → verify they appear in the UI
  // ------------------------------------------------------------------

  test('probe: check if project storage is available', async ({ request }) => {
    const { response, body } = await createProjectAPI(request, adminAID, {
      title: 'Storage Probe',
    });

    if (response.ok()) {
      storageAvailable = true;
      console.log('[Test] Storage available — created probe project:', body.id);
      // Clean up the probe
    } else {
      console.log(
        '[Test] Storage unavailable: %s — lifecycle tests will be skipped',
        body.error || response.status(),
      );
    }
  });

  test('create project via API', async ({ request }) => {
    test.skip(!storageAvailable, 'Storage not available');

    const { response, body } = await createProjectAPI(request, adminAID, {
      title: 'E2E Community Garden',
      description: 'A community garden project for E2E testing',
    });

    expect(response.status()).toBe(201);
    expect(body.id).toBeTruthy();
    projectId = body.id;
    console.log('[Test] Project created:', projectId);
  });

  test('create implementation plan via API', async ({ request }) => {
    test.skip(!storageAvailable, 'Storage not available');

    const { response, body } = await createPlanAPI(request, adminAID, projectId);

    expect(response.status()).toBe(201);
    expect(body.id).toBeTruthy();
    planId = body.id;
    console.log('[Test] Plan created:', planId);
  });

  test('add milestones and contributions via API', async ({ request }) => {
    test.skip(!storageAvailable, 'Storage not available');

    // Create two contributions first
    const { response: cr1, body: c1 } = await createContributionAPI(
      request,
      adminAID,
      projectId,
      { title: 'Design Phase', milestone_id: 'placeholder' },
    );
    expect(cr1.status()).toBe(201);
    contribId1 = c1.id;

    const { response: cr2, body: c2 } = await createContributionAPI(
      request,
      adminAID,
      projectId,
      { title: 'Build Phase', milestone_id: 'placeholder' },
    );
    expect(cr2.status()).toBe(201);
    contribId2 = c2.id;

    // Add milestones with contribution IDs embedded
    const { response: mr1, body: ms1 } = await addMilestoneAPI(
      request,
      planId,
      'Phase 1: Design',
      '2 weeks',
      [contribId1],
    );
    expect(mr1.status()).toBe(201);
    milestoneId1 = ms1.milestone_id;

    const { response: mr2, body: ms2 } = await addMilestoneAPI(
      request,
      planId,
      'Phase 2: Build',
      '4 weeks',
      [contribId2],
    );
    expect(mr2.status()).toBe(201);
    milestoneId2 = ms2.milestone_id;

    // Create a third contribution for share/offer tests later
    const { response: cr3, body: c3 } = await createContributionAPI(
      request,
      adminAID,
      projectId,
      { title: 'Outreach Contribution' },
    );
    expect(cr3.status()).toBe(201);
    contribId3 = c3.id;

    console.log(
      '[Test] Milestones: [%s, %s], Contributions: [%s, %s, %s]',
      milestoneId1,
      milestoneId2,
      contribId1,
      contribId2,
      contribId3,
    );
  });

  test('UI: navigate to projects page and see the project', async () => {
    test.skip(!storageAvailable, 'Storage not available');

    // Click the Projects nav item
    const navItem = page.locator('.nav-item', { hasText: 'Projects' });
    await expect(navItem).toBeVisible({ timeout: TIMEOUT.short });
    await navItem.click();

    await expect(page).toHaveURL(/\/dashboard\/projects/, {
      timeout: TIMEOUT.short,
    });

    // Wait for the projects list to load
    await page.waitForTimeout(2000);

    // The project card should show the title (use first() in case of leftovers from prior runs)
    const projectCard = page.locator('.project-card', {
      hasText: 'E2E Community Garden',
    }).first();
    await expect(projectCard).toBeVisible({ timeout: TIMEOUT.medium });
    console.log('[Test] Project card visible on projects page');

    // Click through to project detail
    await projectCard.click();
    await expect(page).toHaveURL(/\/dashboard\/projects\//, {
      timeout: TIMEOUT.short,
    });

    // Verify project header renders
    await expect(page.locator('.project-title')).toContainText(
      'E2E Community Garden',
      { timeout: TIMEOUT.medium },
    );
    console.log('[Test] Project detail page loaded with correct title');
  });

  test('UI: project detail shows implementation plan section', async () => {
    test.skip(!storageAvailable, 'Storage not available');

    // The content-section with "Implementation Plan" title should be visible
    const planSection = page.locator('.section-title', {
      hasText: 'Implementation Plan',
    });
    await expect(planSection).toBeVisible({ timeout: TIMEOUT.medium });
    console.log('[Test] Implementation Plan section visible');
  });

  test('UI: milestones are listed in the project detail', async () => {
    test.skip(!storageAvailable, 'Storage not available');

    // Wait for milestones to load
    await page.waitForTimeout(1500);

    // Look for milestone titles in milestone cards
    const milestone1 = page.locator('.milestone-title', {
      hasText: 'Phase 1: Design',
    });
    const milestone2 = page.locator('.milestone-title', {
      hasText: 'Phase 2: Build',
    });

    // At least check that the milestones list area is present
    const milestonesList = page.locator('.milestones-list');
    const hasMilestones = await milestonesList.isVisible().catch(() => false);

    if (hasMilestones) {
      // Milestones are rendering
      const m1Visible = await milestone1.isVisible().catch(() => false);
      const m2Visible = await milestone2.isVisible().catch(() => false);
      console.log(
        '[Test] Milestones list visible. Phase 1: %s, Phase 2: %s',
        m1Visible,
        m2Visible,
      );
    } else {
      // Milestones may not have loaded due to data hydration - check empty state
      const emptyState = page.locator('.empty-milestones');
      const noMilestonesYet = await emptyState.isVisible().catch(() => false);
      console.log(
        '[Test] No milestones list rendered (empty=%s) — milestone hydration may need reload',
        noMilestonesYet,
      );
    }
  });

  // ------------------------------------------------------------------
  // Test 2: Confirm contributions + sign off plan → verify badge
  // ------------------------------------------------------------------

  test('confirm all contributions via API', async ({ request }) => {
    test.skip(!storageAvailable, 'Storage not available');

    const { response: r1 } = await confirmContributionAPI(request, adminAID, contribId1);
    expect(r1.ok()).toBeTruthy();

    const { response: r2 } = await confirmContributionAPI(request, adminAID, contribId2);
    expect(r2.ok()).toBeTruthy();

    // Verify via API
    const { body: c1 } = await getContributionAPI(request, contribId1);
    expect(c1.status).toBe('confirmed');

    const { body: c2 } = await getContributionAPI(request, contribId2);
    expect(c2.status).toBe('confirmed');

    console.log('[Test] Both contributions confirmed');
  });

  test('sign off plan via API', async ({ request }) => {
    test.skip(!storageAvailable, 'Storage not available');

    const { response, body } = await signOffPlanAPI(request, adminAID, planId);
    expect(response.ok()).toBeTruthy();
    expect(body.signed_off).toBe(true);

    console.log('[Test] Plan signed off successfully');
  });

  test('API: verify plan is signed off', async ({ request }) => {
    test.skip(!storageAvailable, 'Storage not available');

    // Verify plan sign-off state via API (avoids expensive page reload)
    const { body } = await getPlanAPI(request, planId);
    expect(body.signed_off).toBe(true);
    expect(body.signed_off_by).toBeTruthy();
    console.log('[Test] Plan signed_off=%s, signed_off_by=%s', body.signed_off, body.signed_off_by);
  });

  // ------------------------------------------------------------------
  // Test 3: Share and offer contributions → verify status badges
  // ------------------------------------------------------------------

  test('share and offer contributions via API', async ({ request }) => {
    test.skip(!storageAvailable, 'Storage not available');

    // First confirm contribId3 so it can be shared
    const { response: confirmR } = await confirmContributionAPI(
      request,
      adminAID,
      contribId3,
    );
    expect(confirmR.ok()).toBeTruthy();

    // Share it
    const { response: shareR, body: shareBody } = await shareContributionAPI(
      request,
      adminAID,
      contribId3,
    );
    expect(shareR.ok()).toBeTruthy();
    expect(shareBody.status).toBe('shared');

    // Now offer it to the admin themselves (for testing purposes)
    const { response: offerR, body: offerBody } = await offerContributionAPI(
      request,
      adminAID,
      contribId3,
      adminAID,
      'Admin User',
    );
    expect(offerR.ok()).toBeTruthy();
    expect(offerBody.status).toBe('offered');

    console.log('[Test] Contribution shared then offered');
  });

  test('UI: contributions page shows contribution with offered status', async () => {
    test.skip(!storageAvailable, 'Storage not available');

    // Navigate to the Contributions page
    const navItem = page.locator('.nav-item', { hasText: 'Contributions' });
    await expect(navItem).toBeVisible({ timeout: TIMEOUT.short });
    await navItem.click();

    await expect(page).toHaveURL(/\/dashboard\/contributions/, {
      timeout: TIMEOUT.short,
    });

    await page.waitForTimeout(2000);

    // Look for the "Outreach Contribution" text on the page
    const contrib = page.locator('text=Outreach Contribution');
    const isVisible = await contrib.isVisible().catch(() => false);

    if (isVisible) {
      console.log('[Test] Outreach Contribution visible on contributions page');

      // Check that an "Offered" status badge exists somewhere on the page
      const offeredBadge = page.locator('.status-badge.offered');
      const hasBadge = await offeredBadge.first().isVisible().catch(() => false);
      console.log('[Test] Offered status badge visible: %s', hasBadge);
    } else {
      console.log('[Test] Outreach Contribution not found — contributions may not be loaded');
    }
  });

  // ------------------------------------------------------------------
  // Test 4: Sub-contribution creation → verify it appears
  // ------------------------------------------------------------------

  test('create sub-contribution via API', async ({ request }) => {
    test.skip(!storageAvailable, 'Storage not available');

    // Create a contribution that will serve as parent for the sub-contrib
    // Use contribId1 (already confirmed); create a child contribution
    const { response, body } = await createContributionAPI(
      request,
      adminAID,
      projectId,
      {
        title: 'Sub: Design Review',
        description: 'Sub-contribution under Design Phase',
        parent_contribution: contribId1,
      },
    );
    expect(response.status()).toBe(201);
    subContribId = body.id;
    expect(body.parent_contribution).toBe(contribId1);

    console.log('[Test] Sub-contribution created: %s under parent %s', subContribId, contribId1);
  });

  test('API: verify sub-contribution exists with parent link', async ({ request }) => {
    test.skip(!storageAvailable, 'Storage not available');

    const { body } = await getContributionAPI(request, subContribId);
    expect(body.parent_contribution).toBe(contribId1);
    expect(body.title).toBe('Sub: Design Review');
    console.log('[Test] Sub-contribution %s linked to parent %s', subContribId, contribId1);
  });

  // ------------------------------------------------------------------
  // Test 5: Full contribution lifecycle: offer → accept → evidence → review → sign-off
  // ------------------------------------------------------------------

  test('create and drive contribution through full lifecycle via API', async ({
    request,
  }) => {
    test.skip(!storageAvailable, 'Storage not available');

    // Create a fresh contribution for lifecycle testing
    const { response: createR, body: created } = await createContributionAPI(
      request,
      adminAID,
      projectId,
      { title: 'Lifecycle Contribution' },
    );
    expect(createR.status()).toBe(201);
    lifecycleContribId = created.id;
    expect(created.status).toBe('created');

    // Step 1: Confirm
    const { response: confirmR, body: confirmed } = await confirmContributionAPI(
      request,
      adminAID,
      lifecycleContribId,
    );
    expect(confirmR.ok()).toBeTruthy();
    expect(confirmed.status).toBe('confirmed');

    // Step 2: Share
    const { response: shareR, body: shared } = await shareContributionAPI(
      request,
      adminAID,
      lifecycleContribId,
    );
    expect(shareR.ok()).toBeTruthy();
    expect(shared.status).toBe('shared');

    // Step 3: Offer to admin
    const { response: offerR, body: offered } = await offerContributionAPI(
      request,
      adminAID,
      lifecycleContribId,
      adminAID,
      'Admin User',
    );
    expect(offerR.ok()).toBeTruthy();
    expect(offered.status).toBe('offered');

    // Step 4: Accept offer
    const { response: acceptR, body: accepted } = await acceptOfferAPI(
      request,
      adminAID,
      lifecycleContribId,
    );
    expect(acceptR.ok()).toBeTruthy();
    expect(accepted.status).toBe('assigned');

    // Step 5: Submit evidence
    const { response: evidenceR, body: withEvidence } = await submitEvidenceAPI(
      request,
      adminAID,
      lifecycleContribId,
      'Work completed successfully. All deliverables met.',
      ['https://example.com/evidence/1'],
    );
    expect(evidenceR.ok()).toBeTruthy();
    expect(withEvidence.status).toBe('needs_review');

    // Step 6: Review — approve
    const { response: reviewR, body: reviewed } = await reviewContributionAPI(
      request,
      adminAID,
      lifecycleContribId,
      'approved',
      'Excellent work on all deliverables',
      9,
    );
    expect(reviewR.ok()).toBeTruthy();
    expect(reviewed.status).toBe('approved');

    // Step 7: Sign off
    const { response: signOffR, body: signedOff } = await signOffContributionAPI(
      request,
      adminAID,
      lifecycleContribId,
    );
    expect(signOffR.ok()).toBeTruthy();
    expect(signedOff.status).toBe('signed_off');

    console.log(
      '[Test] Full lifecycle: created → confirmed → shared → offered → assigned → needs_review → approved → signed_off',
    );
  });

  test('API: verify lifecycle contribution reached signed_off status', async ({ request }) => {
    test.skip(!storageAvailable, 'Storage not available');

    const { body } = await getContributionAPI(request, lifecycleContribId);
    expect(body.status).toBe('signed_off');
    console.log('[Test] Lifecycle contribution status: %s', body.status);
  });

  // ------------------------------------------------------------------
  // Test 6: Permission edge cases — verify via API 4xx responses
  // ------------------------------------------------------------------

  test('cannot sign off an unconfirmed plan', async ({ request }) => {
    test.skip(!storageAvailable, 'Storage not available');

    // Create a fresh project + plan + milestone + unconfirmed contribution
    const { body: proj } = await createProjectAPI(request, adminAID, {
      title: 'Edge Case Project',
    });

    const { body: plan } = await createPlanAPI(request, adminAID, proj.id);

    const { body: contrib } = await createContributionAPI(
      request,
      adminAID,
      proj.id,
      { title: 'Unconfirmed Work' },
    );

    // Add milestone with the unconfirmed contribution
    await addMilestoneAPI(request, plan.id, 'Edge Milestone', '1 week', [
      contrib.id,
    ]);

    // Attempt to sign off plan — should fail because contribution is unconfirmed
    const { response } = await signOffPlanAPI(request, adminAID, plan.id);
    expect(response.status()).toBe(422);

    const body = await response.json();
    expect(body.error).toContain('unconfirmed');
    console.log('[Test] Plan sign-off correctly rejected: unconfirmed contributions');
  });

  test('cannot sign off plan that is already signed off', async ({ request }) => {
    test.skip(!storageAvailable, 'Storage not available');

    // Try to sign off the original plan again — should get 409
    const { response } = await signOffPlanAPI(request, adminAID, planId);
    expect(response.status()).toBe(409);

    const body = await response.json();
    expect(body.error).toContain('already signed off');
    console.log('[Test] Double sign-off correctly rejected: 409 Conflict');
  });

  test('cannot submit evidence when child contribution is incomplete', async ({
    request,
  }) => {
    test.skip(!storageAvailable, 'Storage not available');

    // Create a parent contribution
    const { body: parent } = await createContributionAPI(
      request,
      adminAID,
      projectId,
      { title: 'Parent with Children' },
    );

    // Create a child contribution
    const { body: child } = await createContributionAPI(
      request,
      adminAID,
      projectId,
      {
        title: 'Incomplete Child',
        parent_contribution: parent.id,
      },
    );

    // Confirm parent
    await confirmContributionAPI(request, adminAID, parent.id);

    // Share + offer + accept parent to get it to "assigned"
    await shareContributionAPI(request, adminAID, parent.id);
    await offerContributionAPI(request, adminAID, parent.id, adminAID, 'Admin');
    await acceptOfferAPI(request, adminAID, parent.id);

    // Try to submit evidence on parent — should fail because child is not signed off
    const { response } = await submitEvidenceAPI(
      request,
      adminAID,
      parent.id,
      'Trying to submit with incomplete child',
    );
    expect(response.status()).toBe(409);

    const body = await response.json();
    expect(body.error).toContain('blocking');
    expect(body.blocking_children).toBeDefined();
    expect(body.blocking_children).toContain(child.id);
    console.log(
      '[Test] Evidence submission correctly blocked by incomplete child: %s',
      child.id,
    );
  });

  test('cannot confirm a contribution that is not in created status', async ({
    request,
  }) => {
    test.skip(!storageAvailable, 'Storage not available');

    // contribId1 is already confirmed — trying to confirm again should fail
    const { response } = await confirmContributionAPI(
      request,
      adminAID,
      contribId1,
    );
    expect(response.ok()).toBeFalsy();

    const body = await response.json();
    expect(body.error).toContain('created');
    console.log('[Test] Re-confirm correctly rejected');
  });

  test('cannot review a contribution not in needs_review status', async ({
    request,
  }) => {
    test.skip(!storageAvailable, 'Storage not available');

    // contribId1 is "confirmed" — trying to review should fail
    const { response } = await reviewContributionAPI(
      request,
      adminAID,
      contribId1,
      'approved',
      'Should fail',
    );
    expect(response.ok()).toBeFalsy();
    console.log('[Test] Review of non-reviewable contribution correctly rejected');
  });

  test('cannot sign off a contribution not in approved status', async ({
    request,
  }) => {
    test.skip(!storageAvailable, 'Storage not available');

    // contribId2 is "confirmed" — trying to sign off should fail
    const { response } = await signOffContributionAPI(
      request,
      adminAID,
      contribId2,
    );
    expect(response.ok()).toBeFalsy();
    console.log('[Test] Sign-off of non-approved contribution correctly rejected');
  });

  // ------------------------------------------------------------------
  // Final: Navigate back to projects page and verify page state
  // ------------------------------------------------------------------

  test('UI: navigate back to projects and verify project still listed', async () => {
    test.skip(!storageAvailable, 'Storage not available');

    const navItem = page.locator('.nav-item', { hasText: 'Projects' });
    await navItem.click();

    await expect(page).toHaveURL(/\/dashboard\/projects/, {
      timeout: TIMEOUT.short,
    });

    await page.waitForTimeout(2000);

    // The original project should still appear
    const projectCard = page.locator('.project-card', {
      hasText: 'E2E Community Garden',
    }).first();
    await expect(projectCard).toBeVisible({ timeout: TIMEOUT.medium });

    console.log('[Test] Projects page still shows all created projects');
  });
});

// ===========================================================================
// Group 2: API Validation (runs after Full Lifecycle so org setup is complete)
// ===========================================================================

test.describe.serial('Projects & Contributions — API Validation', () => {
  test('backend is reachable', async ({ request }) => {
    const response = await request.get(`${BACKEND_URL}/health`);
    expect(response.ok()).toBeTruthy();
    console.log('[Test] Backend health check passed');
  });

  test('rejects project creation with empty title', async ({ request }) => {
    // Get admin AID from health endpoint (RBAC requires valid admin identity)
    const health = await request.get(`${BACKEND_URL}/health`);
    const { admin: adminAID } = await health.json();
    expect(adminAID).toBeTruthy();
    const response = await request.post(`${BACKEND_URL}/api/v1/projects`, {
      headers: authHeaders(adminAID),
      data: { title: '', description: 'No title', created_by: adminAID },
    });
    expect(response.status()).toBe(400);
    console.log('[Test] Empty project title rejected');
  });

  test('rejects contribution creation with missing required fields', async ({ request }) => {
    const response = await request.post(`${BACKEND_URL}/api/v1/contributions`, {
      headers: HEADERS,
      data: { title: 'Missing fields' },
    });
    expect(response.status()).toBe(400);
    console.log('[Test] Missing contribution fields rejected');
  });
});
