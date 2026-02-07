import { test, expect } from '@playwright/test';
import { keriEndpoints, requireKERINetwork, checkServiceHealth } from './utils/keri-testnet';
import { setupTestConfig, clearTestConfig } from './utils/mock-config';
import {
  FRONTEND_URL,
  BACKEND_URL,
  CONFIG_SERVER_URL,
  TIMEOUT,
  setupPageLogging,
  captureMnemonicWords,
  completeMnemonicVerification,
  saveAccounts,
  loadAccounts,
  loginWithMnemonic,
  TestAccounts,
} from './utils/test-helpers';

/**
 * E2E: Organization Setup
 *
 * Creates and persists admin + org accounts + community space.
 * Saves admin credentials to test-accounts.json for use by registration tests.
 *
 * Run: npx playwright test --project=org-setup
 */

test.describe.serial('Organization Setup', () => {
  test.beforeAll(() => {
    requireKERINetwork();
  });

  test.beforeEach(async ({ page }) => {
    setupPageLogging(page, 'OrgSetup');
  });

  // ------------------------------------------------------------------
  // Test 1: Health checks
  // ------------------------------------------------------------------
  test('all services are reachable', async () => {
    const health = await checkServiceHealth();
    console.log('Service health:', health);

    const keriServices = ['keria', 'boot', 'config', 'schema'] as const;
    const keriDown = keriServices.filter(s => !health[s]);
    if (keriDown.length > 0) {
      throw new Error(
        `KERI services not reachable: ${keriDown.join(', ')}\n` +
        'Start the KERI test infrastructure:\n' +
        '  cd infrastructure/keri && make up-test',
      );
    }

    if (!health.backend) {
      throw new Error(
        'Backend API not reachable at http://localhost:9080\n' +
        'Start the backend in test mode:\n' +
        '  cd backend && make run-test',
      );
    }
  });

  // ------------------------------------------------------------------
  // Test 2: Browser can access KERIA (CORS)
  // ------------------------------------------------------------------
  test('browser can access KERIA (CORS)', async ({ page }) => {
    test.setTimeout(TIMEOUT.medium);

    await page.goto(FRONTEND_URL);

    const corsResult = await page.evaluate(async ({ adminUrl, bootUrl }) => {
      const urls = [`${adminUrl}/`, `${bootUrl}/boot`];
      const results: Array<{ url: string; status?: number; ok?: boolean; error?: string }> = [];

      for (const url of urls) {
        try {
          const response = await fetch(url, { method: 'GET' });
          results.push({ url, status: response.status, ok: response.ok });
        } catch (error) {
          results.push({ url, error: String(error) });
        }
      }
      return results;
    }, { adminUrl: keriEndpoints.adminURL, bootUrl: keriEndpoints.bootURL });

    console.log('CORS test results:');
    for (const result of corsResult) {
      console.log(`  ${result.url}: ${result.error || `${result.status}`}`);
    }

    const hasCorsError = corsResult.some(r => r.error?.includes('NetworkError'));
    expect(hasCorsError, 'Browser should be able to reach KERIA (no CORS block)').toBe(false);
  });

  // ------------------------------------------------------------------
  // Test 3: Admin creates organization
  // ------------------------------------------------------------------
  test('admin creates organization', async ({ browser, request }) => {
    test.setTimeout(TIMEOUT.orgSetup);

    // --- Clear test config ---
    await clearTestConfig(request);

    // --- Setup browser context with test config isolation ---
    const context = await browser.newContext();
    await setupTestConfig(context);
    const page = await context.newPage();
    setupPageLogging(page, 'Admin');

    try {
      // Clear localStorage
      await page.goto(FRONTEND_URL);
      await page.evaluate(() => localStorage.clear());

      // Navigate to setup page
      await page.goto(`${FRONTEND_URL}/#/setup`);
      await page.waitForLoadState('networkidle');
      await expect(page.getByRole('heading', { name: /community setup/i })).toBeVisible({ timeout: TIMEOUT.short });

      // Fill form
      await page.locator('input').first().fill('Matou Community');
      await page.locator('input').nth(1).fill('Admin User');

      // Submit and wait for KERI operations
      await page.getByRole('button', { name: /create organization/i }).click();
      console.log('[Test] Creating admin identity...');

      await expect(page).toHaveURL(/#\/$/, { timeout: TIMEOUT.orgSetup });
      console.log('[Test] Admin identity created, redirected');

      // --- Mnemonic capture ---
      await expect(page.getByRole('heading', { name: /identity created/i })).toBeVisible({ timeout: TIMEOUT.short });
      const adminMnemonic = await captureMnemonicWords(page);
      console.log(`[Test] Captured admin mnemonic (${adminMnemonic.length} words)`);
      expect(adminMnemonic).toHaveLength(12);

      // Get admin AID from localStorage
      const adminAid = await page.evaluate(() => {
        const stored = localStorage.getItem('matou_current_aid');
        if (stored) {
          const parsed = JSON.parse(stored);
          return parsed.prefix || parsed.aid || '';
        }
        return '';
      });

      // --- Complete mnemonic verification ---
      await page.getByRole('checkbox').click();
      await page.getByRole('button', { name: /continue/i }).click();
      await completeMnemonicVerification(page, adminMnemonic);

      // Wait for dashboard, pending, or welcome overlay
      const enterCommunityBtn = page.getByRole('button', { name: /enter community/i });
      await Promise.race([
        expect(page.getByRole('heading', { name: /registration pending/i })).toBeVisible({ timeout: TIMEOUT.long }),
        expect(page).toHaveURL(/#\/dashboard/, { timeout: TIMEOUT.long }),
        expect(enterCommunityBtn).toBeVisible({ timeout: TIMEOUT.long }),
      ]);

      // Handle welcome overlay if present
      if (await enterCommunityBtn.isVisible().catch(() => false)) {
        await enterCommunityBtn.click();
        await expect(page).toHaveURL(/#\/dashboard/, { timeout: TIMEOUT.short });
      }

      console.log('[Test] Admin on dashboard');

      // --- Verify config saved to server ---
      // Use X-Test-Config header so we read the test config file, not dev config
      const configResponse = await request.get(`${CONFIG_SERVER_URL}/api/config`, {
        headers: { 'X-Test-Config': 'true' },
      });
      expect(configResponse.ok()).toBe(true);

      const config = await configResponse.json();
      expect(config.organization).toBeDefined();
      expect(config.organization.aid).toBeTruthy();
      expect(config.organization.name).toBe('Matou Community');
      expect(config.admin).toBeDefined();
      expect(config.admin.aid).toBeTruthy();
      expect(config.registry).toBeDefined();
      expect(config.registry.id).toBeTruthy();
      console.log('[Test] Config verified on server');

      // --- Save admin account for registration tests ---
      const accounts: TestAccounts = {
        note: 'Auto-generated by e2e-org-setup.spec.ts. Only admin/org is persisted.',
        admin: {
          mnemonic: adminMnemonic,
          aid: adminAid,
          name: 'Admin User',
        },
        createdAt: new Date().toISOString(),
      };
      saveAccounts(accounts);
      console.log(`[Test] Admin AID: ${adminAid}`);
    } finally {
      await context.close();
    }
  });

  // ------------------------------------------------------------------
  // Test 4: Admin backend state is correct after org setup
  // ------------------------------------------------------------------
  test('admin has identity, community space, and access', async ({ request }) => {
    test.setTimeout(TIMEOUT.long);

    // 1. Verify backend identity is configured
    const identityResponse = await request.get(`${BACKEND_URL}/api/v1/identity`);
    expect(identityResponse.ok(), 'Identity endpoint must be reachable').toBe(true);

    const identity = await identityResponse.json();
    expect(identity.configured, 'Backend identity must be configured after org setup').toBe(true);
    expect(identity.aid).toBeTruthy();
    console.log('[Test] Backend identity configured, AID:', identity.aid);

    // 2. Verify community space exists
    const communityResponse = await request.get(`${BACKEND_URL}/api/v1/spaces/community`);
    expect(communityResponse.ok(), 'Community space endpoint must be reachable').toBe(true);

    const community = await communityResponse.json();
    expect(community.spaceId, 'Community space must have a spaceId').toBeTruthy();
    console.log('[Test] Community space exists:', community.spaceId);

    // 3. Verify admin has community access via verify-access
    const verifyResponse = await request.get(
      `${BACKEND_URL}/api/v1/spaces/community/verify-access?aid=${identity.aid}`,
    );
    expect(verifyResponse.ok(), 'Verify-access endpoint must be reachable').toBe(true);

    const access = await verifyResponse.json();
    expect(access.hasAccess, 'Admin must have community access').toBe(true);
    expect(access.canRead, 'Admin must have read access').toBe(true);
    expect(access.canWrite, 'Admin must have write access').toBe(true);
    console.log('[Test] Admin has community access:', access);
  });

  // ------------------------------------------------------------------
  // Test 5: Admin can restore session and load dashboard
  // ------------------------------------------------------------------
  test('admin loads dashboard after session restore', async ({ browser }) => {
    test.setTimeout(TIMEOUT.aidCreation);

    const accounts = loadAccounts();
    expect(accounts.admin?.mnemonic, 'Admin mnemonic must be saved from test 3').toBeTruthy();

    // Fresh browser context — simulates reopening the app
    const context = await browser.newContext();
    await setupTestConfig(context);
    const page = await context.newPage();
    setupPageLogging(page, 'Dashboard');

    try {
      // Restore admin session via mnemonic recovery
      await loginWithMnemonic(page, accounts.admin!.mnemonic);
      console.log('[Test] Session restored, on dashboard');

      // Verify dashboard URL
      await expect(page).toHaveURL(/#\/dashboard/, { timeout: TIMEOUT.short });

      // Verify main welcome heading rendered
      await expect(page.locator('h1')).toContainText('Welcome back', { timeout: TIMEOUT.short });
      console.log('[Test] Dashboard heading visible');

      // Verify sidebar branding
      await expect(page.getByText('Matou Community')).toBeVisible({ timeout: TIMEOUT.short });

      // Verify stats cards rendered
      await expect(page.getByText('Pending Registrations')).toBeVisible({ timeout: TIMEOUT.short });
      await expect(page.getByText('Community Activity')).toBeVisible({ timeout: TIMEOUT.short });
      await expect(page.getByText('New Members')).toBeVisible({ timeout: TIMEOUT.short });
      console.log('[Test] Dashboard sections rendered');

      // Verify admin-specific section (Invite Member button)
      await expect(page.getByRole('button', { name: /invite member/i })).toBeVisible({ timeout: TIMEOUT.short });
      console.log('[Test] Admin section visible');
    } finally {
      await context.close();
    }
  });
});
