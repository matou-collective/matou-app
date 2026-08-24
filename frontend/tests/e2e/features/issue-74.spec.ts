import { test, expect, Page } from './fixtures';

// Feature (#74): at phone widths (≤767px) the sidebar is hidden, so
// DashboardLayout renders a fixed bottom tab bar instead — 4 primary nav
// entries (Home · Chat · Notices · Contributions) plus a "More" tab (5 tabs),
// with active highlight and unread badges. The More tab opens a bottom sheet
// listing the overflow destinations (Wallet, Proposals, Projects) and the
// profile link → Account settings, where "Report an issue" now lives on
// mobile (the same ReportIssueDialog). Desktop is unchanged: sidebar visible,
// no bottom bar, no sheet.

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

async function enterCommunity(page: Page) {
  const enterBtn = page.getByRole('button', { name: /enter community/i });
  await enterBtn.click({ timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(500);
}

test.describe('mobile bottom tab bar (#74)', () => {
  test('5-tab bar + More sheet navigate at 390px; Report an issue on Account settings', async ({
    adminPage,
    snap,
  }) => {
    test.setTimeout(300_000);

    await adminPage.setViewportSize(DESKTOP);
    await enterCommunity(adminPage);

    // --- Phone width: sidebar hidden, bottom bar present with 5 tabs. ---
    await adminPage.setViewportSize(PHONE);
    await adminPage.waitForTimeout(400);

    await expect(adminPage.locator('.sidebar')).toBeHidden();
    const bottomNav = adminPage.locator('.bottom-nav');
    await expect(bottomNav).toBeVisible();
    await expect(bottomNav.locator('.bottom-nav-item')).toHaveCount(5);
    await snap(adminPage, 'bottom-nav-390');

    // Active highlight follows the route: tap Chat, it becomes active.
    const chatTab = bottomNav.locator('.bottom-nav-item', { hasText: 'Chat' });
    await chatTab.click();
    await adminPage.waitForTimeout(400);
    await expect(chatTab).toHaveClass(/active/);
    await snap(adminPage, 'chat-tab-active-390');

    // --- More tab opens the overflow sheet with the collapsed destinations. ---
    const moreTab = bottomNav.locator('.bottom-nav-item.more-tab');
    await moreTab.click();
    await adminPage.waitForTimeout(300);
    const moreSheet = adminPage.locator('.more-sheet');
    await expect(moreSheet).toBeVisible();
    await expect(moreSheet.locator('.more-sheet-item', { hasText: 'Wallet' })).toBeVisible();
    await expect(moreSheet.locator('.more-sheet-item', { hasText: 'Proposals' })).toBeVisible();
    await expect(moreSheet.locator('.more-sheet-item', { hasText: 'Projects' })).toBeVisible();
    await snap(adminPage, 'more-sheet-390');

    // Tapping an overflow entry navigates and closes the sheet; the More tab
    // then shows as active because the route is an overflow destination.
    await moreSheet.locator('.more-sheet-item', { hasText: 'Proposals' }).click();
    await adminPage.waitForTimeout(400);
    await expect(moreSheet).toBeHidden();
    await expect(moreTab).toHaveClass(/active/);
    await snap(adminPage, 'proposals-more-active-390');

    // Profile link (in the More sheet) → Account settings, where "Report an
    // issue" now lives on mobile.
    await moreTab.click();
    await adminPage.waitForTimeout(300);
    await moreSheet.locator('.more-sheet-item').last().click();
    await adminPage.waitForTimeout(500);
    const reportBtn = adminPage.getByRole('button', { name: /report an issue/i });
    await expect(reportBtn).toBeVisible();
    await reportBtn.click();
    // Same ReportIssueDialog — scope the title assert to the dialog card so it
    // resolves to the dialog heading, not the (now covered) launcher button.
    await expect(
      adminPage.locator('.report-dialog').getByText(/report an issue/i),
    ).toBeVisible();
    await snap(adminPage, 'account-settings-report-dialog-390');

    // --- Desktop width: sidebar back, bottom bar gone. ---
    await adminPage.setViewportSize(DESKTOP);
    await adminPage.waitForTimeout(400);
    await expect(adminPage.locator('.sidebar')).toBeVisible();
    await expect(bottomNav).toBeHidden();
    await snap(adminPage, 'sidebar-desktop-1280');
  });
});
