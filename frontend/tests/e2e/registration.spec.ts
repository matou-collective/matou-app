import { test, expect, Page } from '@playwright/test';

/**
 * E2E Test: Registration Flow
 *
 * Prerequisites:
 * - KERIA running: cd infrastructure/keri && make up
 * - Backend running: cd backend && go run ./cmd/server
 * - Frontend running: cd frontend && npm run dev
 *
 * Run: npx playwright test tests/e2e/registration.spec.ts
 * Debug: npx playwright test tests/e2e/registration.spec.ts --debug
 */

const BACKEND_URL = 'http://localhost:8080';

test.describe('Matou Registration Flow', () => {
  test.beforeEach(async ({ page }) => {
    // Log console messages for debugging
    page.on('console', (msg) => {
      const text = msg.text();
      if (
        text.includes('[KERI') ||
        text.includes('[Registration') ||
        text.includes('[CredentialIssuance')
      ) {
        console.log(`[Browser] ${text}`);
      }
    });

    // Log failed requests
    page.on('requestfailed', (request) => {
      console.log(`[Network Failed] ${request.url()}: ${request.failure()?.errorText}`);
    });
  });

  test('services are healthy', async ({ request }) => {
    // Check backend health
    const backendHealth = await request.get(`${BACKEND_URL}/health`);
    expect(backendHealth.ok()).toBeTruthy();

    const healthData = await backendHealth.json();
    expect(healthData.status).toBe('healthy');
    console.log(`Backend org AID: ${healthData.organization}`);
  });

  test('complete registration flow', async ({ page }) => {
    // 1. Load splash screen
    await test.step('Load splash screen', async () => {
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Matou' })).toBeVisible({ timeout: 10000 });
      await expect(page.getByText('Community · Connection · Governance')).toBeVisible();
      await page.screenshot({ path: 'tests/e2e/screenshots/01-splash.png' });
    });

    // 2. Click Register button
    await test.step('Navigate to registration', async () => {
      await page.getByRole('button', { name: /register/i }).click();

      // Should show Matou info screen
      await expect(page.getByRole('heading', { name: 'Join Matou' })).toBeVisible({ timeout: 5000 });
      await page.screenshot({ path: 'tests/e2e/screenshots/02-matou-info.png' });

      // Click Continue
      await page.getByRole('button', { name: /continue/i }).click();

      // Should be on registration screen
      await expect(page.getByRole('heading', { name: 'Create Your Profile' })).toBeVisible({ timeout: 5000 });
      await page.screenshot({ path: 'tests/e2e/screenshots/03-registration.png' });
    });

    // 3. Wait for KERIA connection
    await test.step('Connect to KERIA', async () => {
      // May show "Connecting to KERIA..." first
      const connectingOrConnected = page.getByText(/connect(ing|ed) to keria/i);
      await expect(connectingOrConnected).toBeVisible({ timeout: 10000 });

      // Wait for connected status
      await expect(page.getByText('Connected to KERIA')).toBeVisible({ timeout: 30000 });
      await page.screenshot({ path: 'tests/e2e/screenshots/04-keria-connected.png' });
      console.log('KERIA connection established');
    });

    // 4. Fill profile and create AID
    await test.step('Create profile with AID', async () => {
      // Fill name
      await page.getByPlaceholder('Your preferred name').fill('E2E Test User');

      // Fill email (optional)
      await page.getByPlaceholder('your@email.com').fill('e2e@matou.test');

      await page.screenshot({ path: 'tests/e2e/screenshots/05-profile-filled.png' });

      // Click Create Profile
      await page.getByRole('button', { name: /create profile/i }).click();

      // Wait for success notification (AID creation can take time)
      console.log('Waiting for AID creation...');
      await expect(page.getByText(/profile created successfully/i)).toBeVisible({ timeout: 60000 });
      await page.screenshot({ path: 'tests/e2e/screenshots/06-profile-created.png' });
      console.log('Profile created with AID');
    });

    // 5. Pending Approval (for register path - no invite code)
    await test.step('Pending approval screen', async () => {
      // Register path goes to pending approval, not credential issuance
      await expect(page.getByText('Your application is under review')).toBeVisible({ timeout: 10000 });
      await page.screenshot({ path: 'tests/e2e/screenshots/07-pending-approval.png' });

      // Verify the approval flow info is shown
      await expect(page.getByText(/admin review/i)).toBeVisible();
      await expect(page.getByText(/1-3 days/i)).toBeVisible();
      console.log('Arrived at pending approval screen');
    });
  });

  test('invite code flow', async ({ page }) => {
    await test.step('Load splash and click invite code', async () => {
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Matou' })).toBeVisible({ timeout: 10000 });

      // Click "I have an invite code"
      await page.getByRole('button', { name: /invite code/i }).click();

      // Should be on invite code screen
      await expect(page.getByText(/enter.*invite.*code/i)).toBeVisible({ timeout: 5000 });
      await page.screenshot({ path: 'tests/e2e/screenshots/invite-01-code-screen.png' });
    });

    await test.step('Enter valid invite code', async () => {
      // Enter a valid demo code
      await page.getByPlaceholder('XXXX-XXXX-XXXX').fill('DEMO-CODE-2024');

      await page.getByRole('button', { name: /continue|verify/i }).click();

      // Should show invitation welcome with inviter name
      await expect(page.getByText(/invited by/i)).toBeVisible({ timeout: 10000 });
      await page.screenshot({ path: 'tests/e2e/screenshots/invite-02-welcome.png' });
    });
  });
});

test.describe('Registration Error Handling', () => {
  test('shows error when KERIA unavailable', async ({ page }) => {
    // This test would require stopping KERIA first
    // Skipping for now as it's destructive to the test environment
    test.skip();
  });

  test('validates required name field', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /register/i }).click();
    await page.getByRole('button', { name: /continue/i }).click();

    // Wait for registration screen and KERIA connection
    await expect(page.getByRole('heading', { name: 'Create Your Profile' })).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Connected to KERIA')).toBeVisible({ timeout: 30000 });

    // Try to submit without name - button should be disabled or show error
    const createBtn = page.getByRole('button', { name: /create profile/i });

    // Button should be disabled when name is empty
    await expect(createBtn).toBeDisabled();
  });
});
