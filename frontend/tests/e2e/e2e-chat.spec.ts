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
  loadAccounts,
  saveAccounts,
  uniqueSuffix,
  type TestAccounts,
} from './utils/test-helpers';

/**
 * E2E: Chat Feature — Full Integration
 *
 * Tests the chat UI end-to-end with real backend API and any-sync P2P
 * infrastructure. Requires org-setup to have been run first (admin account).
 *
 * Flow:
 *  Test 1 (Admin):
 *   1. Admin account recovery via mnemonic
 *   2. Navigate to chat
 *   3. Admin creates a channel, edits it
 *   4. Admin sends messages
 *
 *  Test 2 (Member registration + approval):
 *   1. Spawn member backend, register new member
 *   2. Admin approves registration
 *   3. Member enters community, navigates to chat
 *   4. Member sees channels + admin's messages (P2P sync)
 *   5. Member sends a message
 *
 *  Test 3 (Cross-peer P2P round-trip):
 *   1. Admin sees member's message via P2P sync
 *   2. Admin sends a response
 *   3. Member sees admin's response via P2P sync
 *
 *  Test 4 (Session restart — backend + frontend):
 *   1. Restart member backend (same data dir)
 *   2. Reload member frontend (same localStorage)
 *   3. Member reads past messages, sends new message
 *   4. Admin reads it, responds
 *   5. Member reads admin's new response
 *
 * Run:  npx playwright test --project=chat
 * Deps: org-setup must be run first (test-accounts.json with admin)
 */

const CHAT_URL = '/#/dashboard/chat';
const ADMIN_BACKEND = 'http://localhost:9080';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the first channel ID from a backend via page.evaluate. */
async function getFirstChannelId(page: Page, backendUrl: string): Promise<string | null> {
  return page.evaluate(async (url) => {
    try {
      const resp = await fetch(`${url}/api/v1/chat/channels`);
      const data = await resp.json();
      return data.channels?.[0]?.id ?? null;
    } catch {
      return null;
    }
  }, backendUrl);
}

async function getChannelIdByName(page: Page, backendUrl: string, name: string): Promise<string | null> {
  return page.evaluate(async ([url, chName]) => {
    try {
      const resp = await fetch(`${url}/api/v1/chat/channels`);
      const data = await resp.json();
      const ch = data.channels?.find((c: { name: string }) => c.name === chName);
      return ch?.id ?? null;
    } catch {
      return null;
    }
  }, [backendUrl, name] as const);
}

/**
 * Poll a backend API for a message containing `contentMatch`.
 * Returns true if found within maxAttempts × intervalMs.
 */
async function pollForMessage(
  page: Page,
  backendUrl: string,
  channelId: string,
  contentMatch: string,
  maxAttempts = 12,
  intervalMs = 5_000,
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const contents: string[] = await page.evaluate(
      async ([url, chId]) => {
        try {
          const resp = await fetch(`${url}/api/v1/chat/channels/${chId}/messages`);
          const data = await resp.json();
          return data.messages?.map((m: { content: string }) => m.content) ?? [];
        } catch {
          return [];
        }
      },
      [backendUrl, channelId] as const,
    );

    if (contents.some((c) => c.includes(contentMatch))) {
      console.log(`[Poll] '${contentMatch}' found on attempt ${attempt}`);
      return true;
    }
    console.log(`[Poll] '${contentMatch}' not found (${attempt}/${maxAttempts}, ${contents.length} msgs)`);
    if (attempt < maxAttempts) await page.waitForTimeout(intervalMs);
  }
  return false;
}

/**
 * Navigate a member page to chat and wait for a specific channel to appear.
 * Uses reload-based polling since P2P sync may not be instant.
 */
async function navigateToChatWithChannels(
  page: Page,
  label: string,
  targetChannel: string,
  maxRetries = 10,
): Promise<void> {
  await page.goto(CHAT_URL);
  await expect(page.locator('.sidebar-title')).toHaveText('Channels', { timeout: 15_000 });

  const channelItem = page.locator('.channel-item').filter({ hasText: targetChannel });
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (await channelItem.isVisible().catch(() => false)) break;
    if (attempt === maxRetries) {
      await expect(channelItem).toBeVisible({ timeout: 5_000 });
    }
    console.log(`[${label}] Channel '${targetChannel}' not yet visible, retrying (${attempt}/${maxRetries})...`);
    await page.waitForTimeout(5_000);
    await page.locator('button', { hasText: /home/i }).click();
    await page.waitForTimeout(500);
    await page.locator('button', { hasText: /chat/i }).click();
    await expect(page.locator('.sidebar-title')).toHaveText('Channels', { timeout: 10_000 });
  }
}

/**
 * Reload member page and select the target channel, polling for a specific
 * message to appear via P2P sync.
 */
async function pollUiForMessage(
  page: Page,
  messageText: string,
  label: string,
  targetChannel: string,
  maxRetries = 12,
  intervalMs = 5_000,
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    await page.goto(CHAT_URL);
    await expect(page.locator('.sidebar-title')).toHaveText('Channels', { timeout: 15_000 });
    await page.locator('.channel-item').filter({ hasText: targetChannel }).click();
    await expect(page.locator('.channel-header .channel-name')).toBeVisible({ timeout: 5_000 });

    const found = await page
      .locator('.message-body')
      .filter({ hasText: messageText })
      .isVisible()
      .catch(() => false);
    if (found) {
      console.log(`[${label}] Message found on attempt ${attempt}`);
      return true;
    }
    console.log(`[${label}] Message not synced yet (${attempt}/${maxRetries})`);
    if (attempt < maxRetries) await page.waitForTimeout(intervalMs);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe.serial('Chat', () => {
  let accounts: TestAccounts;
  let adminContext: BrowserContext;
  let adminPage: Page;
  let memberContext: BrowserContext;
  let memberPage: Page;
  let memberMnemonic: string[];
  const backends = new BackendManager();

  // Shared identifiers across tests
  const suffix = Date.now().toString(36);
  let channelName: string;

  test.beforeAll(async ({ browser }) => {
    await requireAllTestServices();

    accounts = loadAccounts();
    if (!accounts.admin?.mnemonic) {
      throw new Error(
        'org-setup must be run first: no admin account in test-accounts.json. ' +
          'Run: npx playwright test --project=org-setup',
      );
    }

    adminContext = await browser.newContext();
    await setupTestConfig(adminContext);
    adminPage = await adminContext.newPage();
    setupPageLogging(adminPage, 'ChatAdmin');
  });

  test.afterAll(async () => {
    await backends.stopAll();
    await memberContext?.close();
    await adminContext?.close();
  });

  // ──────────────────────────────────────────────────────────────
  // Test 1: Admin creates channel, edits it, and sends messages
  // ──────────────────────────────────────────────────────────────
  test('admin creates channel, edits it, and sends messages', async () => {
    test.setTimeout(120_000);

    // --- Admin login ---
    await loginWithMnemonic(adminPage, accounts.admin!.mnemonic);

    // --- Navigate to chat ---
    await adminPage.goto(CHAT_URL);
    await expect(adminPage.locator('.sidebar-title')).toHaveText('Channels', { timeout: 15_000 });

    // --- Admin sees create button ---
    await expect(adminPage.locator('.create-btn')).toBeVisible({ timeout: 15_000 });

    // --- Create a channel ---
    channelName = `e2e-${suffix}`;

    await adminPage.locator('.create-btn').click();
    await expect(adminPage.locator('#name')).toBeVisible({ timeout: 5_000 });
    await adminPage.locator('#name').fill(channelName);
    await adminPage.locator('#description').fill('E2E test channel');
    await adminPage.locator('.modal-content .btn-primary').click();

    const channelItem = adminPage.locator('.channel-item').filter({ hasText: channelName });
    await expect(channelItem).toBeVisible({ timeout: 15_000 });

    // --- Select the channel ---
    await channelItem.click();
    await expect(adminPage.locator('.channel-header .channel-name')).toHaveText(channelName, { timeout: 5_000 });
    await expect(adminPage.locator('.action-btn')).toBeVisible({ timeout: 5_000 });

    // --- Edit the channel ---
    await adminPage.locator('.action-btn').click();
    await expect(adminPage.getByText('Channel Settings')).toBeVisible({ timeout: 5_000 });

    channelName = `e2e-edited-${suffix}`;
    await adminPage.locator('#name').clear();
    await adminPage.locator('#name').fill(channelName);
    await adminPage.getByRole('button', { name: /save/i }).click();

    await expect(adminPage.locator('.channel-header .channel-name')).toHaveText(channelName, { timeout: 10_000 });
    await expect(adminPage.locator('.channel-item').filter({ hasText: channelName })).toBeVisible();

    // --- Send message 1 (button click) ---
    const message1 = `Hello from admin ${suffix}`;
    await adminPage.locator('.message-input').fill(message1);
    await adminPage.locator('.send-btn').click();
    await expect(adminPage.locator('.message-input')).toHaveValue('');
    await expect(
      adminPage.locator('.message-body').filter({ hasText: message1 }),
    ).toBeVisible({ timeout: 15_000 });

    // --- Send message 2 (Enter key) ---
    const message2 = `Second admin message ${suffix}`;
    await adminPage.locator('.message-input').fill(message2);
    await adminPage.locator('.message-input').press('Enter');
    await expect(adminPage.locator('.message-input')).toHaveValue('');
    await expect(
      adminPage.locator('.message-body').filter({ hasText: message2 }),
    ).toBeVisible({ timeout: 15_000 });

    // --- Verify both messages visible ---
    const count = await adminPage.locator('.message-body').count();
    expect(count).toBeGreaterThanOrEqual(2);
  });

  // ──────────────────────────────────────────────────────────────
  // Test 2: New member registers, gets approved, reads + writes
  // ──────────────────────────────────────────────────────────────
  test('new member registers, gets approved, reads messages and sends', async ({ browser }) => {
    test.setTimeout(300_000); // 5 min — registration + approval + P2P sync

    // 1. Spawn member backend
    const memberBackend = await backends.start('chat-member');

    memberContext = await browser.newContext();
    await setupTestConfig(memberContext);
    await setupBackendRouting(memberContext, memberBackend.port);
    memberPage = await memberContext.newPage();
    setupPageLogging(memberPage, 'ChatMember');

    const memberName = `ChatMbr_${uniqueSuffix()}`;

    // 2. Register member (full flow: profile → AID creation → mnemonic → pending)
    const result = await registerUser(memberPage, memberName);
    memberMnemonic = result.mnemonic;
    console.log(`[ChatMember] Registered as ${memberName}`);

    // 3. Admin navigates to dashboard to see registration card
    await adminPage.goto('/#/dashboard');
    await expect(adminPage.locator('.admin-section')).toBeVisible({ timeout: TIMEOUT.medium });

    const registrationCard = adminPage.locator('.registration-card').filter({ hasText: memberName });
    await expect(registrationCard).toBeVisible({ timeout: TIMEOUT.long });
    console.log('[ChatAdmin] Registration card visible, approving...');

    // 4. Admin approves
    await registrationCard.getByRole('button', { name: /approve/i }).click();

    // 5. Member receives credential and enters community
    await expect(memberPage.locator('.welcome-overlay')).toBeVisible({ timeout: TIMEOUT.long });
    console.log('[ChatMember] Credential received, entering community...');

    const enterButton = memberPage.getByRole('button', { name: /enter (community|anyway)/i });
    await enterButton.click({ timeout: TIMEOUT.long + 15_000 });
    await expect(memberPage).toHaveURL(/#\/dashboard/, { timeout: TIMEOUT.short });

    // 6. Save member account for downstream tests / reuse
    const memberAid = await memberPage.evaluate(() => {
      const stored = localStorage.getItem('matou_current_aid');
      if (stored) {
        const parsed = JSON.parse(stored);
        return parsed.prefix || parsed.aid || '';
      }
      return '';
    });
    accounts.member = { mnemonic: memberMnemonic, aid: memberAid, name: memberName };
    accounts.note = 'Auto-generated. Admin from org-setup, member from chat registration.';
    saveAccounts(accounts);
    console.log(`[ChatMember] On dashboard (AID: ${memberAid.slice(0, 12)}...)`);

    // 7. Navigate to chat and wait for channel sync
    await navigateToChatWithChannels(memberPage, 'ChatMember', channelName);

    // 8. Member does NOT see create button (not admin)
    await expect(memberPage.locator('.create-btn')).not.toBeVisible({ timeout: 5_000 });

    // 9. Select the channel
    await memberPage.locator('.channel-item').filter({ hasText: channelName }).click();
    await expect(memberPage.locator('.channel-header .channel-name')).toBeVisible({ timeout: 5_000 });

    // 10. Member does NOT see channel settings button
    await expect(memberPage.locator('.channel-header .action-btn')).not.toBeVisible({ timeout: 5_000 });

    // 11. Member sees admin's past messages (synced via P2P)
    await expect(memberPage.locator('.message-body').first()).toBeVisible({ timeout: 15_000 });
    const messageCount = await memberPage.locator('.message-body').count();
    expect(messageCount).toBeGreaterThanOrEqual(2);
    console.log(`[ChatMember] Sees ${messageCount} messages from admin`);

    // 12. Member sends a message
    const memberMessage = `Hello from new member ${suffix}`;
    await memberPage.locator('.message-input').fill(memberMessage);
    await memberPage.locator('.send-btn').click();
    await expect(memberPage.locator('.message-input')).toHaveValue('');
    await expect(
      memberPage.locator('.message-body').filter({ hasText: memberMessage }),
    ).toBeVisible({ timeout: 15_000 });
    console.log('[ChatMember] Message sent successfully');
  });

  // ──────────────────────────────────────────────────────────────
  // Test 3: Admin replicates member's message, responds, member reads
  // ──────────────────────────────────────────────────────────────
  test('admin reads member message, responds, member reads response', async () => {
    test.setTimeout(180_000); // 3 min — P2P sync each direction

    const memberMsgText = `Hello from new member ${suffix}`;

    // 1. Get channel ID from admin backend (by name to avoid stale channels)
    const channelId = await getChannelIdByName(adminPage, ADMIN_BACKEND, channelName);
    expect(channelId).toBeTruthy();

    // 2. Poll admin backend API for member's message (P2P sync)
    console.log('[ChatAdmin] Polling for member message via P2P...');
    const memberMsgFound = await pollForMessage(
      adminPage, ADMIN_BACKEND, channelId!, 'Hello from new member',
    );
    expect(memberMsgFound, 'Member message should propagate to admin via P2P').toBe(true);

    // 3. Admin navigates to chat and verifies in UI
    await adminPage.goto(CHAT_URL);
    await expect(adminPage.locator('.sidebar-title')).toHaveText('Channels', { timeout: 15_000 });
    await adminPage.locator('.channel-item').filter({ hasText: channelName }).click();
    await expect(
      adminPage.locator('.message-body').filter({ hasText: memberMsgText }),
    ).toBeVisible({ timeout: 15_000 });
    console.log('[ChatAdmin] Member message visible in UI');

    // 4. Admin sends a response
    const adminResponse = `Admin response ${suffix}`;
    await adminPage.locator('.message-input').fill(adminResponse);
    await adminPage.locator('.send-btn').click();
    await expect(adminPage.locator('.message-input')).toHaveValue('');
    await expect(
      adminPage.locator('.message-body').filter({ hasText: adminResponse }),
    ).toBeVisible({ timeout: 15_000 });
    console.log('[ChatAdmin] Response sent');

    // 5. Member polls UI for admin's response (P2P sync)
    console.log('[ChatMember] Polling for admin response via P2P...');
    const adminResponseFound = await pollUiForMessage(
      memberPage, adminResponse, 'ChatMember', channelName,
    );
    expect(adminResponseFound, 'Admin response should propagate to member via P2P').toBe(true);
    await expect(
      memberPage.locator('.message-body').filter({ hasText: adminResponse }),
    ).toBeVisible({ timeout: 5_000 });
    console.log('[ChatMember] Admin response visible');
  });

  // ──────────────────────────────────────────────────────────────
  // Test 4: Member restarts session (backend + frontend)
  // ──────────────────────────────────────────────────────────────
  test('member restarts session, confirms full read-write cycle', async () => {
    test.setTimeout(300_000); // 5 min — restart + P2P sync

    // ─── 1. Restart member backend (same data dir) ───
    console.log('[Restart] Restarting member backend (preserving data dir)...');
    await backends.restart('chat-member');
    console.log('[Restart] Member backend restarted');

    // ─── 2. Reload member frontend (same context → same localStorage) ───
    await memberPage.goto(FRONTEND_URL);

    // After reload with persisted localStorage, the KERI boot restores the
    // identity session. The app typically lands on the splash page showing
    // "E komo mai, <name>!" with an "Enter Community" button — or it may
    // auto-redirect to the dashboard if community access is already verified.
    // In rare cases (no saved passcode) it falls back to the registration splash.

    // First check: did we auto-redirect to dashboard?
    const onDashboard = await memberPage
      .waitForURL(/#\/dashboard/, { timeout: 10_000 })
      .then(() => true)
      .catch(() => false);

    if (!onDashboard) {
      // Look for "Enter Community" / "Enter Anyway" button (session restored on splash)
      const enterBtn = memberPage.getByRole('button', { name: /enter (community|anyway)/i });
      const hasEnterBtn = await enterBtn.isVisible({ timeout: TIMEOUT.long }).catch(() => false);

      if (hasEnterBtn) {
        console.log('[Restart] Session restored — clicking Enter Community');
        await enterBtn.click();
        await expect(memberPage).toHaveURL(/#\/dashboard/, { timeout: TIMEOUT.short });
      } else {
        // Full re-login needed (session not auto-restored)
        console.log('[Restart] Session lost — re-logging in via mnemonic');
        await loginWithMnemonic(memberPage, memberMnemonic);
      }
    } else {
      console.log('[Restart] Auto-restored to dashboard');
    }

    console.log('[Restart] Member session restored, navigating to chat...');

    // ─── 3. Navigate to chat — channels should still be visible ───
    await navigateToChatWithChannels(memberPage, 'Restart', channelName, 8);

    // ─── 4. Member can read past messages ───
    await memberPage.locator('.channel-item').filter({ hasText: channelName }).click();
    await expect(memberPage.locator('.channel-header .channel-name')).toBeVisible({ timeout: 5_000 });
    await expect(memberPage.locator('.message-body').first()).toBeVisible({ timeout: 15_000 });
    const msgCount = await memberPage.locator('.message-body').count();
    expect(msgCount).toBeGreaterThanOrEqual(2);
    console.log(`[Restart] Member sees ${msgCount} past messages`);

    // ─── 5. Member sends a new message ───
    const postRestartMsg = `Post-restart member msg ${suffix}`;
    await memberPage.locator('.message-input').fill(postRestartMsg);
    await memberPage.locator('.send-btn').click();
    await expect(memberPage.locator('.message-input')).toHaveValue('');
    await expect(
      memberPage.locator('.message-body').filter({ hasText: postRestartMsg }),
    ).toBeVisible({ timeout: 15_000 });
    console.log('[Restart] Member sent post-restart message');

    // ─── 6. Admin reads member's post-restart message ───
    const channelId = await getChannelIdByName(adminPage, ADMIN_BACKEND, channelName);
    expect(channelId).toBeTruthy();

    console.log('[ChatAdmin] Polling for post-restart member message...');
    const memberMsgFound = await pollForMessage(
      adminPage, ADMIN_BACKEND, channelId!, 'Post-restart member msg',
    );
    expect(memberMsgFound, 'Post-restart member message should propagate to admin via P2P').toBe(true);

    await adminPage.goto(CHAT_URL);
    await expect(adminPage.locator('.sidebar-title')).toHaveText('Channels', { timeout: 15_000 });
    await adminPage.locator('.channel-item').filter({ hasText: channelName }).click();
    await expect(
      adminPage.locator('.message-body').filter({ hasText: postRestartMsg }),
    ).toBeVisible({ timeout: 15_000 });
    console.log('[ChatAdmin] Post-restart member message visible');

    // ─── 7. Admin sends a new response ───
    const newAdminMsg = `Admin post-restart reply ${suffix}`;
    await adminPage.locator('.message-input').fill(newAdminMsg);
    await adminPage.locator('.send-btn').click();
    await expect(adminPage.locator('.message-input')).toHaveValue('');
    await expect(
      adminPage.locator('.message-body').filter({ hasText: newAdminMsg }),
    ).toBeVisible({ timeout: 15_000 });
    console.log('[ChatAdmin] Post-restart response sent');

    // ─── 8. Member reads admin's new response ───
    console.log('[ChatMember] Polling for admin post-restart response...');
    const newResponseFound = await pollUiForMessage(
      memberPage, newAdminMsg, 'Restart', channelName,
    );
    expect(newResponseFound, 'Admin post-restart response should propagate to member via P2P').toBe(true);
    await expect(
      memberPage.locator('.message-body').filter({ hasText: newAdminMsg }),
    ).toBeVisible({ timeout: 5_000 });
    console.log('[Restart] Full post-restart read-write cycle verified');
  });
});
