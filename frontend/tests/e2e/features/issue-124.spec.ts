import { test, expect, Page } from './fixtures';

/**
 * Feature (#124): in the single-pane mobile chat the channel-list rows were too
 * small to scan — the channel name inherited a compact size, the channel
 * `description` was never rendered, and rows had a tight tap target.
 *
 * ChannelListItem.vue now renders the name at body size (≥16px), shows the
 * `description` as a secondary line beneath it when present, and (at the ≤767px
 * mobile breakpoint) gives each row more vertical padding / min-height for a
 * comfortable tap target. Desktop stays sensible — same name/description stack,
 * just a compact row.
 */

const PHONE = { width: 390, height: 844 };
const CHANNEL_URL = '/#/dashboard/chat';

// Dismiss the welcome splash if present so the dashboard nav is reachable.
async function enterCommunity(page: Page) {
  await page
    .getByRole('button', { name: /enter community/i })
    .click({ timeout: 15_000 })
    .catch(() => {});
}

test.describe('mobile channel-list labels (#124)', () => {
  test('channel row shows a body-size name + description with a large tap target', async ({
    adminPage,
    snap,
  }) => {
    test.setTimeout(120_000);

    await enterCommunity(adminPage);
    await adminPage.goto(CHANNEL_URL);
    await expect(adminPage.locator('.sidebar-title')).toHaveText('Channels', { timeout: 15_000 });

    // Create a channel that carries a description so the secondary line renders.
    const name = `scan-test-${Date.now().toString().slice(-5)}`;
    const description = 'A channel with a description to scan on mobile';
    await adminPage.locator('.create-btn').click();
    await adminPage.locator('#name').fill(name);
    await adminPage.locator('#description').fill(description);
    await adminPage.getByRole('button', { name: /create channel/i }).click();

    const row = adminPage.locator('.channel-item').filter({ hasText: name });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await snap(adminPage, 'desktop-channel-list');

    // --- Switch to the single-pane mobile viewport. ---
    await adminPage.setViewportSize(PHONE);
    // Return to the channel list (mobile single-pane) if a channel is open.
    await adminPage
      .locator('.channel-header .back-btn')
      .click({ timeout: 3_000 })
      .catch(() => {});
    await expect(adminPage.locator('.sidebar-title')).toHaveText('Channels', { timeout: 10_000 });

    const mobileRow = adminPage.locator('.channel-item').filter({ hasText: name });
    await expect(mobileRow).toBeVisible({ timeout: 10_000 });

    // Name renders at body size (≥16px) and is easy to scan.
    const nameEl = mobileRow.locator('.channel-name');
    await expect(nameEl).toHaveText(name);
    const nameFontPx = await nameEl.evaluate((el) =>
      parseFloat(getComputedStyle(el).fontSize)
    );
    expect(nameFontPx, 'channel name is at least body size (16px)').toBeGreaterThanOrEqual(16);

    // Description shows as a secondary line beneath the name.
    const descEl = mobileRow.locator('.channel-description');
    await expect(descEl).toHaveText(description);

    // Row is a comfortably large tap target.
    const rowBox = await mobileRow.boundingBox();
    expect(rowBox, 'row should have a bounding box').not.toBeNull();
    if (rowBox) {
      expect(rowBox.height, 'row is a comfortable tap target (≥48px)').toBeGreaterThanOrEqual(48);
    }

    await snap(adminPage, 'mobile-channel-list');
  });
});
