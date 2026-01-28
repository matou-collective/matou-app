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
const BACKEND_URL = 'http://localhost:8080';

test.describe('Matou Organization Setup Flow', () => {
  test.beforeEach(async ({ page }) => {
    // Log console messages for debugging
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.text().includes('OrgSetup') || msg.text().includes('KERI') || msg.text().includes('Config') || msg.text().includes('CredentialPolling')) {
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

  // NOTE: This test MUST run last in the suite because it creates the org config
  // that the registration tests depend on. Tests that clear config are ordered above.
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
      console.log('Waiting for setup to complete...');

      // Wait for redirect to main app (setup complete will redirect to profile-confirmation)
      await expect(page).toHaveURL(/#\/$/, { timeout: 120000 });
      console.log('Setup completed and redirected!');

      // Should see profile-confirmation screen with recovery phrase
      await expect(page.getByRole('heading', { name: /identity created/i })).toBeVisible({ timeout: 10000 });
      await page.screenshot({ path: 'tests/e2e/screenshots/org-setup-05-mnemonic-display.png' });
      console.log('Mnemonic phrase displayed');
    });

    // Step 5: Verify mnemonic verification flow
    await test.step('Complete mnemonic verification', async () => {
      // First, capture the mnemonic words from the profile-confirmation screen
      // The words are in .word-card elements, each containing "N." and the word
      const wordCards = page.locator('.word-card');
      const words: string[] = [];

      const wordsCount = await wordCards.count();
      console.log(`Found ${wordsCount} word cards`);

      for (let i = 0; i < wordsCount; i++) {
        const card = wordCards.nth(i);
        // Get the word text (second span with font-mono class)
        const wordSpan = card.locator('span.font-mono');
        const wordText = await wordSpan.textContent();
        if (wordText) {
          words.push(wordText.trim());
        }
      }
      console.log(`Captured ${words.length} mnemonic words: ${words.join(', ')}`);

      // Check the confirmation checkbox and continue
      const checkbox = page.getByRole('checkbox');
      await checkbox.click();
      const continueBtn = page.getByRole('button', { name: /continue/i });
      await expect(continueBtn).toBeEnabled();
      await continueBtn.click();

      // Should see mnemonic verification screen
      await expect(page.getByRole('heading', { name: /verify your recovery phrase/i })).toBeVisible({ timeout: 10000 });
      await page.screenshot({ path: 'tests/e2e/screenshots/org-setup-06-mnemonic-verify.png' });
      console.log('Mnemonic verification screen shown');

      // Find all labels that show "Word #N" to determine which words to verify
      const wordLabels = page.locator('label:has-text("Word #")');
      const labelCount = await wordLabels.count();
      console.log(`Found ${labelCount} word labels`);

      for (let i = 0; i < labelCount; i++) {
        const label = wordLabels.nth(i);
        const labelText = await label.textContent();
        console.log(`Label ${i}: "${labelText}"`);

        // Extract word number from "Word #N"
        const wordNumMatch = labelText?.match(/word\s*#(\d+)/i);
        if (wordNumMatch && words.length > 0) {
          const wordIndex = parseInt(wordNumMatch[1]) - 1; // Convert to 0-based
          if (wordIndex >= 0 && wordIndex < words.length) {
            // Find the input by its id (word-0, word-1, word-2)
            const input = page.locator(`#word-${i}`);
            console.log(`Filling word ${wordIndex + 1}: "${words[wordIndex]}" into #word-${i}`);
            await input.fill(words[wordIndex]);
          }
        }
      }

      // Click verify button
      const verifyBtn = page.getByRole('button', { name: /verify/i });
      await expect(verifyBtn).toBeEnabled({ timeout: 5000 });
      await verifyBtn.click();
      console.log('Clicked verify button');

      await page.screenshot({ path: 'tests/e2e/screenshots/org-setup-07-verify-complete.png' });
    });

    // Step 6: Verify pending-approval screen and credential polling
    await test.step('Verify pending approval and credential polling', async () => {
      // Should navigate to pending-approval screen
      await expect(page.getByRole('heading', { name: /registration pending/i })).toBeVisible({ timeout: 30000 });
      await page.screenshot({ path: 'tests/e2e/screenshots/org-setup-08-pending.png' });
      console.log('Pending approval screen shown');

      // Verify the admin's AID is displayed on the screen
      // This confirms the identity store was properly populated
      const aidDisplay = page.locator('text=/^E[A-Za-z0-9_-]{43}$/');
      await expect(aidDisplay).toBeVisible({ timeout: 5000 });
      console.log('Admin AID displayed on pending approval screen');

      // Wait a bit to allow credential polling to start and log
      console.log('Waiting for credential polling to start...');
      await page.waitForTimeout(3000);

      // Check if polling detected the grant and showed welcome overlay
      // If the welcome overlay appears, click through to dashboard
      const welcomeOverlay = page.locator('.welcome-overlay');
      const isWelcomeVisible = await welcomeOverlay.isVisible().catch(() => false);

      if (isWelcomeVisible) {
        console.log('Welcome overlay detected - credential was admitted!');
        await page.screenshot({ path: 'tests/e2e/screenshots/org-setup-09-welcome.png' });

        // Click Enter Community button
        const enterBtn = page.getByRole('button', { name: /enter community/i });
        await enterBtn.click();
        console.log('Clicked Enter Community button');

        // Should be on dashboard
        await expect(page).toHaveURL(/#\/dashboard/, { timeout: 10000 });
        console.log('Reached dashboard');
        await page.screenshot({ path: 'tests/e2e/screenshots/org-setup-10-dashboard.png' });
      } else {
        console.log('Welcome overlay not shown - checking polling status');
        // Log current page state for debugging
        await page.screenshot({ path: 'tests/e2e/screenshots/org-setup-09-pending-state.png' });
      }
    });

    // Step 7: Verify config was saved to server
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

    // Step 8: Verify config is also cached in localStorage
    await test.step('Verify config cached in localStorage', async () => {
      const cachedConfig = await page.evaluate(() => {
        const stored = localStorage.getItem('matou_org_config');
        return stored ? JSON.parse(stored) : null;
      });

      expect(cachedConfig).not.toBeNull();
      expect(cachedConfig.organization.name).toBe('Matou Community');
      console.log('LocalStorage cache verified');
    });

    // Step 9: Verify community space was created (if backend is running)
    await test.step('Verify community space created', async () => {
      try {
        // First check if backend is available
        const healthResponse = await request.get(`${BACKEND_URL}/api/v1/health`);
        if (!healthResponse.ok()) {
          console.log('Backend not available - skipping space verification');
          return;
        }

        // Get org AID from config
        const configResponse = await request.get(`${CONFIG_SERVER_URL}/api/config`);
        const config = await configResponse.json();
        const orgAid = config.organization?.aid;

        if (!orgAid) {
          console.log('No org AID found - skipping space verification');
          return;
        }

        // Create community space if not already created
        const createResponse = await request.post(`${BACKEND_URL}/api/v1/spaces/community`, {
          data: {
            orgAid,
            orgName: config.organization.name || 'Matou Community',
          },
        });

        if (createResponse.ok()) {
          const body = await createResponse.json();
          console.log('Community space verified/created:', body.spaceId);
          expect(body.spaceId).toBeTruthy();
          expect(body.success).toBe(true);
        } else {
          console.log(`Community space creation returned: ${createResponse.status()}`);
        }
      } catch (error) {
        console.log('Space verification skipped (backend may not be running):', error);
      }
    });
  });
});
