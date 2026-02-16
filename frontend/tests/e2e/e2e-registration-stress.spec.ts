import { test, expect, Page, BrowserContext } from '@playwright/test';
import { setupTestConfig } from './utils/mock-config';
import { requireAllTestServices } from './utils/keri-testnet';
import { BackendManager } from './utils/backend-manager';
import {
  FRONTEND_URL,
  TIMEOUT,
  setupPageLogging,
  setupBackendRouting,
  registerUser,
  loginWithMnemonic,
  uniqueSuffix,
  loadAccounts,
  performOrgSetup,
  TestAccounts,
} from './utils/test-helpers';

/**
 * E2E: Registration Stress Test
 *
 * Submits multiple registrations concurrently and has the admin process them
 * (80% approve, 20% decline) to validate that KERIA, any-sync, and the backend
 * handle concurrent load without race conditions or resource exhaustion.
 *
 * Structure: 3 batches of 5 registrations each (15 users total).
 * Within each batch:
 *   - 5 users register concurrently (each with own backend + browser context)
 *   - Admin processes all 5: approves 4, declines 1
 *   - Cleanup batch backends before next batch
 *
 * Run: npx playwright test --project=stress
 */

const BATCH_SIZE = 5;
const APPROVE_COUNT = 4; // per batch
const BATCH_TIMEOUT = 600_000; // 10 minutes per batch
const INTER_BATCH_COOLDOWN = 30_000; // 30s cooldown between batches for KERIA recovery

interface UserSetup {
  name: string;
  backendName: string;
  context: BrowserContext;
  page: Page;
}

interface BatchResult {
  batchIndex: number;
  totalMs: number;
  registrationMs: number;
  processingMs: number;
  registered: number;
  failed: number;
  approved: number;
  declined: number;
}

test.describe.serial('Registration Stress Test', () => {
  let accounts: TestAccounts;
  let adminContext: BrowserContext;
  let adminPage: Page;
  const backends = new BackendManager();

  test.beforeAll(async ({ browser, request }) => {
    await requireAllTestServices();

    adminContext = await browser.newContext();
    await setupTestConfig(adminContext);
    adminPage = await adminContext.newPage();
    setupPageLogging(adminPage, 'Admin');

    await adminPage.goto(FRONTEND_URL);

    const needsSetup = await Promise.race([
      adminPage.waitForURL(/.*#\/setup/, { timeout: TIMEOUT.medium })
        .then(() => true),
      adminPage.locator('button', { hasText: /register/i })
        .waitFor({ state: 'visible', timeout: TIMEOUT.medium })
        .then(() => false),
    ]);

    if (needsSetup) {
      console.log('[Stress] No org config — running org setup...');
      accounts = await performOrgSetup(adminPage, request);
    } else {
      console.log('[Stress] Org config exists — recovering admin...');
      accounts = loadAccounts();
      if (!accounts.admin?.mnemonic) {
        throw new Error(
          'Org configured but no admin mnemonic found in test-accounts.json.\n' +
          'Either run org-setup first or clean test state and re-run.',
        );
      }
      await loginWithMnemonic(adminPage, accounts.admin.mnemonic);
    }
    console.log('[Stress] Admin ready on dashboard');
  });

  test.afterAll(async () => {
    await backends.stopAll();
    await adminContext?.close();
  });

  /**
   * Run a single batch: start backends, register users concurrently,
   * admin processes them (approve first N, decline the rest), verify outcomes.
   */
  async function runBatch(
    browser: import('@playwright/test').Browser,
    batchIndex: number,
  ): Promise<BatchResult> {
    const batchStart = Date.now();
    const suffix = uniqueSuffix();
    const users: UserSetup[] = [];

    console.log(`\n${'='.repeat(60)}`);
    console.log(`[Stress] Batch ${batchIndex + 1}/3 starting...`);
    console.log(`${'='.repeat(60)}`);

    // 1. Start backends and create browser contexts concurrently
    console.log(`[Stress] Starting ${BATCH_SIZE} backends...`);
    const backendPromises = Array.from({ length: BATCH_SIZE }, (_, i) =>
      backends.start(`stress-b${batchIndex}-u${i}`),
    );
    const backendInstances = await Promise.all(backendPromises);

    for (let i = 0; i < BATCH_SIZE; i++) {
      const ctx = await browser.newContext();
      await setupTestConfig(ctx);
      await setupBackendRouting(ctx, backendInstances[i].port);
      const page = await ctx.newPage();
      const name = `Stress_B${batchIndex}_U${i}_${suffix}`;
      setupPageLogging(page, name);
      users.push({
        name,
        backendName: `stress-b${batchIndex}-u${i}`,
        context: ctx,
        page,
      });
    }

    // 1b. Pre-load all user pages sequentially to avoid overwhelming the
    //     Vite dev server with 5 concurrent SPA loads. Each page must fully
    //     load (Register button visible) before the next one starts.
    console.log(`[Stress] Pre-loading ${BATCH_SIZE} user pages...`);
    for (const user of users) {
      await user.page.goto(FRONTEND_URL);
      await expect(
        user.page.getByRole('button', { name: /register/i }),
      ).toBeVisible({ timeout: TIMEOUT.medium });
      console.log(`[Stress] ${user.name}: page loaded`);
    }

    // 2. Register all users concurrently
    console.log(`[Stress] Registering ${BATCH_SIZE} users concurrently...`);
    const regStart = Date.now();
    const regResults = await Promise.allSettled(
      users.map(u => registerUser(u.page, u.name)),
    );
    const registrationMs = Date.now() - regStart;

    // Log registration outcomes
    let registered = 0;
    let failed = 0;
    for (let i = 0; i < regResults.length; i++) {
      const r = regResults[i];
      if (r.status === 'fulfilled') {
        registered++;
        console.log(`[Stress] ${users[i].name}: registered OK`);
      } else {
        failed++;
        console.error(`[Stress] ${users[i].name}: FAILED - ${r.reason}`);
      }
    }
    console.log(
      `[Stress] Registration phase: ${registered} ok, ${failed} failed (${registrationMs}ms)`,
    );

    // Only process successfully registered users
    const successfulUsers = users.filter((_, i) => regResults[i].status === 'fulfilled');
    const approveUsers = successfulUsers.slice(0, APPROVE_COUNT);
    const declineUsers = successfulUsers.slice(APPROVE_COUNT);

    // 3. Admin processes each registration card sequentially
    //    Phase A: click approve/decline on each card, wait for card to disappear
    //    Phase B: verify outcomes on user pages (in parallel for approved users)
    //    Separating these phases avoids serializing credential delivery waits.
    console.log(`[Stress] Admin processing ${successfulUsers.length} registrations...`);
    const procStart = Date.now();
    let approved = 0;
    let declined = 0;

    // Phase A: Admin clicks approve/decline on each card
    for (let i = 0; i < successfulUsers.length; i++) {
      const user = successfulUsers[i];
      const shouldApprove = i < APPROVE_COUNT;

      // Wait for the registration card to appear
      console.log(`[Stress] Waiting for card: ${user.name}...`);
      const adminSection = adminPage.locator('.admin-section');
      await expect(adminSection).toBeVisible({ timeout: TIMEOUT.medium });

      const card = adminPage.locator('.registration-card').filter({ hasText: user.name });
      // Under cumulative KERIA load (many agents from prior batches), notification
      // delivery slows down. Give polling enough time to pick up new registrations.
      await expect(card).toBeVisible({ timeout: TIMEOUT.registrationSubmit });

      if (shouldApprove) {
        console.log(`[Stress] Approving ${user.name}...`);
        await card.getByRole('button', { name: /approve/i }).click();

        // Wait for the card to disappear (admin-side processing complete)
        await expect(card).not.toBeVisible({ timeout: TIMEOUT.long + 30_000 });
        approved++;
        console.log(`[Stress] ${user.name}: admin approval processed`);
      } else {
        console.log(`[Stress] Declining ${user.name}...`);
        const declineBtn = card.locator('button').last();
        await declineBtn.click();

        // Handle decline modal if present
        const modal = adminPage.locator('.modal-content');
        if (await modal.isVisible({ timeout: TIMEOUT.short }).catch(() => false)) {
          const reasonField = modal.locator('textarea');
          if (await reasonField.isVisible().catch(() => false)) {
            await reasonField.fill('Declined during stress test');
          }
          await modal.getByRole('button', { name: /confirm|decline/i }).click();
        }

        // Wait for the card to disappear
        await expect(card).not.toBeVisible({ timeout: TIMEOUT.long });
        declined++;
        console.log(`[Stress] ${user.name}: admin decline processed`);
      }
    }

    console.log(`[Stress] Admin done. Verifying user outcomes...`);

    // Phase B: Verify approved users receive credential (in parallel)
    // Under load, credential delivery via KERIA can take 2+ minutes.
    const credentialTimeout = 180_000;
    await Promise.all(approveUsers.map(async (user) => {
      console.log(`[Stress] Waiting for credential: ${user.name}...`);
      await expect(user.page.locator('.welcome-overlay')).toBeVisible({
        timeout: credentialTimeout,
      });

      const enterBtn = user.page.getByRole('button', { name: /enter community/i });
      await expect(enterBtn).toBeEnabled({ timeout: credentialTimeout });
      await enterBtn.click();
      await expect(user.page).toHaveURL(/#\/dashboard/, { timeout: TIMEOUT.short });
      console.log(`[Stress] ${user.name}: credential received + entered community`);
    }));

    // Phase C: Verify declined users see rejection (in parallel)
    await Promise.all(declineUsers.map(async (user) => {
      console.log(`[Stress] Waiting for rejection: ${user.name}...`);
      await expect(
        user.page.getByText(/declined|rejected/i).first(),
      ).toBeVisible({ timeout: TIMEOUT.long });
      console.log(`[Stress] ${user.name}: rejection visible`);
    }));

    const processingMs = Date.now() - procStart;

    // 4. Cleanup: close contexts and stop backends
    console.log(`[Stress] Cleaning up batch ${batchIndex + 1}...`);
    for (const user of users) {
      await user.context.close();
    }
    for (const user of users) {
      await backends.stop(user.backendName);
    }

    const totalMs = Date.now() - batchStart;
    const result: BatchResult = {
      batchIndex,
      totalMs,
      registrationMs,
      processingMs,
      registered,
      failed,
      approved,
      declined,
    };

    console.log(`\n[Stress] Batch ${batchIndex + 1} complete:`);
    console.log(`  Registration: ${registrationMs}ms (${registered} ok, ${failed} failed)`);
    console.log(`  Processing:   ${processingMs}ms (${approved} approved, ${declined} declined)`);
    console.log(`  Total:        ${totalMs}ms`);

    return result;
  }

  // ------------------------------------------------------------------
  // Batch tests
  // ------------------------------------------------------------------

  test('batch 1: register and process 5 users', async ({ browser }) => {
    test.setTimeout(BATCH_TIMEOUT);
    const result = await runBatch(browser, 0);
    expect(result.registered).toBeGreaterThanOrEqual(APPROVE_COUNT);
    expect(result.approved).toBe(APPROVE_COUNT);
    expect(result.declined).toBeGreaterThanOrEqual(1);
  });

  test('batch 2: register and process 5 users', async ({ browser }) => {
    test.setTimeout(BATCH_TIMEOUT);
    console.log(`[Stress] Cooldown ${INTER_BATCH_COOLDOWN / 1000}s before batch 2...`);
    await new Promise(r => setTimeout(r, INTER_BATCH_COOLDOWN));
    const result = await runBatch(browser, 1);
    expect(result.registered).toBeGreaterThanOrEqual(APPROVE_COUNT);
    expect(result.approved).toBe(APPROVE_COUNT);
    expect(result.declined).toBeGreaterThanOrEqual(1);
  });

  test('batch 3: register and process 5 users', async ({ browser }) => {
    test.setTimeout(BATCH_TIMEOUT);
    console.log(`[Stress] Cooldown ${INTER_BATCH_COOLDOWN / 1000}s before batch 3...`);
    await new Promise(r => setTimeout(r, INTER_BATCH_COOLDOWN));
    const result = await runBatch(browser, 2);
    expect(result.registered).toBeGreaterThanOrEqual(APPROVE_COUNT);
    expect(result.approved).toBe(APPROVE_COUNT);
    expect(result.declined).toBeGreaterThanOrEqual(1);
  });
});
