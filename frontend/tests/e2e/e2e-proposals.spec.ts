/**
 * E2E Tests: Proposal Lifecycle
 *
 * Tests the proposal system through UI and API:
 *
 * Group 1 — RBAC & Validation (stateless API tests, no session needed)
 * Group 2 — UI Rendering & Interaction (requires admin login)
 * Group 3 — API Lifecycle (requires any-sync object storage)
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
) {
  const response = await request.post(
    `${BACKEND_URL}/api/v1/proposals/${proposalId}/transition`,
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

  test('rejects proposal with invalid priority', async ({ request }) => {
    const response = await request.post(`${BACKEND_URL}/api/v1/proposals`, {
      headers: authHeaders('test-user'),
      data: {
        proposer_id: 'test-user',
        title: 'Test',
        type: ['technical'],
        priority: 'super-urgent',
        description: 'desc',
        problem_statement: 'problem',
        solution: 'solution',
        expected_outcomes: ['outcome'],
        estimated_budget: '$0',
        timeline: '1w',
      },
    });
    expect(response.status()).toBeGreaterThanOrEqual(400);
    console.log('[Test] Invalid priority rejected: %d', response.status());
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
    // Should already be on proposals page from previous test
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

    for (const label of ['All', 'Draft', 'Submitted', 'In Review', 'Approved']) {
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
    const submittedPill = page.locator('.filter-pill', { hasText: 'Submitted' });

    // Click "Draft"
    await draftPill.click();
    await expect(draftPill).toHaveClass(/active/);
    await expect(allPill).not.toHaveClass(/active/);

    // Click "Submitted"
    await submittedPill.click();
    await expect(submittedPill).toHaveClass(/active/);
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

    // Verify all form fields
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
    await expect(dialog.getByRole('button', { name: /submit/i })).toBeVisible();

    // Cancel closes dialog
    await dialog.getByRole('button', { name: /cancel/i }).click();
    await expect(dialog).not.toBeVisible({ timeout: TIMEOUT.short });

    console.log('[Test] Create dialog renders all fields');
  });

  test('page shows empty state or proposal cards', async () => {
    // Wait for the page to settle after any fetch
    await page.waitForTimeout(2000);

    const cards = page.locator('.proposal-card');
    const emptyState = page.locator('.empty-state');

    const hasCards = (await cards.count()) > 0;
    const hasEmpty = await emptyState.isVisible().catch(() => false);

    expect(
      hasCards || hasEmpty,
      'Page should show cards or empty state',
    ).toBeTruthy();

    if (hasCards) {
      const firstCard = cards.first();
      await expect(firstCard.locator('.proposal-card-header')).toBeVisible();
      await expect(firstCard.locator('.status-badge')).toBeVisible();
      console.log('[Test] %d proposal cards rendered', await cards.count());
    } else {
      console.log('[Test] Empty state rendered');
    }
  });
});

// ===========================================================================
// Group 3: API Lifecycle (requires any-sync storage)
// ===========================================================================

test.describe.serial('Proposals API Lifecycle', () => {
  let userAID: string;
  let storageAvailable = false;

  test.beforeAll(async () => {
    const accounts = loadAccounts();
    userAID =
      accounts.admin?.aid ||
      accounts.member?.aid ||
      accounts.member2?.aid ||
      'test-user-aid';
    console.log('[Test] Using AID:', userAID);
  });

  test('probe: check if proposal storage is available', async ({ request }) => {
    const { response, body } = await createProposalAPI(request, userAID, {
      title: 'Storage Probe',
    });

    if (response.ok()) {
      storageAvailable = true;
      console.log('[Test] Storage available — created:', body.id);
    } else {
      console.log(
        '[Test] Storage unavailable: %s — lifecycle tests will be skipped',
        body.error || response.status(),
      );
    }
  });

  test('create and list proposals', async ({ request }) => {
    test.skip(!storageAvailable, 'any-sync storage not available');

    const { body: proposal } = await createProposalAPI(request, userAID, {
      title: 'List Test',
    });
    expect(proposal.id).toBeTruthy();
    expect(proposal.status).toBe('draft');

    const listResponse = await request.get(`${BACKEND_URL}/api/v1/proposals`, {
      headers: authHeaders(userAID),
    });
    expect(listResponse.ok()).toBeTruthy();

    const data = await listResponse.json();
    expect(data.total).toBeGreaterThanOrEqual(2);
    console.log('[Test] Listed %d proposals', data.total);
  });

  test('get proposal by ID', async ({ request }) => {
    test.skip(!storageAvailable, 'any-sync storage not available');

    const { body: created } = await createProposalAPI(request, userAID, {
      title: 'Get By ID',
    });

    const response = await request.get(
      `${BACKEND_URL}/api/v1/proposals/${created.id}`,
    );
    expect(response.ok()).toBeTruthy();

    const proposal = await response.json();
    expect(proposal.id).toBe(created.id);
    expect(proposal.title).toBe('Get By ID');
    console.log('[Test] Fetched proposal by ID');
  });

  test('status transitions: draft → submitted → endorsing', async ({
    request,
  }) => {
    test.skip(!storageAvailable, 'any-sync storage not available');

    const { body: created } = await createProposalAPI(request, userAID, {
      title: 'Transition Test',
    });
    expect(created.status).toBe('draft');

    const { body: submitted } = await transitionProposalAPI(
      request,
      created.id,
      'submitted',
    );
    expect(submitted.status).toBe('submitted');

    const { body: endorsing } = await transitionProposalAPI(
      request,
      created.id,
      'endorsing',
    );
    expect(endorsing.status).toBe('endorsing');

    console.log('[Test] draft → submitted → endorsing');
  });

  test('invalid transition is rejected', async ({ request }) => {
    test.skip(!storageAvailable, 'any-sync storage not available');

    const { body: created } = await createProposalAPI(request, userAID, {
      title: 'Invalid Transition',
    });

    const { response } = await transitionProposalAPI(
      request,
      created.id,
      'approved',
    );
    expect(response.status()).toBe(400);
    console.log('[Test] Invalid transition rejected');
  });

  test('endorsements: add and list', async ({ request }) => {
    test.skip(!storageAvailable, 'any-sync storage not available');

    const { body: created } = await createProposalAPI(request, userAID, {
      title: 'Endorsement Test',
    });
    await transitionProposalAPI(request, created.id, 'submitted');
    await transitionProposalAPI(request, created.id, 'endorsing');

    const endorseResponse = await request.post(
      `${BACKEND_URL}/api/v1/proposals/${created.id}/endorsements`,
      {
        headers: { 'Content-Type': 'application/json' },
        data: {
          endorser_id: userAID,
          endorsed_at: new Date().toISOString(),
          comment: 'E2E endorsement',
        },
      },
    );
    expect(endorseResponse.ok()).toBeTruthy();

    const listResponse = await request.get(
      `${BACKEND_URL}/api/v1/proposals/${created.id}/endorsements`,
    );
    const data = await listResponse.json();
    expect(data.total).toBe(1);
    expect(data.endorsements[0].endorser_id).toBe(userAID);

    console.log('[Test] Endorsement lifecycle verified');
  });

  test('full lifecycle: draft → signed_off', async ({ request }) => {
    test.skip(!storageAvailable, 'any-sync storage not available');

    const { body: proposal } = await createProposalAPI(request, userAID, {
      title: 'Full Lifecycle',
      type: ['governance'],
      priority: 'high',
    });

    for (const status of ['submitted', 'endorsing', 'in_review', 'signed_off']) {
      const { body, response } = await transitionProposalAPI(
        request,
        proposal.id,
        status,
      );
      expect(
        response.ok(),
        `Transition to ${status} failed: ${JSON.stringify(body)}`,
      ).toBeTruthy();
      expect(body.status).toBe(status);
    }

    const getResponse = await request.get(
      `${BACKEND_URL}/api/v1/proposals/${proposal.id}`,
    );
    const final = await getResponse.json();
    expect(final.status).toBe('signed_off');

    console.log('[Test] Full lifecycle: draft → signed_off');
  });
});
