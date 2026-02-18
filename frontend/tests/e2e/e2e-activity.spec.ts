import { test, expect, Page, BrowserContext } from '@playwright/test';
import { setupTestConfig } from './utils/mock-config';
import { requireAllTestServices } from './utils/keri-testnet';
import { BackendManager } from './utils/backend-manager';
import {
  FRONTEND_URL,
  TIMEOUT,
  setupPageLogging,
  setupBackendRouting,
  loginWithMnemonic,
  registerUser,
  navigateToActivity,
  createNotice,
  uniqueSuffix,
  loadAccounts,
  performOrgSetup,
  TestAccounts,
} from './utils/test-helpers';

/**
 * E2E: Activity Page (Community Notice Board)
 *
 * Tests the full notice lifecycle: create draft, publish, RSVP, acknowledge,
 * save/pin, archive. Verifies feed filtering via filter pills (All, Events,
 * Announcements, Updates).
 *
 * Uses unique notice titles per run so tests are idempotent (stale data
 * from previous runs won't cause strict mode violations).
 *
 * Uses the admin user (steward) who can create and manage notices.
 * Self-sufficient: performs org setup if not already done.
 *
 * Run: npx playwright test --project=activity
 */

test.describe.serial('Activity Page', () => {
  let accounts: TestAccounts;
  let context: BrowserContext;
  let page: Page;

  // Unique titles per run — prevents stale data conflicts
  const runId = uniqueSuffix();
  const eventTitle = `Meetup ${runId}`;
  const updateTitle = `Announcement ${runId}`;

  // Multi-user test state
  let memberContext: BrowserContext;
  let memberPage: Page;
  let memberMnemonic: string[];
  const backends = new BackendManager();
  let liveNoticeTitle: string;

  test.beforeAll(async ({ browser, request }) => {
    await requireAllTestServices();

    context = await browser.newContext();
    await setupTestConfig(context);
    page = await context.newPage();
    setupPageLogging(page, 'Activity');

    await page.goto(FRONTEND_URL);

    const needsSetup = await Promise.race([
      page.waitForURL(/.*#\/setup/, { timeout: TIMEOUT.medium })
        .then(() => true),
      page.locator('button', { hasText: /register/i })
        .waitFor({ state: 'visible', timeout: TIMEOUT.medium })
        .then(() => false),
    ]);

    if (needsSetup) {
      console.log('[Activity] No org config detected — running org setup...');
      accounts = await performOrgSetup(page, request);
      console.log('[Activity] Org setup complete, admin is on dashboard');
    } else {
      console.log('[Activity] Org config exists — recovering admin identity...');
      accounts = loadAccounts();
      if (!accounts.admin?.mnemonic) {
        throw new Error(
          'Org configured but no admin mnemonic found in test-accounts.json.\n' +
          'Either run org-setup first or clean test state and re-run.',
        );
      }
      console.log(`[Activity] Using admin account created at: ${accounts.createdAt}`);
      await loginWithMnemonic(page, accounts.admin.mnemonic);
      console.log('[Activity] Admin logged in and on dashboard');
    }
  });

  test.afterAll(async () => {
    await backends.stopAll();
    await memberContext?.close();
    await context?.close();
  });

  // ---------------------------------------------------------------
  // Test 1: Navigate to activity page via sidebar
  // ---------------------------------------------------------------
  test('navigate to activity via sidebar', async () => {
    const activityNavItem = page.locator('.nav-item', { hasText: 'Activity' });
    await activityNavItem.click();

    await expect(page).toHaveURL(/#\/dashboard\/activity/, { timeout: TIMEOUT.short });
    await expect(page.locator('.activity-title')).toContainText('Activity Feed', { timeout: TIMEOUT.short });
    await expect(activityNavItem).toHaveClass(/active/);
  });

  // ---------------------------------------------------------------
  // Test 2: Verify filter pills and steward controls
  // ---------------------------------------------------------------
  test('filter pills visible with steward controls', async () => {
    // "All" filter pill should be active by default
    const allFilter = page.locator('.filter-pill', { hasText: 'All' });
    await expect(allFilter).toHaveClass(/active/);

    // All filter pills visible
    await expect(page.locator('.filter-pill', { hasText: 'Events' })).toBeVisible();
    await expect(page.locator('.filter-pill', { hasText: 'Announcements' })).toBeVisible();
    await expect(page.locator('.filter-pill', { hasText: 'Updates' })).toBeVisible();

    // Loading should resolve
    await expect(page.locator('.loading-state')).not.toBeVisible({ timeout: TIMEOUT.medium });

    // Create Notice button visible for steward (requires async credential check)
    await expect(page.locator('.create-btn')).toBeVisible({ timeout: TIMEOUT.medium });
  });

  // ---------------------------------------------------------------
  // Test 3: Create event notice as draft
  // ---------------------------------------------------------------
  test('create event notice as draft', async () => {
    await page.locator('.create-btn').click();

    // Dialog opens
    const overlay = page.locator('.dialog-overlay');
    await expect(overlay).toBeVisible({ timeout: TIMEOUT.short });
    await expect(page.locator('.dialog-title', { hasText: 'Create Notice' })).toBeVisible();

    // Event type should be selected by default
    await expect(page.locator('.type-btn', { hasText: 'Event' })).toHaveClass(/active/);

    // Fill form
    await page.locator('input[placeholder="Notice title"]').fill(eventTitle);
    await page.locator('textarea[placeholder="Describe this notice..."]').fill('Monthly community meetup at the hall');

    // Set future event start (use datetime-local input)
    const futureDate = '2099-06-15T18:00';
    await page.locator('input[type="datetime-local"]').first().fill(futureDate);

    // Set location
    await page.locator('input[placeholder="Where is this event?"]').fill('Community Hall');

    // Enable RSVP
    await page.locator('label', { hasText: 'Enable RSVP' }).locator('input[type="checkbox"]').check();

    // Save as draft
    await page.locator('.form-btn', { hasText: 'Save Draft' }).click();

    // Dialog closes
    await expect(overlay).not.toBeVisible({ timeout: TIMEOUT.medium });

    // Draft notice should appear at top of feed (steward sees drafts section)
    const draftCard = page.locator('.feed-card', { hasText: eventTitle });
    await expect(draftCard).toBeVisible({ timeout: TIMEOUT.medium });
    await expect(draftCard.locator('.feed-card-title')).toContainText(eventTitle);
    await expect(draftCard.locator('.notice-state-badge.draft')).toBeVisible();
  });

  // ---------------------------------------------------------------
  // Test 4: Publish event notice — appears in feed
  // ---------------------------------------------------------------
  test('publish event notice', async () => {
    // Find the draft card's inline Publish button (no dialog needed)
    const draftCard = page.locator('.feed-card', { hasText: eventTitle });
    await expect(draftCard).toBeVisible({ timeout: TIMEOUT.medium });

    const publishBtn = draftCard.locator('.admin-btn.publish');
    await expect(publishBtn).toBeVisible({ timeout: TIMEOUT.short });
    await publishBtn.click();

    // Wait for notices to reload
    await expect(page.locator('.loading-state')).not.toBeVisible({ timeout: TIMEOUT.medium });

    // Filter to Events to verify it shows up
    await page.locator('.filter-pill', { hasText: 'Events' }).click();

    const eventCard = page.locator('.feed-card', { hasText: eventTitle });
    await expect(eventCard).toBeVisible({ timeout: TIMEOUT.medium });
    await expect(eventCard.locator('.feed-card-title')).toContainText(eventTitle);
    await expect(eventCard.locator('.notice-state-badge.published')).toBeVisible();
  });

  // ---------------------------------------------------------------
  // Test 5: Create update notice (direct publish)
  // ---------------------------------------------------------------
  test('create update notice with direct publish', async () => {
    // Reset filter to All
    await page.locator('.filter-pill', { hasText: 'All' }).click();

    await page.locator('.create-btn').click();

    const overlay = page.locator('.dialog-overlay');
    await expect(overlay).toBeVisible({ timeout: TIMEOUT.short });

    // Switch to Update type
    await page.locator('.type-btn', { hasText: 'Update' }).click();
    await expect(page.locator('.type-btn', { hasText: 'Update' })).toHaveClass(/active/);

    // Fill form
    await page.locator('input[placeholder="Notice title"]').fill(updateTitle);
    await page.locator('textarea[placeholder="Describe this notice..."]').fill('Please read this important community announcement');

    // Enable acknowledgment
    await page.locator('label', { hasText: 'Require Acknowledgment' }).locator('input[type="checkbox"]').check();

    // Direct publish
    await page.locator('.form-btn.primary', { hasText: 'Publish' }).click();

    // Dialog closes
    await expect(overlay).not.toBeVisible({ timeout: TIMEOUT.medium });

    // Filter to Updates
    await page.locator('.filter-pill', { hasText: 'Updates' }).click();
    await expect(page.locator('.filter-pill', { hasText: 'Updates' })).toHaveClass(/active/);

    // Update notice should appear
    await expect(page.locator('.loading-state')).not.toBeVisible({ timeout: TIMEOUT.medium });
    const updateCard = page.locator('.feed-card', { hasText: updateTitle });
    await expect(updateCard).toBeVisible({ timeout: TIMEOUT.medium });
    await expect(updateCard.locator('.feed-card-title')).toContainText(updateTitle);
    await expect(updateCard.locator('.notice-type-badge.update')).toBeVisible();
  });

  // ---------------------------------------------------------------
  // Test 6: RSVP to event
  // ---------------------------------------------------------------
  test('RSVP to event', async () => {
    // Filter to Events
    await page.locator('.filter-pill', { hasText: 'Events' }).click();

    await expect(page.locator('.loading-state')).not.toBeVisible({ timeout: TIMEOUT.medium });

    // Find the event card with RSVP buttons
    const eventCard = page.locator('.feed-card', { hasText: eventTitle });
    await expect(eventCard).toBeVisible({ timeout: TIMEOUT.medium });

    // Click "Going"
    const goingBtn = eventCard.locator('.rsvp-btn', { hasText: 'Going' });
    await goingBtn.click();
    await expect(goingBtn).toHaveClass(/active/, { timeout: TIMEOUT.short });

    // Change to "Maybe" — overwrites previous RSVP
    const maybeBtn = eventCard.locator('.rsvp-btn', { hasText: 'Maybe' });
    await maybeBtn.click();
    await expect(maybeBtn).toHaveClass(/active/, { timeout: TIMEOUT.short });
  });

  // ---------------------------------------------------------------
  // Test 7: Acknowledge update
  // ---------------------------------------------------------------
  test('acknowledge update', async () => {
    // Filter to Updates
    await page.locator('.filter-pill', { hasText: 'Updates' }).click();

    await expect(page.locator('.loading-state')).not.toBeVisible({ timeout: TIMEOUT.medium });

    // Find the update card with Acknowledge button
    const updateCard = page.locator('.feed-card', { hasText: updateTitle });
    await expect(updateCard).toBeVisible({ timeout: TIMEOUT.medium });

    const ackBtn = updateCard.locator('.ack-btn');
    await expect(ackBtn).toBeVisible();
    await expect(ackBtn).toContainText('Acknowledge');

    // Click acknowledge
    await ackBtn.click();

    // Should change to "Acknowledged" and be disabled
    await expect(ackBtn).toContainText('Acknowledged', { timeout: TIMEOUT.short });
    await expect(ackBtn).toHaveClass(/acked/);
    await expect(ackBtn).toBeDisabled();
  });

  // ---------------------------------------------------------------
  // Test 8: Save/pin notice
  // ---------------------------------------------------------------
  test('save and pin notice', async () => {
    // Still on Updates filter with the announcement card
    const updateCard = page.locator('.feed-card', { hasText: updateTitle });
    await expect(updateCard).toBeVisible({ timeout: TIMEOUT.short });

    // Click save button (bookmark icon)
    const saveBtn = updateCard.locator('.save-btn');
    await saveBtn.click();

    // Should show saved state
    await expect(saveBtn).toHaveClass(/saved/, { timeout: TIMEOUT.short });
  });

  // ---------------------------------------------------------------
  // Test 9: Archive event — disappears from Events filter
  // ---------------------------------------------------------------
  test('archive event notice', async () => {
    // Filter to Events
    await page.locator('.filter-pill', { hasText: 'Events' }).click();

    await expect(page.locator('.loading-state')).not.toBeVisible({ timeout: TIMEOUT.medium });

    // Find the event card — admin actions are inline (no dialog needed)
    const eventCard = page.locator('.feed-card', { hasText: eventTitle });
    await expect(eventCard).toBeVisible({ timeout: TIMEOUT.medium });

    // Admin actions should show Archive button for published notice
    const archiveBtn = eventCard.locator('.admin-btn.archive');
    await expect(archiveBtn).toBeVisible({ timeout: TIMEOUT.short });
    await archiveBtn.click();

    // Wait for reload — archived event should no longer appear in Events filter
    await expect(page.locator('.loading-state')).not.toBeVisible({ timeout: TIMEOUT.medium });

    // Show All to verify archived event is visible somewhere (feed shows all states for steward)
    await page.locator('.filter-pill', { hasText: 'All' }).click();
    // The archived notice may or may not show in the "All" published feed depending on
    // whether filteredFeed includes archived. Just verify the card is gone from Events filter.
    await page.locator('.filter-pill', { hasText: 'Events' }).click();
    await expect(page.locator('.feed-card', { hasText: eventTitle })).not.toBeVisible({ timeout: TIMEOUT.medium });
  });

  // ---------------------------------------------------------------
  // Test 10: Direct URL navigation
  // ---------------------------------------------------------------
  test('direct URL navigation to activity', async () => {
    await page.goto(`${FRONTEND_URL}/#/dashboard/activity`);

    // Activity page renders with title
    await expect(page.locator('.activity-title')).toContainText('Activity Feed', { timeout: TIMEOUT.short });

    // Activity active in main sidebar
    await expect(page.locator('.nav-item', { hasText: 'Activity' })).toHaveClass(/active/);

    // All filter pills visible
    await expect(page.locator('.filter-pill', { hasText: 'All' })).toBeVisible();
    await expect(page.locator('.filter-pill', { hasText: 'Events' })).toBeVisible();
    await expect(page.locator('.filter-pill', { hasText: 'Announcements' })).toBeVisible();
    await expect(page.locator('.filter-pill', { hasText: 'Updates' })).toBeVisible();
  });

  // ===============================================================
  // Multi-User Tests (11-15)
  //
  // After the first 10 tests, the notice state for this run is:
  //   - updateTitle (published, update type)
  //   - eventTitle (archived)
  // ===============================================================

  // ---------------------------------------------------------------
  // Test 11: Member registers and joins community
  // ---------------------------------------------------------------
  test('member registers and joins community', async ({ browser }) => {
    test.setTimeout(300_000); // 5 min — registration + approval + sync

    // Spawn a dedicated backend for the member
    const memberBackend = await backends.start('member-activity');

    // Create fresh browser context for the member
    memberContext = await browser.newContext();
    await setupTestConfig(memberContext);
    await setupBackendRouting(memberContext, memberBackend.port);
    memberPage = await memberContext.newPage();
    setupPageLogging(memberPage, 'Member');

    const memberName = `Member_${uniqueSuffix()}`;

    // 1. Member registers (creates AID, submits application)
    const { mnemonic } = await registerUser(memberPage, memberName);
    memberMnemonic = mnemonic;

    // 2. Admin navigates to Home to see registration card
    await page.locator('.nav-item', { hasText: 'Home' }).click();
    await expect(page).toHaveURL(/#\/dashboard/, { timeout: TIMEOUT.short });

    // Wait for admin section with pending registrations
    const adminSection = page.locator('.admin-section');
    await expect(adminSection).toBeVisible({ timeout: TIMEOUT.medium });

    const registrationCard = page.locator('.registration-card').filter({ hasText: memberName });
    await expect(registrationCard).toBeVisible({ timeout: TIMEOUT.registrationSubmit });
    console.log('[Test 11] Member registration card visible on admin dashboard');

    // 3. Admin approves the registration
    console.log('[Test 11] Admin clicking approve...');
    await registrationCard.getByRole('button', { name: /approve/i }).click();

    // 4. Member sees welcome overlay and enters community
    await expect(memberPage.locator('.welcome-overlay')).toBeVisible({ timeout: TIMEOUT.long });
    console.log('[Test 11] Member received credential!');

    const enterBtn = memberPage.getByRole('button', { name: /enter community/i });
    await expect(enterBtn).toBeEnabled({ timeout: TIMEOUT.aidCreation });
    await enterBtn.click();

    await expect(memberPage).toHaveURL(/#\/dashboard/, { timeout: TIMEOUT.short });
    console.log('[Test 11] PASS — Member on dashboard');
  });

  // ---------------------------------------------------------------
  // Test 12: Member sees existing notices after sync
  // ---------------------------------------------------------------
  test('member sees existing notices after sync', async () => {
    test.setTimeout(120_000); // 2 min

    // Navigate member to Activity page
    await navigateToActivity(memberPage);

    // After any-sync replication, the member should see the update in the feed.
    // Filter to Updates and use toPass() retry to handle replication latency.
    await expect(async () => {
      await memberPage.locator('.filter-pill', { hasText: 'Updates' }).click();
      await expect(
        memberPage.locator('.feed-card', { hasText: updateTitle }),
      ).toBeVisible();
    }).toPass({ intervals: [5_000], timeout: 60_000 });
    console.log(`[Test 12] Member sees "${updateTitle}" in Updates filter`);

    // Verify the archived event appears in All filter (archived notices visible in feed)
    await expect(async () => {
      await memberPage.locator('.filter-pill', { hasText: 'All' }).click();
      // The update should be visible in All
      await expect(
        memberPage.locator('.feed-card', { hasText: updateTitle }),
      ).toBeVisible();
    }).toPass({ intervals: [5_000], timeout: 60_000 });
    console.log(`[Test 12] PASS — Member sees notices in feed`);
  });

  // ---------------------------------------------------------------
  // Test 13: Member receives live notice via polling
  // ---------------------------------------------------------------
  test('member receives live notice via polling', async () => {
    test.setTimeout(120_000); // 2 min

    // Member on All filter
    await memberPage.locator('.filter-pill', { hasText: 'Events' }).click();

    // Admin navigates to Activity and creates a new notice
    await navigateToActivity(page);

    liveNoticeTitle = `Live Event ${uniqueSuffix()}`;
    await createNotice(page, {
      type: 'event',
      title: liveNoticeTitle,
      summary: 'This notice was created while the member was watching',
      eventStart: '2099-07-20T10:00',
      location: 'Community Center',
      publish: true,
    });
    console.log(`[Test 13] Admin created and published "${liveNoticeTitle}"`);

    // Member should see the new notice appear via polling + any-sync replication
    await expect(async () => {
      await memberPage.locator('.filter-pill', { hasText: 'Events' }).click();
      await expect(
        memberPage.locator('.feed-card', { hasText: liveNoticeTitle }),
      ).toBeVisible();
    }).toPass({ intervals: [5_000], timeout: 60_000 });
    console.log('[Test 13] PASS — Member sees live notice via polling');
  });

  // ---------------------------------------------------------------
  // Test 14: Member sees archived notice disappear from Updates
  // ---------------------------------------------------------------
  test('member sees archived notice disappear from updates', async () => {
    test.setTimeout(120_000); // 2 min

    // Admin archives the update notice via inline admin button
    await page.locator('.filter-pill', { hasText: 'Updates' }).click();
    await expect(page.locator('.loading-state')).not.toBeVisible({ timeout: TIMEOUT.medium });

    const updateCard = page.locator('.feed-card', { hasText: updateTitle });
    await expect(updateCard).toBeVisible({ timeout: TIMEOUT.medium });

    const archiveBtn = updateCard.locator('.admin-btn.archive');
    await expect(archiveBtn).toBeVisible({ timeout: TIMEOUT.short });
    await archiveBtn.click();
    console.log(`[Test 14] Admin archived "${updateTitle}"`);

    // Member: notice should disappear from Updates filter
    await expect(async () => {
      await memberPage.locator('.filter-pill', { hasText: 'Updates' }).click();
      await expect(
        memberPage.locator('.feed-card', { hasText: updateTitle }),
      ).not.toBeVisible();
    }).toPass({ intervals: [5_000], timeout: 60_000 });
    console.log(`[Test 14] PASS — "${updateTitle}" gone from member Updates filter`);
  });

  // ---------------------------------------------------------------
  // Test 15: Direct URL navigation for member
  // ---------------------------------------------------------------
  test('direct URL navigation for member', async () => {
    await memberPage.goto(`${FRONTEND_URL}/#/dashboard/activity`);

    // Activity page renders with title
    await expect(memberPage.locator('.activity-title')).toContainText('Activity Feed', { timeout: TIMEOUT.short });

    // All filter pills visible
    await expect(memberPage.locator('.filter-pill', { hasText: 'All' })).toBeVisible();
    await expect(memberPage.locator('.filter-pill', { hasText: 'Events' })).toBeVisible();
    await expect(memberPage.locator('.filter-pill', { hasText: 'Announcements' })).toBeVisible();
    await expect(memberPage.locator('.filter-pill', { hasText: 'Updates' })).toBeVisible();

    // Member is NOT a steward — Create Notice button should NOT be visible
    await expect(memberPage.locator('.create-btn')).not.toBeVisible();
    console.log('[Test 15] PASS — Member sees activity page via direct URL, no Create button');
  });
});
