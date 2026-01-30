/**
 * Shared test helpers for E2E tests.
 *
 * Extracts common patterns from individual test files to reduce duplication:
 * - Page logging setup
 * - Mnemonic capture and verification
 * - Profile form filling
 * - Full registration flow
 * - Admin login via mnemonic recovery
 * - Test account persistence
 */
import { expect, Page, BrowserContext, APIRequestContext } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { keriEndpoints } from './keri-testnet';
import { clearTestConfig } from './mock-config';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Uses Playwright baseURL from playwright.config.ts (test server on port 9003) */
export const FRONTEND_URL = '';

/** Backend API base URL (test server runs on port 9080) */
export const BACKEND_URL = 'http://localhost:9080';

/** Config server URL from KERI test network */
export const CONFIG_SERVER_URL = keriEndpoints.configURL;

/** Timeouts for individual operations */
export const TIMEOUT = {
  short: 10_000,       // 10s - quick UI operations
  medium: 20_000,      // 20s - simple KERI operations, polling
  long: 30_000,        // 30s - credential delivery
  aidCreation: 60_000,  // 1 min - witness-backed AID creation
  orgSetup: 120_000,   // 2 min - full org setup
} as const;

// ---------------------------------------------------------------------------
// Test account persistence
// ---------------------------------------------------------------------------

const ACCOUNTS_FILE = path.join(__dirname, '..', 'test-accounts.json');

export interface TestAccounts {
  note: string;
  admin: {
    mnemonic: string[];
    aid: string;
    name: string;
  } | null;
  createdAt: string | null;
}

export function loadAccounts(): TestAccounts {
  const data = fs.readFileSync(ACCOUNTS_FILE, 'utf-8');
  return JSON.parse(data);
}

export function saveAccounts(accounts: TestAccounts): void {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
  console.log(`[Helpers] Saved accounts to ${ACCOUNTS_FILE}`);
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** Generate a unique suffix for test usernames to avoid stale registration conflicts */
export function uniqueSuffix(): string {
  return Date.now().toString(36).slice(-6);
}

// ---------------------------------------------------------------------------
// Page logging
// ---------------------------------------------------------------------------

/**
 * Attach filtered console + network logging to a page.
 * Filters for KERI, registration, credential, and error messages.
 */
export function setupPageLogging(page: Page, prefix: string): void {
  page.on('console', (msg) => {
    const text = msg.text();
    if (
      text.includes('Registration') || text.includes('Admin') ||
      text.includes('Credential') || text.includes('IPEX') ||
      text.includes('KERIClient') || text.includes('Polling') ||
      text.includes('OrgSetup') || text.includes('Config') ||
      text.includes('Error') || msg.type() === 'error'
    ) {
      console.log(`[${prefix}] ${text}`);
    }
  });

  page.on('requestfailed', (request) => {
    console.log(`[${prefix} FAILED] ${request.method()} ${request.url()}`);
  });
}

// ---------------------------------------------------------------------------
// Mnemonic helpers
// ---------------------------------------------------------------------------

/**
 * Extract all 12 mnemonic words from `.word-card` elements on the
 * profile-confirmation screen.
 */
export async function captureMnemonicWords(page: Page): Promise<string[]> {
  const words: string[] = [];
  const wordCards = page.locator('.word-card');
  const count = await wordCards.count();
  for (let i = 0; i < count; i++) {
    const wordText = await wordCards.nth(i).locator('span.font-mono').textContent();
    if (wordText) words.push(wordText.trim());
  }
  return words;
}

/**
 * Complete the mnemonic verification step.
 *
 * Fills in the "Word #N" inputs with the correct words from `mnemonic`,
 * then clicks the verify button.
 *
 * @param buttonName - regex for the verify button label (default: /verify/i)
 */
export async function completeMnemonicVerification(
  page: Page,
  mnemonic: string[],
  buttonName: RegExp = /verify/i,
): Promise<void> {
  await expect(
    page.getByRole('heading', { name: /verify your recovery phrase/i }),
  ).toBeVisible({ timeout: TIMEOUT.short });

  const wordLabels = page.locator('.word-input-group label, label:has-text("Word #")');
  const labelCount = await wordLabels.count();

  for (let i = 0; i < labelCount; i++) {
    const labelText = await wordLabels.nth(i).textContent();
    const match = labelText?.match(/word\s*#(\d+)/i);
    if (match) {
      const wordIndex = parseInt(match[1], 10) - 1;
      await page.locator(`#word-${i}`).fill(mnemonic[wordIndex]);
    }
  }

  const verifyBtn = page.getByRole('button', { name: buttonName });
  await expect(verifyBtn).toBeEnabled({ timeout: 5000 });
  await verifyBtn.click();
}

// ---------------------------------------------------------------------------
// Profile form helpers
// ---------------------------------------------------------------------------

/**
 * Fill the "Create Your Profile" form fields.
 */
export async function fillProfileForm(
  page: Page,
  name: string,
  bio?: string,
): Promise<void> {
  await page.getByPlaceholder('Your preferred name').fill(name);

  const bioField = page.locator('textarea').first();
  await bioField.fill(bio ?? `E2E test user: ${name}`);

  // Select an interest if available
  const interest = page.locator('label').filter({ hasText: 'Governance' }).first();
  if (await interest.isVisible()) await interest.click();

  // Agree to terms
  await page.locator('input[type="checkbox"]').last().check();
}

/**
 * Navigate from splash screen to the profile form:
 * Splash -> Register -> Join Matou -> Profile form.
 */
export async function navigateToProfileForm(page: Page): Promise<void> {
  await expect(
    page.getByRole('button', { name: /register/i }),
  ).toBeVisible({ timeout: TIMEOUT.short });
  await page.getByRole('button', { name: /register/i }).click();

  await expect(
    page.getByRole('heading', { name: /join matou/i }),
  ).toBeVisible({ timeout: TIMEOUT.short });
  await page.getByRole('button', { name: /continue/i }).click();

  await expect(
    page.getByRole('heading', { name: /create your profile/i }),
  ).toBeVisible({ timeout: TIMEOUT.short });
}

// ---------------------------------------------------------------------------
// Composite flows
// ---------------------------------------------------------------------------

/**
 * Full user registration flow: navigate -> fill form -> submit -> capture
 * mnemonic -> verify -> land on pending screen.
 *
 * Returns the captured mnemonic words.
 */
export async function registerUser(
  page: Page,
  userName: string,
): Promise<{ mnemonic: string[] }> {
  await page.goto(FRONTEND_URL);
  await navigateToProfileForm(page);
  await fillProfileForm(page, userName);

  // Submit - creates AID (witness-backed AIDs can take up to 3 minutes)
  await page.getByRole('button', { name: /continue/i }).click();
  console.log(`[${userName}] Creating identity...`);
  await expect(
    page.getByText(/identity created successfully/i),
  ).toBeVisible({ timeout: TIMEOUT.aidCreation });

  // Capture mnemonic
  const mnemonic = await captureMnemonicWords(page);

  // Confirm and proceed to verification
  await page.locator('.confirm-box input[type="checkbox"]').check();
  await page.getByRole('button', { name: /continue to verification/i }).click();

  // Complete verification
  await completeMnemonicVerification(page, mnemonic, /verify and continue/i);

  // Wait for pending screen
  await expect(
    page.getByText(/application.*review|pending|under review/i).first(),
  ).toBeVisible({ timeout: TIMEOUT.medium });
  console.log(`[${userName}] Registration submitted, on pending screen`);

  return { mnemonic };
}

/**
 * Log in as an existing user by recovering identity from mnemonic.
 * Ends on the dashboard.
 */
export async function loginWithMnemonic(
  page: Page,
  mnemonic: string[],
): Promise<void> {
  await page.goto(FRONTEND_URL);
  await expect(
    page.getByRole('button', { name: /register/i }),
  ).toBeVisible({ timeout: TIMEOUT.short });

  await page.getByText(/recover identity/i).click();
  await expect(
    page.getByRole('heading', { name: /recover your identity/i }),
  ).toBeVisible({ timeout: TIMEOUT.short });

  for (let i = 0; i < mnemonic.length; i++) {
    await page.locator(`#word-${i}`).fill(mnemonic[i]);
  }

  await page.getByRole('button', { name: /recover identity/i }).click();
  await expect(
    page.getByText(/identity recovered/i),
  ).toBeVisible({ timeout: TIMEOUT.long });

  await page.getByRole('button', { name: /continue to dashboard/i }).click();
  await expect(page).toHaveURL(/#\/dashboard/, { timeout: TIMEOUT.short });
}

// ---------------------------------------------------------------------------
// Org setup flow (reusable from registration tests)
// ---------------------------------------------------------------------------

/**
 * Perform the full org setup flow through the UI, then create spaces via API.
 *
 * Assumes `page` is already on `/#/setup` (e.g. after splash redirect).
 * After completion the admin is on the dashboard with a live KERIA session,
 * community + admin private spaces exist, and test-accounts.json is saved.
 *
 * @returns The saved TestAccounts object
 */
export async function performOrgSetup(
  page: Page,
  request: APIRequestContext,
): Promise<TestAccounts> {
  // --- Clear any stale test config ---
  await clearTestConfig(request);

  // Clear localStorage so we start fresh
  await page.evaluate(() => localStorage.clear());

  // Ensure we're on the setup page
  await page.waitForLoadState('networkidle');
  await expect(
    page.getByRole('heading', { name: /community setup/i }),
  ).toBeVisible({ timeout: TIMEOUT.short });

  // --- Fill org setup form ---
  await page.locator('input').first().fill('Matou Community');
  await page.locator('input').nth(1).fill('Admin User');

  // --- Submit and wait for KERI operations ---
  await page.getByRole('button', { name: /create organization/i }).click();
  console.log('[OrgSetup] Creating admin identity...');

  await expect(page).toHaveURL(/#\/$/, { timeout: TIMEOUT.orgSetup });
  console.log('[OrgSetup] Admin identity created, redirected');

  // --- Mnemonic capture ---
  await expect(
    page.getByRole('heading', { name: /identity created/i }),
  ).toBeVisible({ timeout: TIMEOUT.short });
  const adminMnemonic = await captureMnemonicWords(page);
  console.log(`[OrgSetup] Captured admin mnemonic (${adminMnemonic.length} words)`);
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

  // Wait for dashboard, pending screen, or welcome overlay with "enter community"
  const outcome = await Promise.race([
    page.getByRole('button', { name: /enter community/i })
      .waitFor({ state: 'visible', timeout: TIMEOUT.long })
      .then(() => 'welcome' as const),
    expect(page.getByRole('heading', { name: /registration pending/i }))
      .toBeVisible({ timeout: TIMEOUT.long })
      .then(() => 'pending' as const),
    expect(page).toHaveURL(/#\/dashboard/, { timeout: TIMEOUT.long })
      .then(() => 'dashboard' as const),
  ]);
  console.log(`[OrgSetup] Post-mnemonic outcome: ${outcome}`);

  // If welcome overlay appeared, click "enter community" to reach dashboard
  if (outcome === 'welcome' || outcome === 'pending') {
    const enterBtn = page.getByRole('button', { name: /enter community/i });
    try {
      await enterBtn.waitFor({ state: 'visible', timeout: TIMEOUT.short });
      await enterBtn.click();
      console.log('[OrgSetup] Clicked "enter community"');
      await expect(page).toHaveURL(/#\/dashboard/, { timeout: TIMEOUT.short });
    } catch {
      // Button not present — may already be on dashboard or pending screen
      console.log('[OrgSetup] No "enter community" button found, continuing');
    }
  }

  console.log('[OrgSetup] Admin on dashboard');

  // --- Verify config saved to server ---
  const configResponse = await request.get(`${CONFIG_SERVER_URL}/api/config`, {
    headers: { 'X-Test-Config': 'true' },
  });
  expect(configResponse.ok()).toBe(true);

  const config = await configResponse.json();
  expect(config.organization).toBeDefined();
  expect(config.organization.aid).toBeTruthy();
  console.log('[OrgSetup] Config verified on server');

  // --- Create community + admin private spaces via API ---
  const communityResponse = await request.post(`${BACKEND_URL}/api/v1/spaces/community`, {
    data: {
      orgAid: config.organization.aid,
      orgName: config.organization.name || 'Matou Community',
    },
  });
  expect(communityResponse.ok(),
    `Community space creation failed: ${communityResponse.status()}`).toBe(true);
  const communityBody = await communityResponse.json();
  console.log('[OrgSetup] Community space created:', communityBody.spaceId);

  const adminAidFromConfig = config.admin?.aid || config.admins?.[0]?.aid;
  expect(adminAidFromConfig, 'Admin AID must exist in config').toBeTruthy();

  const privateResponse = await request.post(`${BACKEND_URL}/api/v1/spaces/private`, {
    data: { userAid: adminAidFromConfig },
  });
  expect(privateResponse.ok(),
    `Admin private space creation failed: ${privateResponse.status()}`).toBe(true);
  const privateBody = await privateResponse.json();
  console.log('[OrgSetup] Admin private space created:', privateBody.spaceId);

  // --- Save admin account for reuse ---
  const accounts: TestAccounts = {
    note: 'Auto-generated by performOrgSetup. Only admin/org is persisted.',
    admin: {
      mnemonic: adminMnemonic,
      aid: adminAid,
      name: 'Admin User',
    },
    createdAt: new Date().toISOString(),
  };
  saveAccounts(accounts);
  console.log(`[OrgSetup] Admin AID: ${adminAid}`);

  return accounts;
}
