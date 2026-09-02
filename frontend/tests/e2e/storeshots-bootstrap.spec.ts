import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '@playwright/test';
import { setupTestConfig } from './utils/mock-config';
import { requireAllTestServices } from './utils/keri-testnet';
import {
  FRONTEND_URL,
  TIMEOUT,
  setupPageLogging,
  setupBackendRouting,
  registerUser,
  approvePendingMember,
  performOrgSetup,
  saveAccounts,
  TestAccounts,
} from './utils/test-helpers';

/**
 * Store-screenshot bootstrap.
 *
 * Stands up the fictional community from `docs/mobile/store-listing/cast.json`:
 * org setup as the steward, one member registered and approved, and the
 * "Pending approval" capture taken while the member is genuinely pending.
 *
 * Assumes two backends are already running (started outside Playwright so they
 * survive between spec runs):
 *   admin  :9080   member :9280
 *
 * Run:
 *   npx playwright test -c playwright.storeshots.config.ts --project=storeshots-bootstrap
 */

const CAST = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, '..', '..', '..', 'docs', 'mobile', 'store-listing', 'cast.json'),
    'utf-8',
  ),
);

const MEMBER_BACKEND_PORT = 9280;
const RAW_DIR = path.resolve(
  __dirname, '..', '..', '..', 'docs', 'mobile', 'store-listing', 'raw',
);

test('bootstrap the store-screenshot community', async ({ browser, request }) => {
  test.setTimeout(900_000);
  await requireAllTestServices();
  fs.mkdirSync(RAW_DIR, { recursive: true });

  // --- Steward: org setup on the admin backend (:9080) -------------------
  const adminCtx = await browser.newContext();
  await setupTestConfig(adminCtx);
  const admin = await adminCtx.newPage();
  setupPageLogging(admin, 'Steward');

  await admin.goto(FRONTEND_URL);
  const accounts: TestAccounts = await performOrgSetup(admin, request, {
    orgName: CAST.community,
    adminName: CAST.steward.name,
  });
  console.log(`[Storeshots] Community "${CAST.community}" created, steward on dashboard`);

  // --- Member: register against their own backend (:9280) ----------------
  const memberCtx = await browser.newContext();
  await setupTestConfig(memberCtx);
  await setupBackendRouting(memberCtx, MEMBER_BACKEND_PORT);
  const member = await memberCtx.newPage();
  setupPageLogging(member, 'Member');

  const { mnemonic } = await registerUser(member, CAST.member.name);
  console.log('[Storeshots] Member registered, on pending screen');

  // --- Shot 6: the pending screen, captured while genuinely pending ------
  // Settle first so the requirement cards have rendered their real state.
  await member.waitForTimeout(3000);
  await member.screenshot({ path: path.join(RAW_DIR, '06-pending.png') });
  console.log('[Storeshots] Captured 06-pending.png');

  // --- Steward approves --------------------------------------------------
  // The membership credential is issued by the steward's frontend AFTER
  // /init-member, so this page must stay open until the profile flips.
  // The pending member reaches the steward through KERIA notification delivery
  // + registration polling, which the shared helper waits only 60s for. On a
  // loaded box that is not always enough, and the card only materialises while
  // the dashboard is open and polling — so reload and look again rather than
  // failing the whole bootstrap on one slow delivery.
  const memberCard = admin
    .locator('.members-card')
    .locator('.card-name')
    .filter({ hasText: CAST.member.name });
  for (let attempt = 1; attempt <= 6; attempt++) {
    if (await memberCard.isVisible().catch(() => false)) break;
    console.log(`[Storeshots] waiting for "${CAST.member.name}" on the steward dashboard (${attempt}/6)`);
    await admin.waitForTimeout(30_000);
    await admin.reload();
    await admin.waitForLoadState('networkidle').catch(() => {});
  }
  await expect(memberCard).toBeVisible({ timeout: TIMEOUT.registrationSubmit });

  const approved = admin
    .waitForEvent('console', {
      predicate: (m) => /SharedProfile status flipped to approved/i.test(m.text()),
      timeout: 300_000,
    })
    .catch(() => null);

  await approvePendingMember(admin, CAST.member.name);
  console.log('[Storeshots] Approval submitted, waiting for credential issuance...');
  await approved;

  // --- Member enters the community --------------------------------------
  const enterBtn = member.getByRole('button', { name: /enter community/i });
  await expect(enterBtn).toBeVisible({ timeout: TIMEOUT.groupCredentialJoin });
  await expect(enterBtn).toBeEnabled({ timeout: TIMEOUT.groupCredentialJoin });
  await enterBtn.click();
  await expect(member).toHaveURL(/#\/dashboard/, { timeout: TIMEOUT.long });
  console.log('[Storeshots] Member is in the community');

  const memberAid = await member.evaluate(() => {
    const stored = localStorage.getItem('matou_current_aid');
    if (!stored) return '';
    const parsed = JSON.parse(stored);
    return parsed.prefix || parsed.aid || '';
  });

  accounts.member = { mnemonic, aid: memberAid, name: CAST.member.name };
  accounts.note = 'Store-screenshot community (see docs/mobile/store-listing/cast.json)';
  saveAccounts(accounts);
  console.log(`[Storeshots] Member AID: ${memberAid}`);

  await memberCtx.close();
  await adminCtx.close();
});
