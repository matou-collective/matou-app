import { test, expect, Page, BrowserContext } from '@playwright/test';
import { setupTestConfig } from './utils/mock-config';
import { requireAllTestServices } from './utils/keri-testnet';
import {
  FRONTEND_URL,
  TIMEOUT,
  setupPageLogging,
  loginWithMnemonic,
  loadAccounts,
  performOrgSetup,
  TestAccounts,
} from './utils/test-helpers';

/**
 * E2E: Wallet Page
 *
 * Tests wallet navigation, credential card/graph views, governance and token
 * tabs. Uses the admin user who already has a self-issued membership credential
 * from org setup — avoids the ~4 min registration overhead.
 *
 * Admin uses the default backend on port 9080 (no routing needed), matching
 * the admin pattern in registration and invitation tests.
 *
 * Self-sufficient: if org-setup hasn't been run yet, performs it automatically.
 *
 * Run: npx playwright test --project=wallet
 */

test.describe.serial('Wallet Page', () => {
  let accounts: TestAccounts;
  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser, request }) => {
    // Fail fast if required services are not running
    await requireAllTestServices();

    // Create browser context with test config isolation
    // Admin uses the default backend on port 9080 (no routing needed)
    context = await browser.newContext();
    await setupTestConfig(context);
    page = await context.newPage();
    setupPageLogging(page, 'Wallet');

    // Navigate to splash and let the app decide
    await page.goto(FRONTEND_URL);

    // Race: either redirected to /setup (no org config) or splash shows ready state
    const needsSetup = await Promise.race([
      page.waitForURL(/.*#\/setup/, { timeout: TIMEOUT.medium })
        .then(() => true),
      page.locator('button', { hasText: /register/i })
        .waitFor({ state: 'visible', timeout: TIMEOUT.medium })
        .then(() => false),
    ]);

    if (needsSetup) {
      // No org config — run full org setup through the UI
      console.log('[Wallet] No org config detected — running org setup...');
      accounts = await performOrgSetup(page, request);
      console.log('[Wallet] Org setup complete, admin is on dashboard');
    } else {
      // Org config exists — recover admin identity from saved mnemonic
      console.log('[Wallet] Org config exists — recovering admin identity...');
      accounts = loadAccounts();
      if (!accounts.admin?.mnemonic) {
        throw new Error(
          'Org configured but no admin mnemonic found in test-accounts.json.\n' +
          'Either run org-setup first or clean test state and re-run.',
        );
      }
      console.log(`[Wallet] Using admin account created at: ${accounts.createdAt}`);
      await loginWithMnemonic(page, accounts.admin.mnemonic);
      console.log('[Wallet] Admin logged in and on dashboard');
    }
  });

  test.afterAll(async () => {
    await context?.close();
  });

  // ---------------------------------------------------------------
  // Test 1: Navigate to wallet via sidebar
  // ---------------------------------------------------------------
  test('navigate to wallet via sidebar', async () => {
    const walletNavItem = page.locator('.nav-item', { hasText: 'Wallet' });
    await walletNavItem.click();

    await expect(page).toHaveURL(/#\/dashboard\/wallet/, { timeout: TIMEOUT.short });
    await expect(page.locator('.wallet-sidebar-title')).toContainText('Wallet', { timeout: TIMEOUT.short });
    await expect(walletNavItem).toHaveClass(/active/);
  });

  // ---------------------------------------------------------------
  // Test 2: Credentials tab shows card view by default
  // ---------------------------------------------------------------
  test('credentials tab shows card view', async () => {
    // Credentials tab should be active by default
    const credTab = page.locator('.wallet-nav-item', { hasText: 'Credentials' });
    await expect(credTab).toHaveClass(/active/);

    // Loading state should resolve
    await expect(page.locator('.loading-state')).not.toBeVisible({ timeout: TIMEOUT.medium });

    // Admin's self-issued membership credential should appear
    const card = page.locator('.credential-card').first();
    await expect(card).toBeVisible({ timeout: TIMEOUT.medium });

    // Card shows title, status badge, and date
    await expect(card.locator('.card-title')).toBeVisible();
    await expect(card.locator('.status-badge')).toBeVisible();
    await expect(card.locator('.card-date')).toBeVisible();
  });

  // ---------------------------------------------------------------
  // Test 3: Toggle between card and graph view
  // ---------------------------------------------------------------
  test('toggle between card and graph view', async () => {
    // Switch to graph view
    await page.locator('.toggle-btn', { hasText: 'Graph' }).click();

    const graphView = page.locator('.graph-view');
    await expect(graphView).toBeVisible({ timeout: TIMEOUT.short });

    // Center node (user avatar or "You"), issuer node, and credential edge icon
    const centerNode = page.locator('.center-node');
    await expect(centerNode).toBeVisible();
    await expect(centerNode.locator('.node-circle.you')).toBeVisible();
    await expect(page.locator('.issuer-node').first()).toBeVisible();
    await expect(page.locator('.edge-cred-icon').first()).toBeVisible();

    // Toggle back to cards
    await page.locator('.toggle-btn', { hasText: 'Cards' }).click();
    await expect(page.locator('.credential-card').first()).toBeVisible({ timeout: TIMEOUT.short });
    await expect(graphView).not.toBeVisible();
  });

  // ---------------------------------------------------------------
  // Test 4: Credential detail dialog from card view
  // ---------------------------------------------------------------
  test('credential detail dialog from cards', async () => {
    await page.locator('.credential-card').first().click();

    const overlay = page.locator('.credential-overlay');
    await expect(overlay).toBeVisible({ timeout: TIMEOUT.short });

    // Title and status
    await expect(page.locator('.cred-title')).toBeVisible();
    await expect(overlay.locator('.status-badge')).toBeVisible();

    // Technical details: SAID, Schema SAID, Issuer AID with 3 copy buttons
    const techSection = page.locator('.technical-section');
    await expect(techSection).toBeVisible();
    await expect(techSection.locator('.tech-label', { hasText: 'SAID' }).first()).toBeVisible();
    await expect(techSection.locator('.tech-label', { hasText: 'Schema SAID' })).toBeVisible();
    await expect(techSection.locator('.tech-label', { hasText: 'Issuer AID' })).toBeVisible();
    await expect(techSection.locator('.copy-btn')).toHaveCount(3);

    // Close via close button
    await overlay.locator('.close-btn').click();
    await expect(overlay).not.toBeVisible({ timeout: TIMEOUT.short });
  });

  // ---------------------------------------------------------------
  // Test 5: Credential detail dialog from graph view
  // ---------------------------------------------------------------
  test('credential detail dialog from graph', async () => {
    // Switch to graph view
    await page.locator('.toggle-btn', { hasText: 'Graph' }).click();
    await expect(page.locator('.graph-view')).toBeVisible({ timeout: TIMEOUT.short });

    // Click a credential icon on the edge to open dialog
    await page.locator('.edge-cred-icon').first().click();

    const overlay = page.locator('.credential-overlay');
    await expect(overlay).toBeVisible({ timeout: TIMEOUT.short });

    // Close via overlay click (backdrop area, top-left corner)
    await overlay.click({ position: { x: 10, y: 10 } });
    await expect(overlay).not.toBeVisible({ timeout: TIMEOUT.short });
  });

  // ---------------------------------------------------------------
  // Test 6: Show revoked toggle is visible
  // ---------------------------------------------------------------
  test('show revoked toggle is visible', async () => {
    // Ensure we're on the Credentials tab in card view
    await page.locator('.wallet-nav-item', { hasText: 'Credentials' }).click();
    await page.locator('.toggle-btn', { hasText: 'Cards' }).click();
    await expect(page.locator('.credential-card').first()).toBeVisible({ timeout: TIMEOUT.medium });

    // "Show revoked" toggle should be visible next to view toggle
    const toggle = page.locator('.revoked-toggle');
    await expect(toggle).toBeVisible({ timeout: TIMEOUT.short });
    await expect(toggle).toContainText('Show revoked');

    // Checkbox should be unchecked by default
    const checkbox = toggle.locator('input[type="checkbox"]');
    await expect(checkbox).not.toBeChecked();
  });

  // ---------------------------------------------------------------
  // Test 7: Revoke button in detail dialog for self-issued credential
  // ---------------------------------------------------------------
  test('revoke button visible for self-issued credential', async () => {
    // Admin has self-issued membership cred — find the "Issued" card
    const issuedCard = page.locator('.credential-card.card-issued').first();
    await expect(issuedCard).toBeVisible({ timeout: TIMEOUT.medium });
    await issuedCard.click();

    const overlay = page.locator('.credential-overlay');
    await expect(overlay).toBeVisible({ timeout: TIMEOUT.short });

    // Revoke section should be visible (issued + active credential)
    const revokeBtn = overlay.locator('.revoke-btn');
    await expect(revokeBtn).toBeVisible({ timeout: TIMEOUT.short });
    await expect(revokeBtn).toContainText('Revoke Credential');

    // Close without revoking
    await overlay.locator('.close-btn').click();
    await expect(overlay).not.toBeVisible({ timeout: TIMEOUT.short });
  });

  // ---------------------------------------------------------------
  // Test 8: Revoke credential confirmation flow
  // ---------------------------------------------------------------
  test('revoke credential with confirmation', async () => {
    test.setTimeout(120_000); // credential revocation can take time

    // Count credentials before revocation
    const cardsBefore = await page.locator('.credential-card').count();

    // Open an issued credential's detail dialog
    const issuedCard = page.locator('.credential-card.card-issued').first();
    await expect(issuedCard).toBeVisible({ timeout: TIMEOUT.medium });
    await issuedCard.click();

    const overlay = page.locator('.credential-overlay');
    await expect(overlay).toBeVisible({ timeout: TIMEOUT.short });

    // Click "Revoke Credential" to show confirmation
    await overlay.locator('.revoke-btn').click();

    // Warning message and confirm/cancel buttons should appear
    await expect(overlay.locator('.revoke-warning')).toBeVisible({ timeout: TIMEOUT.short });
    await expect(overlay.locator('.revoke-warning')).toContainText('permanently revoke');
    await expect(overlay.locator('.revoke-cancel-btn')).toBeVisible();
    await expect(overlay.locator('.revoke-confirm-btn')).toBeVisible();

    // Click "Confirm Revoke"
    await overlay.locator('.revoke-confirm-btn').click();

    // Dialog should close after successful revocation
    await expect(overlay).not.toBeVisible({ timeout: TIMEOUT.long });
    console.log('[Wallet] Credential revoked successfully');

    // With "Show revoked" unchecked, the revoked credential should be hidden
    // Wait for the card list to update
    await page.waitForTimeout(500);
    const cardsAfter = await page.locator('.credential-card').count();
    expect(cardsAfter).toBeLessThan(cardsBefore);
    console.log(`[Wallet] Cards before: ${cardsBefore}, after: ${cardsAfter}`);
  });

  // ---------------------------------------------------------------
  // Test 9: Toggle shows revoked credentials
  // ---------------------------------------------------------------
  test('show revoked toggle reveals revoked credentials', async () => {
    // Check "Show revoked" toggle
    const checkbox = page.locator('.revoked-toggle input[type="checkbox"]');
    await checkbox.check();
    await expect(checkbox).toBeChecked();

    // Revoked credential should now be visible with "Revoked" status badge
    const revokedCard = page.locator('.credential-card .status-badge.status-revoked');
    await expect(revokedCard.first()).toBeVisible({ timeout: TIMEOUT.short });
    console.log('[Wallet] Revoked credential visible with toggle on');

    // Open the revoked credential's detail dialog
    const card = page.locator('.credential-card').filter({
      has: page.locator('.status-badge.status-revoked'),
    }).first();
    await card.click();

    const overlay = page.locator('.credential-overlay');
    await expect(overlay).toBeVisible({ timeout: TIMEOUT.short });

    // Revoke button should NOT be visible (credential already revoked)
    await expect(overlay.locator('.revoke-btn')).not.toBeVisible();
    await expect(overlay.locator('.revoke-section')).not.toBeVisible();

    // Close
    await overlay.locator('.close-btn').click();
    await expect(overlay).not.toBeVisible({ timeout: TIMEOUT.short });

    // Uncheck the toggle — revoked credential should disappear again
    await checkbox.uncheck();
    await expect(checkbox).not.toBeChecked();
    await expect(revokedCard.first()).not.toBeVisible({ timeout: TIMEOUT.short });
    console.log('[Wallet] Revoked credential hidden again with toggle off');
  });

  // ---------------------------------------------------------------
  // Test 10: Graph view respects revoked filter
  // ---------------------------------------------------------------
  test('graph view hides nodes with only revoked credentials', async () => {
    // Ensure "Show revoked" is off
    const checkbox = page.locator('.revoked-toggle input[type="checkbox"]');
    if (await checkbox.isChecked()) await checkbox.uncheck();

    // Switch to graph view
    await page.locator('.toggle-btn', { hasText: 'Graph' }).click();
    const graphView = page.locator('.graph-view');
    await expect(graphView).toBeVisible({ timeout: TIMEOUT.short });

    // Count nodes with filter off
    const nodesFiltered = await page.locator('.issuer-node').count();

    // Enable "Show revoked"
    await checkbox.check();
    await page.waitForTimeout(300);
    const nodesAll = await page.locator('.issuer-node').count();

    // With revoked credentials shown, there should be >= as many nodes
    expect(nodesAll).toBeGreaterThanOrEqual(nodesFiltered);
    console.log(`[Wallet] Graph nodes — filtered: ${nodesFiltered}, all: ${nodesAll}`);

    // Reset: uncheck toggle, switch back to cards
    await checkbox.uncheck();
    await page.locator('.toggle-btn', { hasText: 'Cards' }).click();
  });

  // ---------------------------------------------------------------
  // Test 11: Governance tab
  // ---------------------------------------------------------------
  test('governance tab', async () => {
    await page.locator('.wallet-nav-item', { hasText: 'Governance' }).click();
    await expect(page.locator('.wallet-nav-item', { hasText: 'Governance' })).toHaveClass(/active/);

    // GOV balance card
    await expect(page.locator('.balance-card .balance-label')).toContainText(
      'Balance', { timeout: TIMEOUT.short },
    );

    // Empty state placeholders
    await expect(page.getByText('votes available')).toBeVisible({ timeout: TIMEOUT.short });
    await expect(page.getByText('No voting history yet')).toBeVisible();
    await expect(page.getByText('No proposals yet')).toBeVisible();
  });

  // ---------------------------------------------------------------
  // Test 12: Tokens tab
  // ---------------------------------------------------------------
  test('tokens tab', async () => {
    await page.locator('.wallet-nav-item', { hasText: 'Transaction' }).click();
    await expect(page.locator('.wallet-nav-item', { hasText: 'Transaction' })).toHaveClass(/active/);

    // UTIL balance card
    await expect(page.locator('.balance-card .balance-label')).toContainText(
      'Balance', { timeout: TIMEOUT.short },
    );

    // Send disabled (0 balance), Receive and QR disabled
    const sendBtn = page.locator('.action-btn.send-btn');
    await expect(sendBtn).toBeVisible({ timeout: TIMEOUT.short });
    await expect(sendBtn).toBeDisabled();
    await expect(page.locator('.action-btn.receive-btn')).toBeDisabled();
    await expect(page.locator('.action-btn.qr-btn')).toBeDisabled();

    // No transactions
    await expect(page.getByText('No transactions yet')).toBeVisible({ timeout: TIMEOUT.short });
  });

  // ---------------------------------------------------------------
  // Test 13: Direct URL navigation
  // ---------------------------------------------------------------
  test('direct URL navigation to wallet', async () => {
    await page.goto(`${FRONTEND_URL}/#/dashboard/wallet`);

    // Wallet page renders with sidebar
    await expect(page.locator('.wallet-sidebar-title')).toContainText('Wallet', { timeout: TIMEOUT.short });

    // Wallet active in main sidebar
    await expect(page.locator('.nav-item', { hasText: 'Wallet' })).toHaveClass(/active/);

    // All three wallet nav items visible
    await expect(page.locator('.wallet-nav-item', { hasText: 'Credentials' })).toBeVisible();
    await expect(page.locator('.wallet-nav-item', { hasText: 'Governance' })).toBeVisible();
    await expect(page.locator('.wallet-nav-item', { hasText: 'Transaction' })).toBeVisible();
  });
});
