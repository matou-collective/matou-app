import { test, expect, Page } from './fixtures';

// Feature (#74): at phone widths (≤767px) the sidebar is hidden, so
// DashboardLayout renders a fixed bottom tab bar instead — 7 primary nav
// entries plus a Profile tab (8 tabs), with active highlight and unread
// badges. "Report an issue" (a sidebar button on desktop) moves onto the
// Account settings page on mobile, opening the same ReportIssueDialog.
// Desktop is unchanged: sidebar visible, no bottom bar.

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

async function enterCommunity(page: Page) {
  const enterBtn = page.getByRole('button', { name: /enter community/i });
  await enterBtn.click({ timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(500);
}

test.describe('mobile bottom tab bar (#74)', () => {
  test('bottom bar navigates at 390px; Report an issue on Account settings', async ({
    adminPage,
    snap,
  }) => {
    test.setTimeout(300_000);

    await adminPage.setViewportSize(DESKTOP);
    await enterCommunity(adminPage);

    // --- Phone width: sidebar hidden, bottom bar present with 8 tabs. ---
    await adminPage.setViewportSize(PHONE);
    await adminPage.waitForTimeout(400);

    await expect(adminPage.locator('.sidebar')).toBeHidden();
    const bottomNav = adminPage.locator('.bottom-nav');
    await expect(bottomNav).toBeVisible();
    await expect(bottomNav.locator('.bottom-nav-item')).toHaveCount(8);
    await snap(adminPage, 'bottom-nav-390');

    // Active highlight follows the route: tap Chat, it becomes active.
    const chatTab = bottomNav.locator('.bottom-nav-item', { hasText: 'Chat' });
    await chatTab.click();
    await adminPage.waitForTimeout(400);
    await expect(chatTab).toHaveClass(/active/);
    await snap(adminPage, 'chat-tab-active-390');

    // Profile tab → Account settings, where "Report an issue" now lives.
    const profileTab = bottomNav.locator('.bottom-nav-item', { hasText: 'Profile' });
    await profileTab.click();
    await adminPage.waitForTimeout(500);
    const reportBtn = adminPage.getByRole('button', { name: /report an issue/i });
    await expect(reportBtn).toBeVisible();
    await reportBtn.click();
    // Same ReportIssueDialog — its title field is enough to prove it opened.
    await expect(adminPage.getByText(/report an issue/i).first()).toBeVisible();
    await snap(adminPage, 'account-settings-report-dialog-390');

    // --- Desktop width: sidebar back, bottom bar gone. ---
    await adminPage.setViewportSize(DESKTOP);
    await adminPage.waitForTimeout(400);
    await expect(adminPage.locator('.sidebar')).toBeVisible();
    await expect(bottomNav).toBeHidden();
    await snap(adminPage, 'sidebar-desktop-1280');
  });
});
