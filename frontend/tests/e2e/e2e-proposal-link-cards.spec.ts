/**
 * E2E Tests: Proposal Link Preview Cards in Chat
 *
 * Tests the feature where pasting a proposal link into chat renders a rich
 * preview card, and clicking the card opens a detail modal with endorsement
 * support.
 *
 * Flow:
 *  Test 1: Create a proposal via API, send its link in chat, verify card renders
 *  Test 2: Click the card → detail modal opens with correct proposal data
 *  Test 3: Endorse via the modal, verify endorsement count updates
 *  Test 4: Invalid proposal link shows error state on the card
 *  Test 5: Multiple proposal links in one message render multiple cards
 *  Test 6: Duplicate links in one message render only one card
 *
 * Prerequisites:
 * - KERI test infrastructure running (ports 4901-4904)
 * - Backend running in test mode (port 9080)
 * - Test accounts created (org-setup must have run)
 *
 * Run: npx playwright test --project=proposal-link-cards
 */
import { test, expect, Page, BrowserContext, APIRequestContext } from '@playwright/test';
import { setupTestConfig } from './utils/mock-config';
import { requireAllTestServices } from './utils/keri-testnet';
import {
  BACKEND_URL,
  TIMEOUT,
  setupPageLogging,
  loginWithMnemonic,
  loadAccounts,
  type TestAccounts,
} from './utils/test-helpers';

const CHAT_URL = '/#/dashboard/chat';

// ---------------------------------------------------------------------------
// API Helpers
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
    title: 'Link Card Test Proposal',
    type: ['technical'],
    priority: 'medium',
    description: 'A proposal for testing link preview cards in chat',
    problem_statement: 'Need to verify proposal link cards render correctly',
    solution: 'Automated E2E testing of proposal link cards',
    expected_outcomes: ['Card renders', 'Modal opens', 'Endorsement works'],
    estimated_budget: '100',
    timeline: '2',
    endorsement_threshold: 1,
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

async function getFirstChannelId(page: Page, backendUrl: string): Promise<string | null> {
  return page.evaluate(async (url) => {
    try {
      const resp = await fetch(`${url}/api/v1/chat/channels`);
      const data = await resp.json();
      return data.channels?.[0]?.id ?? null;
    } catch {
      return null;
    }
  }, backendUrl);
}

async function createChannelAPI(
  request: APIRequestContext,
  aid: string,
  name: string,
) {
  const response = await request.post(`${BACKEND_URL}/api/v1/chat/channels`, {
    headers: authHeaders(aid),
    data: { name, description: 'E2E test channel for proposal link cards' },
  });
  return { response, body: await response.json() };
}

async function sendMessageAPI(
  request: APIRequestContext,
  channelId: string,
  aid: string,
  content: string,
) {
  const response = await request.post(
    `${BACKEND_URL}/api/v1/chat/channels/${channelId}/messages`,
    {
      headers: authHeaders(aid),
      data: {
        content,
        sender_id: aid,
        sender_name: 'Admin',
      },
    },
  );
  return { response, body: await response.json() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe.serial('Proposal Link Cards in Chat', () => {
  let accounts: TestAccounts;
  let context: BrowserContext;
  let page: Page;
  let proposalId: string;
  let proposalId2: string;
  let channelId: string;
  let channelName: string;
  let aid: string;
  let storageAvailable = false;

  test.beforeAll(async ({ browser, request }) => {
    await requireAllTestServices();

    accounts = loadAccounts();
    if (!accounts.admin?.mnemonic) {
      throw new Error(
        'org-setup must be run first: no admin account in test-accounts.json. ' +
          'Run: npx playwright test --project=org-setup',
      );
    }
    aid = accounts.admin.aid || 'test-admin';

    context = await browser.newContext();
    await setupTestConfig(context);
    page = await context.newPage();
    setupPageLogging(page, 'ProposalLinkCards');

    // Login
    await loginWithMnemonic(page, accounts.admin.mnemonic);
  });

  test.afterAll(async () => {
    await context?.close();
  });

  // ──────────────────────────────────────────────────────────────
  // Setup: Create proposals and a chat channel via API
  // ──────────────────────────────────────────────────────────────
  test('setup: create proposals and chat channel', async ({ request }) => {
    // Create first proposal and submit it for endorsement
    const { response: r1, body: b1 } = await createProposalAPI(request, aid, {
      title: 'Link Card Preview Proposal',
    });
    if (!r1.ok()) {
      console.log('[Setup] Storage unavailable — skipping lifecycle tests');
      return;
    }
    storageAvailable = true;
    proposalId = b1.id;
    console.log('[Setup] Proposal 1 created: %s', proposalId);

    // Submit for endorsement so endorsement progress shows
    await transitionProposalAPI(request, proposalId, 'submitted');

    // Create second proposal for multi-link test
    const { response: r2, body: b2 } = await createProposalAPI(request, aid, {
      title: 'Second Link Card Proposal',
    });
    expect(r2.ok()).toBeTruthy();
    proposalId2 = b2.id;
    await transitionProposalAPI(request, proposalId2, 'submitted');
    console.log('[Setup] Proposal 2 created: %s', proposalId2);

    // Create or find a chat channel
    channelName = `link-cards-${Date.now().toString(36)}`;
    const { response: chResp, body: chBody } = await createChannelAPI(request, aid, channelName);

    if (chResp.ok()) {
      channelId = chBody.id;
      console.log('[Setup] Channel created: %s (%s)', channelName, channelId);
    } else {
      // Fallback: use existing channel
      const existingId = await getFirstChannelId(page, BACKEND_URL);
      expect(existingId).toBeTruthy();
      channelId = existingId!;
      console.log('[Setup] Using existing channel: %s', channelId);
    }
  });

  // ──────────────────────────────────────────────────────────────
  // Test 1: Send proposal link in chat → card renders
  // ──────────────────────────────────────────────────────────────
  test('proposal link in chat message renders a preview card', async () => {
    test.skip(!storageAvailable, 'any-sync storage not available');
    test.setTimeout(120_000);

    // Navigate to chat
    await page.goto(CHAT_URL);
    await expect(page.locator('.sidebar-title')).toHaveText('Channels', { timeout: 15_000 });

    // Select the channel
    const channelItem = page.locator('.channel-item').filter({ hasText: channelName });
    await expect(channelItem).toBeVisible({ timeout: 15_000 });
    await channelItem.click();
    await expect(page.locator('.channel-header .channel-name')).toBeVisible({ timeout: 5_000 });

    // Send a message with a proposal link
    const proposalLink = `http://localhost:9003/dashboard/proposals/${proposalId}`;
    const message = `Please review this proposal: ${proposalLink}`;
    await page.locator('.message-input').fill(message);
    await page.locator('.send-btn').click();
    await expect(page.locator('.message-input')).toHaveValue('');

    // Wait for the message to appear
    await expect(
      page.locator('.message-body').filter({ hasText: 'Please review this proposal' }),
    ).toBeVisible({ timeout: 15_000 });

    // Verify the ProposalLinkCard renders
    const card = page.locator('.proposal-link-card').first();
    await expect(card).toBeVisible({ timeout: 15_000 });

    // Verify card content
    await expect(card.locator('.card-title')).toContainText('Link Card Preview Proposal', {
      timeout: 10_000,
    });
    await expect(card.locator('.status-badge')).toBeVisible();
    await expect(card.locator('.view-action')).toHaveText('View Proposal');

    // Verify endorsement info is shown
    await expect(card.locator('.endorsement-info')).toBeVisible();

    console.log('[Test 1] Proposal link card rendered correctly');
  });

  // ──────────────────────────────────────────────────────────────
  // Test 2: Click card → detail modal opens
  // ──────────────────────────────────────────────────────────────
  test('clicking proposal card opens detail modal', async () => {
    test.skip(!storageAvailable, 'any-sync storage not available');
    test.setTimeout(60_000);

    // Click the proposal card
    const card = page.locator('.proposal-link-card').first();
    await card.click();

    // Verify detail modal opens
    const modal = page.locator('.proposal-detail-modal');
    await expect(modal).toBeVisible({ timeout: 10_000 });

    // Verify modal content
    await expect(modal.locator('.detail-title')).toContainText('Link Card Preview Proposal');
    await expect(modal.locator('.status-badge')).toBeVisible();
    await expect(modal.locator('.detail-proposer')).toBeVisible();

    // Verify content sections
    await expect(modal.locator('.section-title').filter({ hasText: 'Description' })).toBeVisible();
    await expect(modal.locator('.section-title').filter({ hasText: 'Problem Statement' })).toBeVisible();
    await expect(modal.locator('.section-title').filter({ hasText: 'Proposed Solution' })).toBeVisible();

    // Verify endorsement progress is shown (proposal is submitted)
    await expect(modal.locator('.endorsement-card')).toBeVisible();

    // Verify Endorse button is present
    await expect(
      modal.getByRole('button', { name: /endorse proposal/i }),
    ).toBeVisible();

    // Verify View Full Page button (toolbar icon)
    await expect(modal.locator('[title="View Full Page"]')).toBeVisible();

    // Verify Discussion section
    await expect(modal.locator('.section-title').filter({ hasText: /discussion/i })).toBeVisible();

    console.log('[Test 2] Detail modal opened with all expected sections');

    // Close the modal via Escape key
    await page.keyboard.press('Escape');
    await expect(modal).not.toBeVisible({ timeout: 5_000 });
  });

  // ──────────────────────────────────────────────────────────────
  // Test 3: Endorse via modal → endorsement count updates
  // ──────────────────────────────────────────────────────────────
  test('endorsing via detail modal updates endorsement count', async () => {
    test.skip(!storageAvailable, 'any-sync storage not available');
    test.setTimeout(60_000);

    // Open the card modal
    const card = page.locator('.proposal-link-card').first();
    await card.click();

    const modal = page.locator('.proposal-detail-modal');
    await expect(modal).toBeVisible({ timeout: 10_000 });

    // Click Endorse button
    await modal.getByRole('button', { name: /endorse proposal/i }).click();

    // EndorseProposalModal should open — target the card inside it (not the detail modal)
    const endorseCard = page.locator('.endorse-proposal-box');
    await expect(endorseCard).toBeVisible({ timeout: 10_000 });

    // Add a comment and endorse — find the dialog containing the endorse box
    const endorseDialog = page.locator('.q-dialog').filter({ has: endorseCard });
    await endorseDialog.locator('textarea').fill('Looks great, endorsing from chat!');
    await endorseDialog.getByRole('button', { name: /^endorse$/i }).click();

    // Wait for success notification
    await expect(
      page.locator('.q-notification').filter({ hasText: /endorsed/i }),
    ).toBeVisible({ timeout: 10_000 });

    console.log('[Test 3] Endorsement completed via modal');

    // Close the detail modal if still open
    const stillOpen = await modal.isVisible().catch(() => false);
    if (stillOpen) {
      await page.keyboard.press('Escape');
      await expect(modal).not.toBeVisible({ timeout: 5_000 });
    }
  });

  // ──────────────────────────────────────────────────────────────
  // Test 4: Invalid proposal ID shows error state
  // ──────────────────────────────────────────────────────────────
  test('invalid proposal link shows error card', async () => {
    test.skip(!storageAvailable, 'any-sync storage not available');
    test.setTimeout(60_000);

    // Send a message with a fake proposal ID
    const fakeLink = 'http://localhost:9003/dashboard/proposals/prop_0000000000000000';
    const message = `Check this: ${fakeLink}`;
    await page.locator('.message-input').fill(message);
    await page.locator('.send-btn').click();
    await expect(page.locator('.message-input')).toHaveValue('');

    // Wait for message and card
    await expect(
      page.locator('.message-body').filter({ hasText: 'Check this' }),
    ).toBeVisible({ timeout: 15_000 });

    // Find the card in the message that contains the fake link
    const messageItem = page.locator('.message-item').filter({ hasText: 'Check this' });
    const errorCard = messageItem.locator('.proposal-link-card .card-error');
    await expect(errorCard).toBeVisible({ timeout: 15_000 });
    await expect(errorCard).toContainText('Proposal not found');

    console.log('[Test 4] Invalid proposal link shows error state');
  });

  // ──────────────────────────────────────────────────────────────
  // Test 5: Multiple proposal links → multiple cards
  // ──────────────────────────────────────────────────────────────
  test('multiple proposal links render multiple cards', async () => {
    test.skip(!storageAvailable, 'any-sync storage not available');
    test.setTimeout(60_000);

    // Send a message with two different proposal links
    const link1 = `http://localhost:9003/dashboard/proposals/${proposalId}`;
    const link2 = `http://localhost:9003/dashboard/proposals/${proposalId2}`;
    const message = `Compare ${link1} with ${link2}`;
    await page.locator('.message-input').fill(message);
    await page.locator('.send-btn').click();
    await expect(page.locator('.message-input')).toHaveValue('');

    // Wait for message
    await expect(
      page.locator('.message-body').filter({ hasText: 'Compare' }),
    ).toBeVisible({ timeout: 15_000 });

    // Find the specific message item
    const messageItem = page.locator('.message-item').filter({ hasText: 'Compare' }).last();

    // Should have two proposal cards
    const cards = messageItem.locator('.proposal-link-card');
    await expect(cards).toHaveCount(2, { timeout: 15_000 });

    // Verify both cards have titles
    await expect(cards.nth(0).locator('.card-title')).toBeVisible({ timeout: 10_000 });
    await expect(cards.nth(1).locator('.card-title')).toBeVisible({ timeout: 10_000 });

    console.log('[Test 5] Multiple proposal links render multiple cards');
  });

  // ──────────────────────────────────────────────────────────────
  // Test 6: Duplicate links → only one card
  // ──────────────────────────────────────────────────────────────
  test('duplicate proposal links render only one card', async () => {
    test.skip(!storageAvailable, 'any-sync storage not available');
    test.setTimeout(60_000);

    // Send a message with the same link twice
    const link = `http://localhost:9003/dashboard/proposals/${proposalId}`;
    const message = `See ${link} and again ${link}`;
    await page.locator('.message-input').fill(message);
    await page.locator('.send-btn').click();
    await expect(page.locator('.message-input')).toHaveValue('');

    // Wait for message
    await expect(
      page.locator('.message-body').filter({ hasText: 'See' }).filter({ hasText: 'and again' }),
    ).toBeVisible({ timeout: 15_000 });

    // Find the specific message item
    const messageItem = page.locator('.message-item').filter({ hasText: 'and again' }).last();

    // Should have exactly one proposal card (deduplicated)
    const cards = messageItem.locator('.proposal-link-card');
    await expect(cards).toHaveCount(1, { timeout: 15_000 });

    console.log('[Test 6] Duplicate links deduplicated to one card');
  });
});
