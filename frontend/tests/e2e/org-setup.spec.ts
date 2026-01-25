import { test, expect } from '@playwright/test';

/**
 * E2E Test: Organization Setup Flow
 *
 * Prerequisites:
 * - KERI infrastructure running: cd infrastructure/keri && make up
 *   (This starts KERIA, witnesses, and the config server)
 * - Frontend running: cd frontend && npm run dev
 *
 * Run: npx playwright test tests/e2e/org-setup.spec.ts
 * Debug: npx playwright test tests/e2e/org-setup.spec.ts --debug
 * Headed: npx playwright test tests/e2e/org-setup.spec.ts --headed
 */

const FRONTEND_URL = 'http://localhost:9002';
const CONFIG_SERVER_URL = 'http://localhost:3904';

test.describe('Matou Organization Setup Flow', () => {
  test.beforeEach(async ({ page }) => {
    // Log console messages for debugging
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.text().includes('OrgSetup') || msg.text().includes('KERI') || msg.text().includes('Config')) {
        console.log(`[Browser ${msg.type()}] ${msg.text()}`);
      }
    });

    // Log failed requests
    page.on('requestfailed', (request) => {
      console.log(`[Network FAILED] ${request.method()} ${request.url()}`);
      console.log(`  Error: ${request.failure()?.errorText}`);
    });
  });

  test('config server is running', async ({ request }) => {
    const response = await request.get(`${CONFIG_SERVER_URL}/api/health`);
    expect(response.ok()).toBe(true);

    const body = await response.json();
    console.log('Config server health:', body);
    expect(body.status).toBe('ok');
  });

  test('redirects to /setup when no org config exists', async ({ page, request }) => {
    test.setTimeout(30000);

    // Step 1: Clear any existing config on server
    await test.step('Clear server config', async () => {
      try {
        await request.delete(`${CONFIG_SERVER_URL}/api/config`);
        console.log('Cleared server config');
      } catch {
        console.log('No config to clear');
      }
    });

    // Step 2: Clear localStorage and navigate
    await test.step('Clear localStorage and navigate', async () => {
      await page.goto(FRONTEND_URL);

      // Clear cached config
      await page.evaluate(() => {
        localStorage.removeItem('matou_org_config');
        localStorage.removeItem('matou_passcode');
      });

      // Reload to trigger boot logic
      await page.reload();
      await page.waitForLoadState('networkidle');

      // Should redirect to /setup (hash mode: /#/setup)
      await expect(page).toHaveURL(/#\/setup/, { timeout: 10000 });
      console.log('Redirected to /setup');
      await page.screenshot({ path: 'tests/e2e/screenshots/org-setup-01-redirect.png' });
    });
  });

  test('complete org setup flow', async ({ page, request }) => {
    test.setTimeout(180000); // 3 minutes for full KERI operations

    // Step 1: Ensure clean state - delete config on server
    await test.step('Ensure clean state', async () => {
      try {
        await request.delete(`${CONFIG_SERVER_URL}/api/config`);
        console.log('Cleared existing config');
      } catch {
        console.log('No existing config');
      }

      await page.goto(FRONTEND_URL);
      // Clear localStorage
      await page.evaluate(() => {
        localStorage.removeItem('matou_org_config');
        localStorage.removeItem('matou_passcode');
      });
    });

    // Step 2: Navigate to setup page
    await test.step('Load setup page', async () => {
      await page.goto(`${FRONTEND_URL}/#/setup`);
      await page.waitForLoadState('networkidle');

      // Verify we're on the setup screen
      await expect(page.getByRole('heading', { name: /community setup/i })).toBeVisible({ timeout: 10000 });
      await expect(page.getByText(/no organization found/i)).toBeVisible();
      await page.screenshot({ path: 'tests/e2e/screenshots/org-setup-02-setup-screen.png' });
      console.log('Setup screen loaded');
    });

    // Step 3: Fill form
    await test.step('Fill org setup form', async () => {
      // Fill organization name
      const orgNameInput = page.locator('input').first();
      await orgNameInput.fill('Matou Community');
      console.log('Filled org name');

      // Fill admin name
      const adminNameInput = page.locator('input').nth(1);
      await adminNameInput.fill('Admin User');
      console.log('Filled admin name');

      await page.screenshot({ path: 'tests/e2e/screenshots/org-setup-03-form-filled.png' });
    });

    // Step 4: Submit and wait for setup
    await test.step('Submit form and create org', async () => {
      // Click Create Organization button
      const submitBtn = page.getByRole('button', { name: /create organization/i });
      await expect(submitBtn).toBeEnabled();
      await submitBtn.click();
      console.log('Submitted form');

      // Wait for loading state
      await expect(page.getByText(/setting up your organization/i)).toBeVisible({ timeout: 5000 });
      await page.screenshot({ path: 'tests/e2e/screenshots/org-setup-04-loading.png' });

      // Wait for progress steps
      console.log('Waiting for KERI operations...');

      // This may take a while - wait for completion
      // The UI shows "Setup complete!" briefly then redirects to splash
      // Wait for either completion text or redirect to splash
      console.log('Waiting for setup to complete...');

      // Wait for redirect to main app (setup complete will redirect)
      await expect(page).toHaveURL(/#\/$/, { timeout: 120000 });
      console.log('Setup completed and redirected!');

      // Should see splash screen
      await expect(page.getByRole('heading', { name: 'Matou' })).toBeVisible({ timeout: 10000 });
      await page.screenshot({ path: 'tests/e2e/screenshots/org-setup-05-complete.png' });
    });

    // Step 6: Verify config was saved to server
    await test.step('Verify config saved to server', async () => {
      const response = await request.get(`${CONFIG_SERVER_URL}/api/config`);
      expect(response.ok()).toBe(true);

      const config = await response.json();
      console.log('Config from server:', JSON.stringify(config, null, 2));

      // Verify config structure
      expect(config.organization).toBeDefined();
      expect(config.organization.aid).toBeTruthy();
      expect(config.organization.name).toBe('Matou Community');
      expect(config.organization.oobi).toBeTruthy();

      expect(config.admin).toBeDefined();
      expect(config.admin.aid).toBeTruthy();
      expect(config.admin.name).toBe('Admin User');

      expect(config.registry).toBeDefined();
      expect(config.registry.id).toBeTruthy();

      console.log('Config verified successfully');
      console.log(`Org AID: ${config.organization.aid}`);
      console.log(`Admin AID: ${config.admin.aid}`);
    });

    // Step 7: Verify config is also cached in localStorage
    await test.step('Verify config cached in localStorage', async () => {
      const cachedConfig = await page.evaluate(() => {
        const stored = localStorage.getItem('matou_org_config');
        return stored ? JSON.parse(stored) : null;
      });

      expect(cachedConfig).not.toBeNull();
      expect(cachedConfig.organization.name).toBe('Matou Community');
      console.log('LocalStorage cache verified');
    });
  });

  test('handles config appropriately after localStorage clear', async ({ page }) => {
    test.setTimeout(30000);

    // This test verifies the app works correctly when localStorage is cleared
    // The config server may or may not have config depending on previous test state

    await test.step('Clear localStorage cache', async () => {
      await page.goto(FRONTEND_URL);
      await page.evaluate(() => {
        localStorage.removeItem('matou_org_config');
        localStorage.removeItem('matou_passcode');
        localStorage.removeItem('matou_admin_aid');
        localStorage.removeItem('matou_org_aid');
      });
    });

    // If server is running and not configured, we should see setup page
    // If server is running and configured, we should see splash
    await test.step('Verify app handles config appropriately', async () => {
      await page.reload();
      await page.waitForLoadState('networkidle');

      // Wait for either setup or splash to be visible with longer timeout
      try {
        await Promise.race([
          page.getByRole('heading', { name: /community setup/i }).waitFor({ timeout: 10000 }),
          page.getByRole('heading', { name: 'Matou' }).waitFor({ timeout: 10000 }),
        ]);
      } catch {
        // Take screenshot for debugging if neither appears
        await page.screenshot({ path: 'tests/e2e/screenshots/org-setup-debug-config-handling.png' });
      }

      // Check which one is visible
      const isOnSetup = await page.getByRole('heading', { name: /community setup/i }).isVisible().catch(() => false);
      const isOnSplash = await page.getByRole('heading', { name: 'Matou' }).isVisible().catch(() => false);

      expect(isOnSetup || isOnSplash).toBe(true);
      console.log(`App loaded: ${isOnSetup ? 'setup page' : 'splash page'}`);
    });
  });

  test('form validation works correctly', async ({ page, request }) => {
    test.setTimeout(60000);

    // Ensure we're on setup page
    await test.step('Navigate to setup', async () => {
      try {
        await request.delete(`${CONFIG_SERVER_URL}/api/config`);
      } catch { /* ignore */ }

      await page.goto(`${FRONTEND_URL}/#/setup`);
      await page.evaluate(() => localStorage.clear());
      await page.reload();

      await expect(page.getByRole('heading', { name: /community setup/i })).toBeVisible({ timeout: 10000 });
    });

    await test.step('Verify form validation', async () => {
      const submitBtn = page.getByRole('button', { name: /create organization/i });

      // Button should be disabled when form is empty
      await expect(submitBtn).toBeDisabled();

      // Fill just one field with short value
      const orgNameInput = page.locator('input').first();
      await orgNameInput.fill('T');

      // Button should still be disabled
      await expect(submitBtn).toBeDisabled();

      // Fill both fields with valid values
      await orgNameInput.fill('Test Org');
      const adminNameInput = page.locator('input').nth(1);
      await adminNameInput.fill('Admin');

      // Button should now be enabled
      await expect(submitBtn).toBeEnabled();
    });
  });
});
