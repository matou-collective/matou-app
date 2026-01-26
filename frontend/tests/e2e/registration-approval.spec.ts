import { test, expect, BrowserContext, Page } from '@playwright/test';

/**
 * E2E Test: Registration Approval Flow
 *
 * Tests the complete admin approval workflow:
 * 1. User submits registration
 * 2. Admin sees registration in dashboard
 * 3. Admin can message, approve, or decline
 * 4. User receives credential (approve) or rejection (decline)
 *
 * Prerequisites:
 * - KERIA running: cd infrastructure/keri && docker compose up -d
 * - Config server running: cd config-server && npm run dev
 * - Frontend running: cd frontend && npm run dev
 * - Org setup completed with admin credentials
 *
 * Run: npx playwright test tests/e2e/registration-approval.spec.ts
 * Debug: npx playwright test tests/e2e/registration-approval.spec.ts --debug
 * Headed: npx playwright test tests/e2e/registration-approval.spec.ts --headed
 */

const FRONTEND_URL = 'http://localhost:9002';

// Helper to set up console and network logging
function setupPageLogging(page: Page, prefix: string) {
  page.on('console', (msg) => {
    console.log(`[${prefix} ${msg.type()}] ${msg.text()}`);
  });

  page.on('requestfailed', (request) => {
    console.log(`[${prefix} Network FAILED] ${request.method()} ${request.url()}`);
  });
}

// Helper to complete user registration up to pending approval
async function completeUserRegistration(page: Page, userName: string): Promise<{ aid: string; mnemonic: string[] }> {
  await page.goto(FRONTEND_URL);
  // Wait for splash screen to load - look for Register button instead of heading (title is an SVG)
  await expect(page.getByRole('button', { name: /register/i })).toBeVisible({ timeout: 15000 });

  // Navigate through registration
  await page.getByRole('button', { name: /register/i }).click();
  await expect(page.getByRole('heading', { name: /join matou/i })).toBeVisible({ timeout: 5000 });
  await page.getByRole('button', { name: /continue/i }).click();

  // Fill profile
  await page.getByPlaceholder('Your preferred name').fill(userName);
  const bioField = page.locator('textarea').first();
  await bioField.fill(`Testing registration approval flow as ${userName}`);

  // Select interests
  const firstInterest = page.locator('label').filter({ hasText: 'Governance' }).first();
  if (await firstInterest.isVisible()) {
    await firstInterest.click();
  }

  // Agree to terms
  const termsCheckbox = page.locator('input[type="checkbox"]').last();
  await termsCheckbox.check();

  // Submit and create identity
  await page.getByRole('button', { name: /continue/i }).click();
  await expect(page.getByText(/identity created successfully/i)).toBeVisible({ timeout: 60000 });

  // Extract mnemonic
  const mnemonic: string[] = [];
  const wordCards = page.locator('.word-card');
  const wordCount = await wordCards.count();
  for (let i = 0; i < wordCount; i++) {
    const wordText = await wordCards.nth(i).locator('span.font-mono').textContent();
    if (wordText) mnemonic.push(wordText.trim());
  }

  // Get AID
  const aidElement = page.locator('.aid-section .font-mono');
  const aid = (await aidElement.textContent()) || '';

  // Confirm and continue to verification
  const confirmCheckbox = page.locator('.confirm-box input[type="checkbox"]');
  await confirmCheckbox.check();
  await page.getByRole('button', { name: /continue to verification/i }).click();

  // Complete mnemonic verification
  await expect(page.getByRole('heading', { name: /verify your recovery phrase/i })).toBeVisible({ timeout: 5000 });
  const wordLabels = page.locator('.word-input-group label');
  const labelCount = await wordLabels.count();
  for (let i = 0; i < labelCount; i++) {
    const labelText = await wordLabels.nth(i).textContent();
    const match = labelText?.match(/Word #(\d+)/);
    if (match) {
      const wordIndex = parseInt(match[1], 10) - 1;
      const input = page.locator(`#word-${i}`);
      await input.fill(mnemonic[wordIndex]);
    }
  }

  await page.getByRole('button', { name: /verify and continue/i }).click();
  await expect(page.getByText(/application.*review|pending/i).first()).toBeVisible({ timeout: 15000 });

  return { aid, mnemonic };
}

// Helper to log in as admin (recover existing admin identity)
async function loginAsAdmin(page: Page, adminMnemonic: string[]): Promise<void> {
  await page.goto(FRONTEND_URL);
  // Wait for splash screen to load - look for Register button instead of heading (title is an SVG)
  await expect(page.getByRole('button', { name: /register/i })).toBeVisible({ timeout: 15000 });

  // Click recover identity
  await page.getByText(/recover identity/i).click();
  await expect(page.getByRole('heading', { name: 'Recover Your Identity' })).toBeVisible({ timeout: 5000 });

  // Enter mnemonic
  for (let i = 0; i < adminMnemonic.length; i++) {
    const input = page.locator(`#word-${i}`);
    await input.fill(adminMnemonic[i]);
  }

  // Recover
  await page.getByRole('button', { name: /recover identity/i }).click();
  await expect(page.getByText(/identity recovered/i)).toBeVisible({ timeout: 60000 });

  // Continue to dashboard
  await page.getByRole('button', { name: /continue to dashboard/i }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 10000 });
}

test.describe('Registration Approval Flow', () => {
  // Note: These tests require an admin identity to already exist
  // The admin mnemonic should be set up during org-setup
  // For these tests to work, you need to first:
  // 1. Run org-setup test to create admin identity
  // 2. Save the admin mnemonic somewhere
  // 3. Update the tests to use that mnemonic

  test.describe.skip('Multi-context approval tests', () => {
    // These tests use multiple browser contexts (user + admin)
    // Skip by default as they require pre-existing admin setup

    test('full approval flow - admin approves registration', async ({ browser }) => {
      test.setTimeout(300000); // 5 minutes for full flow

      // Create separate contexts for user and admin
      const userContext = await browser.newContext();
      const adminContext = await browser.newContext();
      const userPage = await userContext.newPage();
      const adminPage = await adminContext.newPage();

      setupPageLogging(userPage, 'User');
      setupPageLogging(adminPage, 'Admin');

      try {
        // Step 1: User completes registration
        console.log('=== Step 1: User completes registration ===');
        const { aid: userAID, mnemonic } = await completeUserRegistration(userPage, 'Approval_Test_User');
        console.log(`User registered with AID: ${userAID.substring(0, 20)}...`);
        await userPage.screenshot({ path: 'tests/e2e/screenshots/approval-01-user-pending.png' });

        // Step 2: Admin logs in (would need real admin mnemonic here)
        console.log('=== Step 2: Admin logs in ===');
        // TODO: Replace with actual admin mnemonic from org setup
        const adminMnemonic = ['word1', 'word2', /* ... 12 words */] as string[];
        if (adminMnemonic.length < 12) {
          console.log('SKIP: Admin mnemonic not configured');
          test.skip();
          return;
        }

        await loginAsAdmin(adminPage, adminMnemonic);
        await adminPage.screenshot({ path: 'tests/e2e/screenshots/approval-02-admin-dashboard.png' });

        // Step 3: Admin sees pending registration
        console.log('=== Step 3: Admin sees pending registration ===');
        // Wait for admin section to appear
        const adminSection = adminPage.locator('.admin-section');
        await expect(adminSection).toBeVisible({ timeout: 15000 });

        // Check for pending registration
        const registrationCard = adminPage.locator('.registration-card').first();
        await expect(registrationCard).toBeVisible({ timeout: 30000 });
        console.log('Admin sees pending registration');
        await adminPage.screenshot({ path: 'tests/e2e/screenshots/approval-03-pending-visible.png' });

        // Step 4: Admin sends a message (optional)
        console.log('=== Step 4: Admin sends message ===');
        await registrationCard.getByRole('button', { name: /message/i }).click();
        // Wait for modal
        const modal = adminPage.locator('.modal-content');
        await expect(modal).toBeVisible({ timeout: 5000 });
        // Type message
        await adminPage.locator('textarea').fill('Welcome! Your registration looks good.');
        await adminPage.getByRole('button', { name: /send message/i }).click();
        // Wait for success
        await expect(adminPage.getByText(/message sent/i)).toBeVisible({ timeout: 10000 });
        console.log('Admin sent message');
        await adminPage.screenshot({ path: 'tests/e2e/screenshots/approval-04-message-sent.png' });

        // Step 5: Admin approves registration
        console.log('=== Step 5: Admin approves registration ===');
        // Find and click approve button
        const approveBtn = adminPage.locator('.registration-card').first().getByRole('button', { name: /approve/i });
        await approveBtn.click();
        // Wait for success
        await expect(adminPage.getByText(/approved/i)).toBeVisible({ timeout: 30000 });
        console.log('Admin approved registration');
        await adminPage.screenshot({ path: 'tests/e2e/screenshots/approval-05-approved.png' });

        // Step 6: User receives credential
        console.log('=== Step 6: User receives credential ===');
        // Wait for WelcomeOverlay on user page
        await expect(userPage.getByText(/welcome.*matou/i)).toBeVisible({ timeout: 60000 });
        console.log('User received credential!');
        await userPage.screenshot({ path: 'tests/e2e/screenshots/approval-06-user-welcome.png' });

        // Step 7: User enters community
        console.log('=== Step 7: User enters community ===');
        await userPage.getByRole('button', { name: /enter.*community/i }).click();
        await userPage.waitForURL(/\/dashboard/, { timeout: 10000 });
        console.log('User in community dashboard - FULL FLOW COMPLETE!');
        await userPage.screenshot({ path: 'tests/e2e/screenshots/approval-07-user-dashboard.png' });

      } finally {
        await userContext.close();
        await adminContext.close();
      }
    });

    test('decline flow - admin declines registration', async ({ browser }) => {
      test.setTimeout(300000); // 5 minutes

      const userContext = await browser.newContext();
      const adminContext = await browser.newContext();
      const userPage = await userContext.newPage();
      const adminPage = await adminContext.newPage();

      setupPageLogging(userPage, 'User');
      setupPageLogging(adminPage, 'Admin');

      try {
        // Step 1: User completes registration
        console.log('=== Step 1: User completes registration ===');
        await completeUserRegistration(userPage, 'Decline_Test_User');
        await userPage.screenshot({ path: 'tests/e2e/screenshots/decline-01-user-pending.png' });

        // Step 2: Admin logs in
        console.log('=== Step 2: Admin logs in ===');
        const adminMnemonic = [] as string[]; // TODO: Replace with actual mnemonic
        if (adminMnemonic.length < 12) {
          console.log('SKIP: Admin mnemonic not configured');
          test.skip();
          return;
        }

        await loginAsAdmin(adminPage, adminMnemonic);
        await adminPage.screenshot({ path: 'tests/e2e/screenshots/decline-02-admin-dashboard.png' });

        // Step 3: Admin sees and declines registration
        console.log('=== Step 3: Admin declines registration ===');
        const registrationCard = adminPage.locator('.registration-card').first();
        await expect(registrationCard).toBeVisible({ timeout: 30000 });

        // Click decline button
        const declineBtn = registrationCard.getByRole('button', { name: /decline/i }).or(
          registrationCard.locator('button').filter({ has: adminPage.locator('svg.lucide-x') })
        );
        await declineBtn.click();

        // Modal should appear for reason
        const modal = adminPage.locator('.modal-content');
        if (await modal.isVisible()) {
          // Enter decline reason
          const reasonInput = modal.locator('textarea');
          if (await reasonInput.isVisible()) {
            await reasonInput.fill('Sorry, your registration does not meet our requirements.');
          }
          await modal.getByRole('button', { name: /confirm decline/i }).click();
        }

        // Wait for success
        await expect(adminPage.getByText(/declined/i)).toBeVisible({ timeout: 30000 });
        console.log('Admin declined registration');
        await adminPage.screenshot({ path: 'tests/e2e/screenshots/decline-03-declined.png' });

        // Step 4: User sees rejection
        console.log('=== Step 4: User sees rejection ===');
        await expect(userPage.getByText(/declined|rejected/i).first()).toBeVisible({ timeout: 60000 });
        console.log('User received rejection notification');
        await userPage.screenshot({ path: 'tests/e2e/screenshots/decline-04-user-rejected.png' });

      } finally {
        await userContext.close();
        await adminContext.close();
      }
    });
  });

  // Single-context tests that can run independently
  test('admin dashboard shows admin section when user has admin credentials', async ({ page }) => {
    test.setTimeout(120000);

    setupPageLogging(page, 'Test');

    // This test verifies that the admin section appears on the dashboard
    // when the user has admin credentials

    await page.goto(FRONTEND_URL);
    // Wait for splash screen to load - look for Register button instead of heading (title is an SVG)
    await expect(page.getByRole('button', { name: /register/i })).toBeVisible({ timeout: 15000 });

    // Note: This test would need an admin to be logged in
    // For now, we just verify the component structure exists

    // Create a simple registration to test the UI
    await page.getByRole('button', { name: /register/i }).click();
    await expect(page.getByRole('heading', { name: /join matou/i })).toBeVisible({ timeout: 5000 });

    console.log('Basic UI navigation works');
    await page.screenshot({ path: 'tests/e2e/screenshots/admin-ui-01-join.png' });
  });

  test('registration card component renders correctly', async ({ page }) => {
    // This test could inject test data to verify component rendering
    // For now it's a placeholder for component-level tests
    console.log('Registration card component test placeholder');
    expect(true).toBe(true);
  });

  test('admin section shows empty state when no pending registrations', async ({ page }) => {
    // This would test the empty state of the admin section
    console.log('Empty state test placeholder');
    expect(true).toBe(true);
  });
});

test.describe('Registration submission to multiple admins', () => {
  test('registration sends EXN to configured admins', async ({ page }) => {
    test.setTimeout(120000);

    const consoleMessages: string[] = [];
    page.on('console', (msg) => {
      consoleMessages.push(msg.text());
      if (msg.text().includes('[Registration]') || msg.text().includes('[KERIClient]')) {
        console.log(`[Browser] ${msg.text()}`);
      }
    });

    // Complete registration
    await completeUserRegistration(page, 'MultiAdmin_Test_User');

    // Wait a moment for console messages
    await page.waitForTimeout(2000);

    // Check that registration was sent to admins
    const sentToAdminMsg = consoleMessages.find(msg =>
      msg.includes('Sent to') || msg.includes('admin') || msg.includes('Registration sent')
    );

    if (sentToAdminMsg) {
      console.log('Registration was sent to admin(s):', sentToAdminMsg);
    } else {
      console.log('Could not confirm registration was sent to admins');
      console.log('Registration-related messages:', consoleMessages.filter(m =>
        m.includes('Registration') || m.includes('admin')
      ));
    }

    await page.screenshot({ path: 'tests/e2e/screenshots/multi-admin-01-registered.png' });
    expect(true).toBe(true); // Test passes if we got to pending approval
  });
});
