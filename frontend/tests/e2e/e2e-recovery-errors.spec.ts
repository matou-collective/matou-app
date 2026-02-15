import { test, expect } from '@playwright/test';
import { requireKERINetwork } from './utils/keri-testnet';
import {
  FRONTEND_URL,
  TIMEOUT,
  setupPageLogging,
  captureMnemonicWords,
  completeMnemonicVerification,
  navigateToProfileForm,
  fillProfileForm,
} from './utils/test-helpers';

/**
 * E2E: Recovery Flows & Error Handling
 *
 * Independent tests - no dependency on org-setup or registration.
 *
 * Run: npx playwright test --project=recovery-errors
 */

test.describe('Recovery & Error Handling', () => {
  test.beforeAll(() => {
    requireKERINetwork();
  });

  test.beforeEach(async ({ page }) => {
    setupPageLogging(page, 'Recovery');
  });

  // ------------------------------------------------------------------
  // Test 1: Recover identity from mnemonic
  // ------------------------------------------------------------------
  test('recover identity from mnemonic', async ({ page }) => {
    test.setTimeout(TIMEOUT.aidCreation + 60_000); // AID creation + recovery time

    let savedMnemonic: string[] = [];
    let savedAID = '';

    // Create an identity to recover
    await test.step('Create identity', async () => {
      await page.goto(FRONTEND_URL);
      await navigateToProfileForm(page);
      await fillProfileForm(page, 'Recovery_Test_User', 'Testing recovery flow');

      await page.getByRole('button', { name: /continue/i }).click();
      await expect(
        page.getByText(/identity created successfully/i),
      ).toBeVisible({ timeout: TIMEOUT.aidCreation });

      savedMnemonic = await captureMnemonicWords(page);
      expect(savedMnemonic).toHaveLength(12);

      // Extract AID
      const aidElement = page.locator('.aid-section .font-mono');
      savedAID = (await aidElement.textContent()) || '';
      console.log(`Created AID: ${savedAID.substring(0, 20)}...`);
    });

    // Clear session
    await test.step('Clear session', async () => {
      await page.evaluate(() => localStorage.removeItem('matou_passcode'));
      await page.goto(FRONTEND_URL);
      await expect(page.getByRole('img', { name: 'Matou', exact: true })).toBeVisible({ timeout: TIMEOUT.short });
    });

    // Recover via mnemonic
    await test.step('Recover identity', async () => {
      await page.getByText(/recover identity/i).click();
      await expect(
        page.getByRole('heading', { name: /enter your 12-word recovery phrase/i }),
      ).toBeVisible({ timeout: TIMEOUT.short });

      for (let i = 0; i < savedMnemonic.length; i++) {
        await page.locator(`#word-${i}`).fill(savedMnemonic[i]);
      }

      await page.getByRole('button', { name: /recover identity/i }).click();
      await expect(
        page.getByText(/identity recovered/i),
      ).toBeVisible({ timeout: TIMEOUT.long });
    });

    // Verify same AID
    await test.step('Verify recovered AID matches', async () => {
      const recoveredAID = await page.locator('.success-box .font-mono').textContent();
      if (recoveredAID && savedAID) {
        expect(recoveredAID.trim()).toBe(savedAID.trim());
        console.log('AID matches - recovery verified');
      }

      await page.getByRole('button', { name: /continue to dashboard/i }).click();

      // Welcome overlay verifies recovery steps (community checks will fail without org setup)
      await expect(
        page.getByRole('heading', { name: /welcome to matou/i }),
      ).toBeVisible({ timeout: TIMEOUT.short });
      await expect(page.getByText(/identity recovered/i).first()).toBeVisible();
      console.log('Welcome overlay confirmed identity recovery');
    });
  });

  // ------------------------------------------------------------------
  // Test 2: Auto-restore on app reload
  // ------------------------------------------------------------------
  test('auto-restore on app reload', async ({ page }) => {
    test.setTimeout(TIMEOUT.aidCreation + 60_000);

    // Create identity and complete mnemonic verification
    await test.step('Create identity and verify mnemonic', async () => {
      await page.goto(FRONTEND_URL);
      await navigateToProfileForm(page);
      await fillProfileForm(page, 'AutoRestore_Test_User', 'Testing auto-restore');

      await page.getByRole('button', { name: /continue/i }).click();
      await expect(
        page.getByText(/identity created successfully/i),
      ).toBeVisible({ timeout: TIMEOUT.aidCreation });

      const passcode = await page.evaluate(() => localStorage.getItem('matou_passcode') || '');
      expect(passcode).toBeTruthy();

      const mnemonic = await captureMnemonicWords(page);
      await page.locator('.confirm-box input[type="checkbox"]').check();
      await page.getByRole('button', { name: /continue to verification/i }).click();
      await completeMnemonicVerification(page, mnemonic, /verify and continue/i);

      await expect(
        page.getByText(/application.*review|pending/i).first(),
      ).toBeVisible({ timeout: TIMEOUT.short });
      console.log('Reached pending-approval screen');
    });

    // Reload and verify auto-restore
    await test.step('Reload and verify auto-restore', async () => {
      await page.goto(FRONTEND_URL);

      // Should auto-navigate to pending-approval (not splash)
      await expect(
        page.getByText(/application.*review|pending/i).first(),
      ).toBeVisible({ timeout: TIMEOUT.long });
      console.log('Auto-restored to pending-approval screen');

      // Should NOT see splash buttons
      await expect(
        page.getByRole('button', { name: /i have an invite code/i }),
      ).not.toBeVisible();
    });
  });

  // ------------------------------------------------------------------
  // Test 3: Fresh user sees splash immediately
  // ------------------------------------------------------------------
  test('fresh user sees splash immediately', async ({ page }) => {
    test.setTimeout(TIMEOUT.long);

    // Clear any existing passcode
    await page.goto(FRONTEND_URL);
    await page.evaluate(() => localStorage.removeItem('matou_passcode'));

    // Reload
    await page.goto(FRONTEND_URL);
    await expect(page.getByRole('img', { name: 'Matou', exact: true })).toBeVisible({ timeout: TIMEOUT.short });

    // Buttons should be visible immediately
    await expect(
      page.getByRole('button', { name: /i have an invite code/i }),
    ).toBeVisible({ timeout: 3000 });
    await expect(page.getByRole('button', { name: /register/i })).toBeVisible();
    await expect(page.getByText(/recover identity/i)).toBeVisible();
    console.log('Fresh user sees splash with buttons');
  });

  // ------------------------------------------------------------------
  // Test 4: Error state when KERIA unavailable
  // ------------------------------------------------------------------
  test('error state when KERIA unavailable', async ({ page }) => {
    test.setTimeout(TIMEOUT.long + TIMEOUT.medium);

    // Set a passcode that will fail to connect
    await page.goto(FRONTEND_URL);
    await page.evaluate(() => {
      localStorage.setItem('matou_passcode', 'test_passcode_that_will_fail');
    });

    // Block KERIA admin (4901), CESR (4902), and boot (4903) — NOT config server (4904)
    const keriaBlocker = (route: any) => route.abort('connectionrefused');
    await page.route('**/localhost:4901/**', keriaBlocker);
    await page.route('**/localhost:4902/**', keriaBlocker);
    await page.route('**/localhost:4903/**', keriaBlocker);

    // Reload and verify error state
    await page.goto(FRONTEND_URL);
    await expect(page.getByText(/connection error/i)).toBeVisible({ timeout: TIMEOUT.long });
    console.log('Error state visible');

    await expect(page.getByRole('button', { name: /try again/i })).toBeVisible();
    console.log('Retry button visible');

    // Splash buttons should NOT be visible
    await expect(page.getByRole('button', { name: /register/i })).not.toBeVisible();

    // Unblock and clean up
    await page.unroute('**/localhost:4901/**');
    await page.unroute('**/localhost:4902/**');
    await page.unroute('**/localhost:4903/**');
  });

  // ------------------------------------------------------------------
  // Test 5: Invalid passcode handling
  // ------------------------------------------------------------------
  test('invalid passcode handling', async ({ page }) => {
    test.setTimeout(TIMEOUT.long);

    await page.goto(FRONTEND_URL);
    await page.evaluate(() => {
      localStorage.setItem('matou_passcode', 'definitely_invalid_passcode_12345');
    });

    await page.goto(FRONTEND_URL);

    // App will try to connect with the invalid passcode (any passcode creates valid keys).
    // Eventually it connects, finds no AIDs, and shows splash — or shows an error.
    // Wait for either state with a proper timeout.
    await Promise.race([
      expect(page.getByRole('button', { name: /register/i })).toBeVisible({ timeout: TIMEOUT.long }),
      expect(page.getByText(/connection error|failed/i)).toBeVisible({ timeout: TIMEOUT.long }),
    ]);

    const buttonsVisible = await page.getByRole('button', { name: /register/i }).isVisible().catch(() => false);
    const errorVisible = await page.getByText(/connection error|failed/i).isVisible().catch(() => false);

    console.log(`After invalid passcode: buttons=${buttonsVisible}, error=${errorVisible}`);
    expect(buttonsVisible || errorVisible).toBe(true);
  });
});
