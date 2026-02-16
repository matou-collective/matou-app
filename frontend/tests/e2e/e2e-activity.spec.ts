import { test, expect, Page, BrowserContext } from '@playwright/test';
import { setupTestConfig } from './utils/mock-config';
import { requireAllTestServices } from './utils/keri-testnet';
import {
  FRONTEND_URL,
  TIMEOUT,
  setupPageLogging,
  loginWithMnemonic,
  loadAccounts,
  performOrgSetup,
  TestAccounts,
} from './utils/test-helpers';

/**
 * E2E: Activity Page (Community Notice Board)
 *
 * Tests the full notice lifecycle: create draft, publish, RSVP, acknowledge,
 * save/pin, archive. Verifies board view filtering across Upcoming Events,
 * Updates, Past, and Drafts tabs.
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
    await context?.close();
  });

  // ---------------------------------------------------------------
  // Test 1: Navigate to activity page via sidebar
  // ---------------------------------------------------------------
  test('navigate to activity via sidebar', async () => {
    const activityNavItem = page.locator('.nav-item', { hasText: 'Activity' });
    await activityNavItem.click();

    await expect(page).toHaveURL(/#\/dashboard\/activity/, { timeout: TIMEOUT.short });
    await expect(page.locator('.activity-sidebar-title')).toContainText('Activity', { timeout: TIMEOUT.short });
    await expect(activityNavItem).toHaveClass(/active/);
  });

  // ---------------------------------------------------------------
  // Test 2: Empty state — default tab shows no upcoming events
  // ---------------------------------------------------------------
  test('empty state shows no upcoming events', async () => {
    // Upcoming Events tab should be active by default
    const upcomingTab = page.locator('.activity-nav-item', { hasText: 'Upcoming Events' });
    await expect(upcomingTab).toHaveClass(/active/);

    // Loading should resolve
    await expect(page.locator('.loading-state')).not.toBeVisible({ timeout: TIMEOUT.medium });

    // Empty state message
    await expect(page.getByText('No upcoming events')).toBeVisible({ timeout: TIMEOUT.short });

    // Create Notice button visible for steward
    await expect(page.locator('.create-notice-btn')).toBeVisible({ timeout: TIMEOUT.short });
  });

  // ---------------------------------------------------------------
  // Test 3: Create event notice as draft
  // ---------------------------------------------------------------
  test('create event notice as draft', async () => {
    await page.locator('.create-notice-btn').click();

    // Dialog opens
    const overlay = page.locator('.dialog-overlay');
    await expect(overlay).toBeVisible({ timeout: TIMEOUT.short });
    await expect(page.locator('.dialog-title', { hasText: 'Create Notice' })).toBeVisible();

    // Event type should be selected by default
    await expect(page.locator('.type-btn', { hasText: 'Event' })).toHaveClass(/active/);

    // Fill form
    await page.locator('input[placeholder="Notice title"]').fill('Community Meetup');
    await page.locator('textarea[placeholder="Brief summary..."]').fill('Monthly community meetup at the hall');

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

    // Switch to Drafts tab
    const draftsTab = page.locator('.activity-nav-item', { hasText: 'Drafts' });
    await draftsTab.click();
    await expect(draftsTab).toHaveClass(/active/);

    // Draft notice should appear
    const draftCard = page.locator('.notice-card').first();
    await expect(draftCard).toBeVisible({ timeout: TIMEOUT.medium });
    await expect(draftCard.locator('.notice-title')).toContainText('Community Meetup');
    await expect(draftCard.locator('.notice-state-badge.draft')).toBeVisible();
  });

  // ---------------------------------------------------------------
  // Test 4: Publish event notice — moves to Upcoming
  // ---------------------------------------------------------------
  test('publish event notice', async () => {
    // Click the draft card to open detail dialog
    await page.locator('.notice-card').first().click();

    const overlay = page.locator('.dialog-overlay');
    await expect(overlay).toBeVisible({ timeout: TIMEOUT.short });

    // Admin actions should show Publish button for draft
    const publishBtn = page.locator('.admin-btn.publish');
    await expect(publishBtn).toBeVisible({ timeout: TIMEOUT.short });
    await publishBtn.click();

    // Dialog closes after publish
    await expect(overlay).not.toBeVisible({ timeout: TIMEOUT.medium });

    // Switch to Upcoming Events tab
    const upcomingTab = page.locator('.activity-nav-item', { hasText: 'Upcoming Events' });
    await upcomingTab.click();

    // Wait for notices to load and card to appear
    await expect(page.locator('.loading-state')).not.toBeVisible({ timeout: TIMEOUT.medium });

    const eventCard = page.locator('.notice-card').first();
    await expect(eventCard).toBeVisible({ timeout: TIMEOUT.medium });
    await expect(eventCard.locator('.notice-title')).toContainText('Community Meetup');
    await expect(eventCard.locator('.notice-state-badge.published')).toBeVisible();
  });

  // ---------------------------------------------------------------
  // Test 5: Create update notice (direct publish)
  // ---------------------------------------------------------------
  test('create update notice with direct publish', async () => {
    await page.locator('.create-notice-btn').click();

    const overlay = page.locator('.dialog-overlay');
    await expect(overlay).toBeVisible({ timeout: TIMEOUT.short });

    // Switch to Update type
    await page.locator('.type-btn', { hasText: 'Update' }).click();
    await expect(page.locator('.type-btn', { hasText: 'Update' })).toHaveClass(/active/);

    // Fill form
    await page.locator('input[placeholder="Notice title"]').fill('Important Announcement');
    await page.locator('textarea[placeholder="Brief summary..."]').fill('Please read this important community announcement');

    // Enable acknowledgment
    await page.locator('label', { hasText: 'Require Acknowledgment' }).locator('input[type="checkbox"]').check();

    // Direct publish
    await page.locator('.form-btn.primary', { hasText: 'Publish' }).click();

    // Dialog closes
    await expect(overlay).not.toBeVisible({ timeout: TIMEOUT.medium });

    // Switch to Updates tab
    const updatesTab = page.locator('.activity-nav-item', { hasText: 'Updates' });
    await updatesTab.click();
    await expect(updatesTab).toHaveClass(/active/);

    // Update notice should appear
    await expect(page.locator('.loading-state')).not.toBeVisible({ timeout: TIMEOUT.medium });
    const updateCard = page.locator('.notice-card').first();
    await expect(updateCard).toBeVisible({ timeout: TIMEOUT.medium });
    await expect(updateCard.locator('.notice-title')).toContainText('Important Announcement');
    await expect(updateCard.locator('.notice-type-badge.update')).toBeVisible();
  });

  // ---------------------------------------------------------------
  // Test 6: RSVP to event
  // ---------------------------------------------------------------
  test('RSVP to event', async () => {
    // Navigate to Upcoming Events
    const upcomingTab = page.locator('.activity-nav-item', { hasText: 'Upcoming Events' });
    await upcomingTab.click();

    await expect(page.locator('.loading-state')).not.toBeVisible({ timeout: TIMEOUT.medium });

    // Find the event card with RSVP buttons
    const eventCard = page.locator('.notice-card', { hasText: 'Community Meetup' });
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
    // Navigate to Updates tab
    const updatesTab = page.locator('.activity-nav-item', { hasText: 'Updates' });
    await updatesTab.click();

    await expect(page.locator('.loading-state')).not.toBeVisible({ timeout: TIMEOUT.medium });

    // Find the update card with Acknowledge button
    const updateCard = page.locator('.notice-card', { hasText: 'Important Announcement' });
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
    // Still on Updates tab with the announcement card
    const updateCard = page.locator('.notice-card', { hasText: 'Important Announcement' });
    await expect(updateCard).toBeVisible({ timeout: TIMEOUT.short });

    // Click save button (bookmark icon)
    const saveBtn = updateCard.locator('.save-btn');
    await saveBtn.click();

    // Should show saved state
    await expect(saveBtn).toHaveClass(/saved/, { timeout: TIMEOUT.short });
  });

  // ---------------------------------------------------------------
  // Test 9: Archive event — moves to Past tab
  // ---------------------------------------------------------------
  test('archive event notice', async () => {
    // Navigate to Upcoming Events
    const upcomingTab = page.locator('.activity-nav-item', { hasText: 'Upcoming Events' });
    await upcomingTab.click();

    await expect(page.locator('.loading-state')).not.toBeVisible({ timeout: TIMEOUT.medium });

    // Click the event card to open detail
    const eventCard = page.locator('.notice-card', { hasText: 'Community Meetup' });
    await expect(eventCard).toBeVisible({ timeout: TIMEOUT.medium });
    await eventCard.click();

    const overlay = page.locator('.dialog-overlay');
    await expect(overlay).toBeVisible({ timeout: TIMEOUT.short });

    // Admin actions should show Archive button for published notice
    const archiveBtn = page.locator('.admin-btn.archive');
    await expect(archiveBtn).toBeVisible({ timeout: TIMEOUT.short });
    await archiveBtn.click();

    // Dialog closes
    await expect(overlay).not.toBeVisible({ timeout: TIMEOUT.medium });

    // Switch to Past tab
    const pastTab = page.locator('.activity-nav-item', { hasText: 'Past' });
    await pastTab.click();
    await expect(pastTab).toHaveClass(/active/);

    // Archived event should appear
    await expect(page.locator('.loading-state')).not.toBeVisible({ timeout: TIMEOUT.medium });
    const pastCard = page.locator('.notice-card', { hasText: 'Community Meetup' });
    await expect(pastCard).toBeVisible({ timeout: TIMEOUT.medium });
  });

  // ---------------------------------------------------------------
  // Test 10: Direct URL navigation
  // ---------------------------------------------------------------
  test('direct URL navigation to activity', async () => {
    await page.goto(`${FRONTEND_URL}/#/dashboard/activity`);

    // Activity page renders with sidebar
    await expect(page.locator('.activity-sidebar-title')).toContainText('Activity', { timeout: TIMEOUT.short });

    // Activity active in main sidebar
    await expect(page.locator('.nav-item', { hasText: 'Activity' })).toHaveClass(/active/);

    // All activity nav items visible
    await expect(page.locator('.activity-nav-item', { hasText: 'Upcoming Events' })).toBeVisible();
    await expect(page.locator('.activity-nav-item', { hasText: 'Updates' })).toBeVisible();
    await expect(page.locator('.activity-nav-item', { hasText: 'Past' })).toBeVisible();
  });
});
