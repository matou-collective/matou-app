import { test, expect } from '@playwright/test';

/**
 * E2E Test: Registration Flow
 *
 * Prerequisites:
 * - KERIA running: cd infrastructure/keri && docker compose up -d
 * - Frontend running: cd frontend && npm run dev
 *
 * Run: npx playwright test tests/e2e/registration.spec.ts
 * Debug: npx playwright test tests/e2e/registration.spec.ts --debug
 * Headed: npx playwright test tests/e2e/registration.spec.ts --headed
 */

const FRONTEND_URL = 'http://localhost:9002';
// Direct KERIA ports (CORS enabled via KERI_AGENT_CORS=1)
const KERIA_URL = 'http://localhost:3901';
const KERIA_BOOT_URL = 'http://localhost:3903';

test.describe('Matou Registration Flow', () => {
  test.beforeEach(async ({ page }) => {
    // Log ALL console messages for debugging
    page.on('console', (msg) => {
      console.log(`[Browser ${msg.type()}] ${msg.text()}`);
    });

    // Log failed requests with details
    page.on('requestfailed', (request) => {
      console.log(`[Network FAILED] ${request.method()} ${request.url()}`);
      console.log(`  Error: ${request.failure()?.errorText}`);
    });

    // Log successful requests to KERIA
    page.on('response', (response) => {
      if (response.url().includes('localhost:390')) {
        console.log(`[Network] ${response.status()} ${response.request().method()} ${response.url()}`);
      }
    });
  });

  test('KERIA is accessible from test runner', async ({ request }) => {
    // Test direct access to KERIA (outside browser, no CORS)
    console.log('Testing KERIA accessibility...');

    const response = await request.get(`${KERIA_URL}/`);
    console.log(`KERIA Admin API: ${response.status()}`);
    expect([200, 401, 404]).toContain(response.status()); // Any response means it's running

    const bootResponse = await request.get(`${KERIA_BOOT_URL}/`);
    console.log(`KERIA Boot API: ${bootResponse.status()}`);
  });

  test('complete registration flow with identity creation', async ({ page }) => {
    test.setTimeout(120000); // 2 minutes for full flow

    // 1. Load splash screen
    await test.step('Load splash screen', async () => {
      console.log('Step 1: Loading splash screen...');
      await page.goto(FRONTEND_URL);
      await expect(page.getByRole('heading', { name: 'Matou' })).toBeVisible({ timeout: 15000 });
      await page.screenshot({ path: 'tests/e2e/screenshots/01-splash.png' });
      console.log('Splash screen loaded');
    });

    // 2. Navigate to registration
    await test.step('Navigate to registration via Register button', async () => {
      console.log('Step 2: Clicking Register button...');
      await page.getByRole('button', { name: /register/i }).click();

      // Should show Matou info screen
      await expect(page.getByRole('heading', { name: 'Join Matou' })).toBeVisible({ timeout: 5000 });
      await page.screenshot({ path: 'tests/e2e/screenshots/02-matou-info.png' });
      console.log('Matou info screen visible');

      // Click Continue to go to profile form
      await page.getByRole('button', { name: /continue/i }).click();

      // Should be on profile form screen
      await expect(page.getByRole('heading', { name: 'Create Your Profile' })).toBeVisible({ timeout: 5000 });
      await page.screenshot({ path: 'tests/e2e/screenshots/03-profile-form.png' });
      console.log('Profile form screen visible');
    });

    // 3. Fill out the profile form
    await test.step('Fill profile form', async () => {
      console.log('Step 3: Filling profile form...');

      // Fill name
      await page.getByPlaceholder('Your preferred name').fill('E2E Test User');
      console.log('Name filled');

      // Fill "Why would you like to join us?" (bio)
      const bioField = page.locator('textarea').first();
      await bioField.fill('I am an E2E test user testing the registration flow.');
      console.log('Bio filled');

      // Select participation interests (click first one)
      const firstInterest = page.locator('label').filter({ hasText: 'Governance' }).first();
      if (await firstInterest.isVisible()) {
        await firstInterest.click();
        console.log('Participation interest selected');
      }

      // Agree to terms
      const termsCheckbox = page.locator('input[type="checkbox"]').last();
      await termsCheckbox.check();
      console.log('Terms agreed');

      await page.screenshot({ path: 'tests/e2e/screenshots/04-form-filled.png' });
    });

    // 4. Submit and create identity
    await test.step('Submit form and create identity', async () => {
      console.log('Step 4: Submitting form to create identity...');

      // Click Continue button
      const continueBtn = page.getByRole('button', { name: /continue/i });
      await expect(continueBtn).toBeEnabled();
      await continueBtn.click();
      console.log('Continue button clicked');

      // Should show loading overlay
      const loadingOverlay = page.locator('.loading-overlay');
      const loadingVisible = await loadingOverlay.isVisible().catch(() => false);
      if (loadingVisible) {
        console.log('Loading overlay visible');
        await page.screenshot({ path: 'tests/e2e/screenshots/05-loading.png' });

        // Wait for loading messages (use first() to avoid strict mode)
        await expect(page.getByText(/generating|connecting|creating|finalizing/i).first()).toBeVisible({ timeout: 10000 });
      }

      // Wait for either success (profile confirmation) or error
      console.log('Waiting for identity creation result...');

      try {
        // Check for success - Profile Confirmation screen with "Identity Created Successfully"
        await expect(page.getByText(/identity created successfully/i)).toBeVisible({ timeout: 60000 });
        console.log('SUCCESS: Identity created!');
        await page.screenshot({ path: 'tests/e2e/screenshots/06-identity-created.png' });

        // Verify mnemonic is displayed
        const mnemonicWords = page.locator('.word-card');
        const wordCount = await mnemonicWords.count();
        console.log(`Mnemonic words displayed: ${wordCount}`);
        expect(wordCount).toBe(12);

      } catch (successError) {
        // Check for error toast
        const errorToast = page.locator('.error-card, [class*="destructive"]').first();
        if (await errorToast.isVisible()) {
          const errorText = await errorToast.textContent();
          console.log(`ERROR: ${errorText}`);
          await page.screenshot({ path: 'tests/e2e/screenshots/06-error.png' });
        }

        // Take debug screenshot
        await page.screenshot({ path: 'tests/e2e/screenshots/06-debug-state.png' });
        throw successError;
      }
    });

    // 5. Verify profile confirmation screen and get mnemonic words
    let mnemonicWordsText: string[] = [];
    await test.step('Verify profile confirmation screen', async () => {
      console.log('Step 5: Verifying profile confirmation...');

      // Check ID card is displayed
      await expect(page.locator('.id-card')).toBeVisible();
      console.log('ID card visible');

      // Check mnemonic warning (use first() to avoid strict mode)
      await expect(page.getByText(/save your recovery phrase/i).first()).toBeVisible();
      console.log('Recovery phrase warning visible');

      // Extract the mnemonic words for verification step
      const wordCards = page.locator('.word-card');
      const wordCount = await wordCards.count();
      for (let i = 0; i < wordCount; i++) {
        const wordText = await wordCards.nth(i).locator('span.font-mono').textContent();
        if (wordText) mnemonicWordsText.push(wordText.trim());
      }
      console.log(`Extracted ${mnemonicWordsText.length} mnemonic words`);

      // Check the checkbox to confirm mnemonic saved
      const confirmCheckbox = page.locator('.confirm-box input[type="checkbox"]');
      await confirmCheckbox.check();
      console.log('Confirmed mnemonic saved');

      await page.screenshot({ path: 'tests/e2e/screenshots/07-ready-to-verify.png' });

      // Click continue to go to verification
      const continueBtn = page.getByRole('button', { name: /continue to verification/i });
      await expect(continueBtn).toBeEnabled();
      await continueBtn.click();
      console.log('Navigating to mnemonic verification...');
    });

    // 6. Complete mnemonic verification
    await test.step('Complete mnemonic verification', async () => {
      console.log('Step 6: Completing mnemonic verification...');

      // Should be on verification screen
      await expect(page.getByRole('heading', { name: /verify your recovery phrase/i })).toBeVisible({ timeout: 5000 });
      await page.screenshot({ path: 'tests/e2e/screenshots/08-verification-screen.png' });

      // Get the word indices being requested (e.g., "Word #3", "Word #7", "Word #11")
      const wordLabels = page.locator('.word-input-group label');
      const labelCount = await wordLabels.count();
      console.log(`Need to verify ${labelCount} words`);

      for (let i = 0; i < labelCount; i++) {
        const labelText = await wordLabels.nth(i).textContent();
        const match = labelText?.match(/Word #(\d+)/);
        if (match) {
          const wordIndex = parseInt(match[1], 10) - 1; // Convert to 0-based index
          const correctWord = mnemonicWordsText[wordIndex];
          console.log(`Entering word #${wordIndex + 1}: ${correctWord}`);

          const input = page.locator(`#word-${i}`);
          await input.fill(correctWord);
        }
      }

      await page.screenshot({ path: 'tests/e2e/screenshots/09-verification-filled.png' });

      // Click verify
      await page.getByRole('button', { name: /verify and continue/i }).click();
      console.log('Verification submitted');

      // Should navigate to pending approval (for register flow)
      await expect(page.getByText(/application.*review|pending/i).first()).toBeVisible({ timeout: 10000 });
      await page.screenshot({ path: 'tests/e2e/screenshots/10-pending-approval.png' });
      console.log('Arrived at pending approval screen - flow complete!');
    });
  });

  test('recover identity using mnemonic', async ({ page }) => {
    test.setTimeout(180000); // 3 minutes

    let savedMnemonic: string[] = [];
    let savedAID = '';

    // 1. First create an identity to recover
    await test.step('Create identity first', async () => {
      console.log('Step 1: Creating identity to recover later...');
      await page.goto(FRONTEND_URL);
      await expect(page.getByRole('heading', { name: 'Matou' })).toBeVisible({ timeout: 15000 });

      // Navigate through registration
      await page.getByRole('button', { name: /register/i }).click();
      await expect(page.getByRole('heading', { name: 'Join Matou' })).toBeVisible({ timeout: 5000 });
      await page.getByRole('button', { name: /continue/i }).click();
      await expect(page.getByRole('heading', { name: 'Create Your Profile' })).toBeVisible({ timeout: 5000 });

      // Fill form
      await page.getByPlaceholder('Your preferred name').fill('Recovery Test User');
      const bioField = page.locator('textarea').first();
      await bioField.fill('Testing recovery flow');
      const termsCheckbox = page.locator('input[type="checkbox"]').last();
      await termsCheckbox.check();

      // Submit and wait for identity creation
      await page.getByRole('button', { name: /continue/i }).click();
      await expect(page.getByText(/identity created successfully/i)).toBeVisible({ timeout: 60000 });
      console.log('Identity created');

      // Extract mnemonic words
      const wordCards = page.locator('.word-card');
      const wordCount = await wordCards.count();
      for (let i = 0; i < wordCount; i++) {
        const wordText = await wordCards.nth(i).locator('span.font-mono').textContent();
        if (wordText) savedMnemonic.push(wordText.trim());
      }
      console.log(`Saved mnemonic: ${savedMnemonic.length} words`);

      // Extract AID
      const aidElement = page.locator('.aid-section .font-mono');
      savedAID = (await aidElement.textContent()) || '';
      console.log(`Saved AID: ${savedAID.substring(0, 20)}...`);

      await page.screenshot({ path: 'tests/e2e/screenshots/recovery-01-created.png' });
    });

    // 2. Clear session and go back to splash
    await test.step('Clear session and return to splash', async () => {
      console.log('Step 2: Clearing session...');

      // Clear localStorage to simulate new session
      await page.evaluate(() => {
        localStorage.removeItem('matou_passcode');
      });

      // Reload to get fresh state
      await page.goto(FRONTEND_URL);
      await expect(page.getByRole('heading', { name: 'Matou' })).toBeVisible({ timeout: 15000 });
      await page.screenshot({ path: 'tests/e2e/screenshots/recovery-02-splash.png' });
      console.log('Back at splash screen');
    });

    // 3. Navigate to recovery
    await test.step('Navigate to recovery screen', async () => {
      console.log('Step 3: Clicking recover identity...');
      await page.getByText(/recover identity/i).click();

      await expect(page.getByRole('heading', { name: 'Recover Your Identity' })).toBeVisible({ timeout: 5000 });
      await page.screenshot({ path: 'tests/e2e/screenshots/recovery-03-recovery-screen.png' });
      console.log('Recovery screen visible');
    });

    // 4. Enter mnemonic
    await test.step('Enter mnemonic words', async () => {
      console.log('Step 4: Entering mnemonic words...');

      for (let i = 0; i < savedMnemonic.length; i++) {
        const input = page.locator(`#word-${i}`);
        await input.fill(savedMnemonic[i]);
      }

      await page.screenshot({ path: 'tests/e2e/screenshots/recovery-04-mnemonic-entered.png' });
      console.log('Mnemonic entered');
    });

    // 5. Submit and verify recovery
    await test.step('Recover identity', async () => {
      console.log('Step 5: Recovering identity...');

      await page.getByRole('button', { name: /recover identity/i }).click();

      // Wait for recovery success
      await expect(page.getByText(/identity recovered/i)).toBeVisible({ timeout: 60000 });
      await page.screenshot({ path: 'tests/e2e/screenshots/recovery-05-success.png' });
      console.log('Identity recovered successfully!');

      // Verify it's the same AID
      const recoveredAID = await page.locator('.success-box .font-mono').textContent();
      console.log(`Recovered AID: ${recoveredAID?.substring(0, 20)}...`);

      if (recoveredAID && savedAID) {
        expect(recoveredAID.trim()).toBe(savedAID.trim());
        console.log('AID matches - recovery verified!');
      }
    });

    // 6. Continue to dashboard
    await test.step('Continue to dashboard', async () => {
      console.log('Step 6: Continuing to dashboard...');
      await page.getByRole('button', { name: /continue to dashboard/i }).click();

      // Should navigate to dashboard
      await page.waitForURL(/\/dashboard/, { timeout: 10000 });
      console.log('Arrived at dashboard - recovery flow complete!');
      await page.screenshot({ path: 'tests/e2e/screenshots/recovery-06-dashboard.png' });
    });
  });

  test('debug CORS issue with KERIA', async ({ page }) => {
    // This test specifically debugs CORS issues
    console.log('Testing CORS access to KERIA from browser...');

    await page.goto(FRONTEND_URL);

    // Try to fetch from KERIA directly in browser context
    const corsResult = await page.evaluate(async () => {
      const urls = [
        'http://localhost:3901/',
        'http://localhost:3903/boot',
      ];

      const results = [];
      for (const url of urls) {
        try {
          const response = await fetch(url, { method: 'GET' });
          results.push({ url, status: response.status, ok: response.ok });
        } catch (error) {
          results.push({ url, error: String(error) });
        }
      }
      return results;
    });

    console.log('CORS test results:');
    for (const result of corsResult) {
      console.log(`  ${result.url}: ${result.error || `${result.status}`}`);
    }

    // If we get NetworkError, it's a CORS issue
    const hasCorsError = corsResult.some(r => r.error?.includes('NetworkError'));
    if (hasCorsError) {
      console.log('\n⚠️  CORS ERROR DETECTED!');
      console.log('KERIA needs CORS headers. Options:');
      console.log('1. Configure KERIA with CORS support');
      console.log('2. Use a reverse proxy (nginx/caddy) with CORS headers');
      console.log('3. Run frontend and KERIA on same origin');
    }
  });
});
