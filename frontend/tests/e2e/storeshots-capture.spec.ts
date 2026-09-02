import * as fs from 'fs';
import * as path from 'path';
import { test, expect, Page } from '@playwright/test';
import { setupTestConfig } from './utils/mock-config';
import {
  FRONTEND_URL,
  TIMEOUT,
  setupPageLogging,
  setupBackendRouting,
  loginWithMnemonic,
  loadAccounts,
} from './utils/test-helpers';

/**
 * Store-screenshot capture.
 *
 * Logs in as the member bootstrapped by storeshots-bootstrap.spec.ts and
 * captures the store shot-list at a 1080x2400 phone raster. Frame the output
 * with scripts/frame-screenshot.py; see LISTING.md for the captions.
 *
 * Run (after bootstrap + seed-store-data.mjs):
 *   npx playwright test -c playwright.storeshots.config.ts --project=storeshots-capture
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

/**
 * Let the screen finish arriving before the shutter: network quiet, then the
 * async widgets that populate after mount (the dashboard's moon phase is the
 * usual offender — the 2026-08-27 drafts caught it mid-"Loading moon phase...").
 */
async function settle(page: Page, extraMs = 2500): Promise<void> {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page
    .getByText(/loading|Loading/)
    .first()
    .waitFor({ state: 'hidden', timeout: 20_000 })
    .catch(() => {});
  await page.waitForTimeout(extraMs);
}

async function shoot(page: Page, name: string): Promise<void> {
  // Park the cursor off the content: a pointer left over a chat bubble leaves
  // the hover reaction toolbar half-drawn at the frame edge.
  await page.mouse.move(2, 2);
  await page.waitForTimeout(400);
  const file = path.join(RAW_DIR, name);
  await page.screenshot({ path: file });
  console.log(`[Storeshots] ${name}`);
}

test('capture the store shot-list', async ({ browser }) => {
  test.setTimeout(600_000);
  fs.mkdirSync(RAW_DIR, { recursive: true });
  const accounts = loadAccounts();
  expect(accounts.member, 'run storeshots-bootstrap first').toBeTruthy();

  // --- Shot 1: welcome / splash, from a context that has never logged in ---
  const freshCtx = await browser.newContext();
  await setupTestConfig(freshCtx);
  const fresh = await freshCtx.newPage();
  await fresh.goto(FRONTEND_URL);
  await expect(fresh.getByRole('button', { name: /join now/i })).toBeVisible({
    timeout: TIMEOUT.medium,
  });
  await settle(fresh, 1500);
  await shoot(fresh, '01-welcome.png');
  await freshCtx.close();

  // --- Member session for the rest -----------------------------------------
  const ctx = await browser.newContext();
  await setupTestConfig(ctx);
  await setupBackendRouting(ctx, MEMBER_BACKEND_PORT);
  const page = await ctx.newPage();
  setupPageLogging(page, 'Capture');

  await loginWithMnemonic(page, accounts.member!.mnemonic);
  console.log('[Storeshots] Member logged in');

  // --- Shot 2: home ---------------------------------------------------------
  await settle(page, 4000);
  await shoot(page, '02-home.png');

  // --- Shot 3: a chat channel with messages --------------------------------
  await page.goto(`${FRONTEND_URL}/#/dashboard/chat`);
  await settle(page);
  // Mobile chat is single-pane: the channel list shows first, and only once a
  // channel is open does .message-input exist.
  if (!(await page.locator('.message-input').isVisible().catch(() => false))) {
    const channel = page.getByText(CAST.conversation.channel, { exact: false }).first();
    await channel.click({ timeout: TIMEOUT.medium }).catch(() => {});
  }
  await expect(page.locator('.message-input')).toBeVisible({ timeout: TIMEOUT.medium });
  await settle(page);
  await shoot(page, '03-chat.png');

  // --- Shot 4: project detail with milestones ------------------------------
  await page.goto(`${FRONTEND_URL}/#/dashboard/projects`);
  await settle(page);
  await page
    .getByText(CAST.project.name, { exact: false })
    .first()
    .click({ timeout: TIMEOUT.medium })
    .catch(() => console.log('[Storeshots] project card not clickable, capturing list'));
  await settle(page);
  // The header eats the first screen; the milestones are the story here.
  // Stop at milestone 1 — its title is short enough to clear the
  // "N contributions" label, which longer titles collide with at 360px.
  await page.mouse.wheel(0, 380);
  await page.waitForTimeout(1200);
  await shoot(page, '04-project.png');

  // --- Shot 5: proposal detail ---------------------------------------------
  await page.goto(`${FRONTEND_URL}/#/dashboard/proposals`);
  await settle(page);
  await page
    .getByText(CAST.proposal.title, { exact: false })
    .first()
    .click({ timeout: TIMEOUT.medium })
    .catch(() => console.log('[Storeshots] proposal card not clickable, capturing list'));
  await settle(page);
  await shoot(page, '05-proposal.png');

  await ctx.close();
});
