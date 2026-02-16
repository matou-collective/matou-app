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
 * tabs, and receive dialog. Uses the admin user who already has a self-issued
 * membership credential from org setup — avoids the ~4 min registration overhead.
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
    await expect(page.locator('.header-title')).toContainText('Wallet', { timeout: TIMEOUT.short });
    await expect(walletNavItem).toHaveClass(/active/);
  });

  // ---------------------------------------------------------------
  // Test 2: Credentials tab shows card view by default
  // ---------------------------------------------------------------
  test('credentials tab shows card view', async () => {
    // Credentials tab should be active by default
    const credTab = page.locator('.tab-btn', { hasText: 'Credentials' });
    await expect(credTab).toHaveClass(/active/);

    // Loading state should resolve
    await expect(page.locator('.loading-state')).not.toBeVisible({ timeout: TIMEOUT.medium });

    // Admin's self-issued membership credential should appear
    const card = page.locator('.credential-card').first();
    await expect(card).toBeVisible({ timeout: TIMEOUT.medium });

    // Card shows role, status badge, and date
    await expect(card.locator('.card-role')).toBeVisible();
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

    // Center node "You" and at least one issuer node
    const centerNode = page.locator('.center-node');
    await expect(centerNode).toBeVisible();
    await expect(centerNode.locator('.node-circle.you')).toContainText('You');
    await expect(page.locator('.issuer-node').first()).toBeVisible();

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

    // Click an issuer node to open dialog
    await page.locator('.issuer-node').first().click();

    const overlay = page.locator('.credential-overlay');
    await expect(overlay).toBeVisible({ timeout: TIMEOUT.short });

    // Close via overlay click (backdrop area, top-left corner)
    await overlay.click({ position: { x: 10, y: 10 } });
    await expect(overlay).not.toBeVisible({ timeout: TIMEOUT.short });
  });

  // ---------------------------------------------------------------
  // Test 6: Governance tab empty states
  // ---------------------------------------------------------------
  test('governance tab empty states', async () => {
    await page.locator('.tab-btn', { hasText: 'Governance' }).click();
    await expect(page.locator('.tab-btn', { hasText: 'Governance' })).toHaveClass(/active/);

    // GOV balance card
    await expect(page.locator('.balance-card .balance-label')).toContainText(
      'Governance Balance', { timeout: TIMEOUT.short },
    );

    // Empty state placeholders
    await expect(page.getByText('No vesting schedule')).toBeVisible({ timeout: TIMEOUT.short });
    await expect(page.getByText('votes available')).toBeVisible();
    await expect(page.getByText('No voting history yet')).toBeVisible();
    await expect(page.getByText('No achievements yet')).toBeVisible();
  });

  // ---------------------------------------------------------------
  // Test 7: Tokens tab empty states
  // ---------------------------------------------------------------
  test('tokens tab empty states', async () => {
    await page.locator('.tab-btn', { hasText: 'Tokens' }).click();
    await expect(page.locator('.tab-btn', { hasText: 'Tokens' })).toHaveClass(/active/);

    // UTIL balance card
    await expect(page.locator('.balance-card .balance-label')).toContainText(
      'Utility Balance', { timeout: TIMEOUT.short },
    );

    // Send disabled (0 balance), Receive and QR visible
    const sendBtn = page.locator('.action-btn.send-btn');
    await expect(sendBtn).toBeVisible({ timeout: TIMEOUT.short });
    await expect(sendBtn).toBeDisabled();
    await expect(page.locator('.action-btn.receive-btn')).toBeVisible();
    await expect(page.locator('.action-btn.qr-btn')).toBeVisible();

    // No transactions
    await expect(page.getByText('No transactions yet')).toBeVisible({ timeout: TIMEOUT.short });
  });

  // ---------------------------------------------------------------
  // Test 8: Receive dialog shows AID
  // ---------------------------------------------------------------
  test('receive dialog shows AID', async () => {
    await page.locator('.action-btn.receive-btn').click();

    const dialog = page.locator('.dialog-overlay');
    await expect(dialog).toBeVisible({ timeout: TIMEOUT.short });

    // AID box should contain a real AID (not the "—" fallback)
    const aidText = page.locator('.aid-text');
    await expect(aidText).toBeVisible();
    const aidValue = await aidText.textContent();
    expect(aidValue).toBeTruthy();
    expect(aidValue).not.toBe('—');

    // Copy button visible
    await expect(page.locator('.aid-box .copy-btn')).toBeVisible();

    // Close dialog
    await dialog.locator('.close-btn').click();
    await expect(dialog).not.toBeVisible({ timeout: TIMEOUT.short });
  });

  // ---------------------------------------------------------------
  // Test 9: Back button to dashboard
  // ---------------------------------------------------------------
  test('back button navigates to dashboard', async () => {
    await page.locator('.back-btn').click();

    await expect(page).toHaveURL(/#\/dashboard$/, { timeout: TIMEOUT.short });

    // Home should be the active sidebar item
    await expect(page.locator('.nav-item', { hasText: 'Home' })).toHaveClass(/active/);
  });

  // ---------------------------------------------------------------
  // Test 10: Direct URL navigation
  // ---------------------------------------------------------------
  test('direct URL navigation to wallet', async () => {
    await page.goto(`${FRONTEND_URL}/#/dashboard/wallet`);

    await expect(page.locator('.header-title')).toContainText('Wallet', { timeout: TIMEOUT.short });

    // Credentials tab active by default
    await expect(page.locator('.tab-btn', { hasText: 'Credentials' })).toHaveClass(/active/);

    // Wallet active in sidebar
    await expect(page.locator('.nav-item', { hasText: 'Wallet' })).toHaveClass(/active/);
  });
});
