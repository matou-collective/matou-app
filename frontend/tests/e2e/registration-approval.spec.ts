import { test, expect, Page, BrowserContext } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { setupTestConfig, hasTestConfig } from './utils/mock-config';

/**
 * E2E Test: Registration Approval Flow
 *
 * Tests admin approval/decline/message workflows.
 * - Admin session is persisted across all tests
 * - Each test creates a fresh user registration
 * - Uses test config isolation (X-Test-Config header) to preserve dev config
 *
 * PREREQUISITE: Run setup first!
 *   npx playwright test tests/e2e/setup-test-accounts.spec.ts --project=chromium
 *
 * Then run these tests:
 *   npx playwright test tests/e2e/registration-approval.spec.ts --project=chromium
 */

const FRONTEND_URL = 'http://localhost:9002';
const ACCOUNTS_FILE = path.join(__dirname, 'test-accounts.json');

// Timeouts for individual operations
const TIMEOUT = {
  short: 10000,    // 10s - quick UI operations
  medium: 20000,   // 20s - simple KERI operations, polling
  long: 30000,     // 30s - credential delivery
  aidCreation: 180000, // 3 min - witness-backed AID creation (matches client timeout)
};

interface TestAccounts {
  admin: {
    mnemonic: string[];
    aid: string;
    name: string;
  } | null;
  createdAt: string | null;
}

function loadAccounts(): TestAccounts {
  const data = fs.readFileSync(ACCOUNTS_FILE, 'utf-8');
  return JSON.parse(data);
}

// Generate a unique suffix for test usernames to avoid stale registration conflicts
function uniqueSuffix(): string {
  return Date.now().toString(36).slice(-6);
}

function setupPageLogging(page: Page, prefix: string) {
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('Registration') || text.includes('Admin') ||
        text.includes('Credential') || text.includes('IPEX') ||
        text.includes('KERIClient') || text.includes('Polling') ||
        text.includes('Error') || msg.type() === 'error') {
      console.log(`[${prefix}] ${text}`);
    }
  });
}

async function loginAdminWithMnemonic(page: Page, mnemonic: string[]): Promise<void> {
  await page.goto(FRONTEND_URL);
  await expect(page.getByRole('button', { name: /register/i })).toBeVisible({ timeout: TIMEOUT.short });

  await page.getByText(/recover identity/i).click();
  await expect(page.getByRole('heading', { name: /recover your identity/i })).toBeVisible({ timeout: TIMEOUT.short });

  for (let i = 0; i < mnemonic.length; i++) {
    await page.locator(`#word-${i}`).fill(mnemonic[i]);
  }

  await page.getByRole('button', { name: /recover identity/i }).click();
  await expect(page.getByText(/identity recovered/i)).toBeVisible({ timeout: TIMEOUT.long });

  await page.getByRole('button', { name: /continue to dashboard/i }).click();
  await expect(page).toHaveURL(/#\/dashboard/, { timeout: TIMEOUT.short });
}

async function createUserAndRegister(page: Page, userName: string): Promise<void> {
  await page.goto(FRONTEND_URL);
  await expect(page.getByRole('button', { name: /register/i })).toBeVisible({ timeout: TIMEOUT.short });

  // Start registration
  await page.getByRole('button', { name: /register/i }).click();
  await expect(page.getByRole('heading', { name: /join matou/i })).toBeVisible({ timeout: TIMEOUT.short });
  await page.getByRole('button', { name: /continue/i }).click();

  // Fill profile
  await page.getByPlaceholder('Your preferred name').fill(userName);
  await page.locator('textarea').first().fill(`E2E test user: ${userName}`);
  const interest = page.locator('label').filter({ hasText: 'Governance' }).first();
  if (await interest.isVisible()) await interest.click();
  await page.locator('input[type="checkbox"]').last().check();

  // Submit - creates AID (witness-backed AIDs can take up to 3 minutes)
  await page.getByRole('button', { name: /continue/i }).click();
  console.log(`[${userName}] Creating identity (this may take up to 3 minutes)...`);
  await expect(page.getByText(/identity created successfully/i)).toBeVisible({ timeout: TIMEOUT.aidCreation });

  // Capture mnemonic
  const mnemonic: string[] = [];
  const wordCards = page.locator('.word-card');
  const wordCount = await wordCards.count();
  for (let i = 0; i < wordCount; i++) {
    const wordText = await wordCards.nth(i).locator('span.font-mono').textContent();
    if (wordText) mnemonic.push(wordText.trim());
  }

  // Complete verification
  await page.locator('.confirm-box input[type="checkbox"]').check();
  await page.getByRole('button', { name: /continue to verification/i }).click();

  await expect(page.getByRole('heading', { name: /verify your recovery phrase/i })).toBeVisible({ timeout: TIMEOUT.short });
  const wordLabels = page.locator('.word-input-group label');
  const labelCount = await wordLabels.count();
  for (let i = 0; i < labelCount; i++) {
    const labelText = await wordLabels.nth(i).textContent();
    const match = labelText?.match(/Word #(\d+)/);
    if (match) {
      const wordIndex = parseInt(match[1], 10) - 1;
      await page.locator(`#word-${i}`).fill(mnemonic[wordIndex]);
    }
  }

  await page.getByRole('button', { name: /verify and continue/i }).click();
  await expect(page.getByText(/application.*review|pending|under review/i).first()).toBeVisible({ timeout: TIMEOUT.medium });
  console.log(`[${userName}] Registration submitted, on pending screen`);
}

// Use serial mode to persist admin session across tests
test.describe.serial('Registration Approval Flow', () => {
  let accounts: TestAccounts;
  let adminContext: BrowserContext;
  let adminPage: Page;

  test.beforeAll(async ({ browser, request }) => {
    accounts = loadAccounts();
    if (!accounts.admin) {
      throw new Error(
        'Admin account not found. Run setup first:\n' +
        'npx playwright test tests/e2e/setup-test-accounts.spec.ts --project=chromium'
      );
    }
    console.log(`[Test] Using admin account created at: ${accounts.createdAt}`);

    // Verify test config exists (created by setup-test-accounts)
    const configExists = await hasTestConfig(request);
    if (!configExists) {
      throw new Error(
        'Test config not found. Run setup first:\n' +
        'npx playwright test tests/e2e/setup-test-accounts.spec.ts --project=chromium'
      );
    }
    console.log('[Test] Using persisted test config');

    // Create persistent admin context with test config isolation
    adminContext = await browser.newContext();
    await setupTestConfig(adminContext);
    adminPage = await adminContext.newPage();
    setupPageLogging(adminPage, 'Admin');

    // Login admin once
    console.log('[Test] Admin logging in...');
    await loginAdminWithMnemonic(adminPage, accounts.admin.mnemonic);
    console.log('[Test] Admin logged in and on dashboard');
  });

  test.afterAll(async () => {
    await adminContext?.close();
  });

  test('admin approves user registration', async ({ browser }) => {
    const userContext = await browser.newContext();
    await setupTestConfig(userContext);
    const userPage = await userContext.newPage();
    setupPageLogging(userPage, 'User1');

    // Unique username to avoid stale registration conflicts
    const userName = `Approve_${uniqueSuffix()}`;

    try {
      // Create user and submit registration
      await createUserAndRegister(userPage, userName);

      // Wait for admin to see registration
      console.log('[Test] Waiting for registration to appear...');
      const adminSection = adminPage.locator('.admin-section');
      await expect(adminSection).toBeVisible({ timeout: TIMEOUT.medium });

      const registrationCard = adminPage.locator('.registration-card').filter({ hasText: userName });
      await expect(registrationCard).toBeVisible({ timeout: TIMEOUT.long });
      console.log('[Test] Registration card visible');

      // Admin approves
      console.log('[Test] Admin clicking approve...');
      await registrationCard.getByRole('button', { name: /approve/i }).click();

      // User receives credential
      console.log('[Test] Waiting for user to receive credential...');
      await expect(userPage.locator('.welcome-overlay')).toBeVisible({ timeout: TIMEOUT.long });
      console.log('[Test] User received credential!');

      // User enters community
      await userPage.getByRole('button', { name: /enter community/i }).click();
      await expect(userPage).toHaveURL(/#\/dashboard/, { timeout: TIMEOUT.short });
      console.log('[Test] PASS - User approved and on dashboard');

    } finally {
      await userContext.close();
    }
  });

  test('admin approves second user registration', async ({ browser }) => {
    // This test verifies admin can handle multiple registrations sequentially
    const userContext = await browser.newContext();
    await setupTestConfig(userContext);
    const userPage = await userContext.newPage();
    setupPageLogging(userPage, 'User1b');

    // Unique username to avoid stale registration conflicts
    const userName = `Approve2_${uniqueSuffix()}`;

    try {
      // Create user and submit registration
      await createUserAndRegister(userPage, userName);

      // Wait for admin to see registration
      console.log('[Test] Waiting for second registration to appear...');
      const adminSection = adminPage.locator('.admin-section');
      await expect(adminSection).toBeVisible({ timeout: TIMEOUT.medium });

      const registrationCard = adminPage.locator('.registration-card').filter({ hasText: userName });
      await expect(registrationCard).toBeVisible({ timeout: TIMEOUT.long });
      console.log('[Test] Second registration card visible');

      // Admin approves
      console.log('[Test] Admin clicking approve on second user...');
      await registrationCard.getByRole('button', { name: /approve/i }).click();

      // User receives credential
      console.log('[Test] Waiting for second user to receive credential...');
      await expect(userPage.locator('.welcome-overlay')).toBeVisible({ timeout: TIMEOUT.long });
      console.log('[Test] Second user received credential!');

      // User enters community
      await userPage.getByRole('button', { name: /enter community/i }).click();
      await expect(userPage).toHaveURL(/#\/dashboard/, { timeout: TIMEOUT.short });
      console.log('[Test] PASS - Second user approved and on dashboard');

    } finally {
      await userContext.close();
    }
  });

  test('admin declines user registration', async ({ browser }) => {
    const userContext = await browser.newContext();
    await setupTestConfig(userContext);
    const userPage = await userContext.newPage();
    setupPageLogging(userPage, 'User2');

    // Unique username to avoid stale registration conflicts
    const userName = `Decline_${uniqueSuffix()}`;

    try {
      // Create user and submit registration
      await createUserAndRegister(userPage, userName);

      // Wait for admin to see registration
      const adminSection = adminPage.locator('.admin-section');
      await expect(adminSection).toBeVisible({ timeout: TIMEOUT.medium });

      const registrationCard = adminPage.locator('.registration-card').filter({ hasText: userName });
      await expect(registrationCard).toBeVisible({ timeout: TIMEOUT.long });

      // Admin declines
      console.log('[Test] Admin clicking decline...');
      const declineBtn = registrationCard.locator('button').last();
      await declineBtn.click();

      // Handle decline modal if present
      const modal = adminPage.locator('.modal-content');
      if (await modal.isVisible({ timeout: TIMEOUT.short }).catch(() => false)) {
        const reasonField = modal.locator('textarea');
        if (await reasonField.isVisible().catch(() => false)) {
          await reasonField.fill('Declined for testing');
        }
        await modal.getByRole('button', { name: /confirm|decline/i }).click();
      }

      // User sees rejection
      console.log('[Test] Waiting for user to see rejection...');
      await expect(userPage.getByText(/declined|rejected/i).first()).toBeVisible({ timeout: TIMEOUT.long });
      console.log('[Test] PASS - User sees rejection');

    } finally {
      await userContext.close();
    }
  });

  test('admin sends message to applicant', async ({ browser }) => {
    const userContext = await browser.newContext();
    await setupTestConfig(userContext);
    const userPage = await userContext.newPage();
    setupPageLogging(userPage, 'User3');

    // Unique username to avoid stale registration conflicts
    const userName = `Message_${uniqueSuffix()}`;

    try {
      // Create user and submit registration
      await createUserAndRegister(userPage, userName);

      // Wait for admin to see registration
      const adminSection = adminPage.locator('.admin-section');
      await expect(adminSection).toBeVisible({ timeout: TIMEOUT.medium });

      const registrationCard = adminPage.locator('.registration-card').filter({ hasText: userName });
      await expect(registrationCard).toBeVisible({ timeout: TIMEOUT.long });

      // Admin clicks message button
      console.log('[Test] Admin clicking message...');
      const messageBtn = registrationCard.getByRole('button', { name: /message/i });
      await expect(messageBtn).toBeVisible({ timeout: TIMEOUT.short });
      await messageBtn.click();

      // Fill and send message
      const modal = adminPage.locator('.modal-content');
      await expect(modal).toBeVisible({ timeout: TIMEOUT.short });
      await modal.locator('textarea').fill('Please provide more details about your background.');
      await modal.getByRole('button', { name: /send/i }).click();
      console.log('[Test] Admin sent message');

      // User receives message
      console.log('[Test] Waiting for user to receive message...');
      await expect(userPage.getByText(/please provide more details/i)).toBeVisible({ timeout: TIMEOUT.long });
      console.log('[Test] PASS - User received message');

    } finally {
      await userContext.close();
    }
  });
});
