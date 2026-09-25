import { test, expect, Page } from './fixtures';

// Feature (#620): Contributions rides on Projects. When a community's Coa kit
// has `features.projects: false`, the Contributions entry is dropped from both
// navigations (desktop sidebar + mobile bottom bar / More sheet), its routes
// redirect to the dashboard, and the dashboard stops pre-fetching/badging it.
//
// The projects-off path is a BUILD-TIME kit flag (`__KIT_PROJECTS__`, applied
// from features.json at bundle time), so it cannot be toggled from a running
// app — the projects:false branch is covered by the navItems unit tests
// (tests/scripts/nav-items.test.ts) and the routes.ts / DashboardLayout guards.
// This e2e spec exercises the stock Mātou build (projects ON) and asserts the
// "nothing changes" acceptance clause: Contributions keeps its slot in the
// desktop sidebar and its mobile primary tab, and its page still opens.

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

async function enterCommunity(page: Page) {
  await page
    .getByRole('button', { name: /enter community/i })
    .click({ timeout: 15_000 })
    .catch(() => {});
}

test.describe('contributions rides on projects — stock build unchanged (#620)', () => {
  test('desktop sidebar keeps the Contributions entry and it opens', async ({ adminPage, snap }) => {
    test.setTimeout(120_000);
    await adminPage.setViewportSize(DESKTOP);
    await enterCommunity(adminPage);

    const sidebar = adminPage.locator('.sidebar-nav');
    const contributions = sidebar.locator('.nav-item', { hasText: 'Contributions' });
    await expect(contributions).toBeVisible({ timeout: 15_000 });
    // Projects (the module Contributions rides on) is present too.
    await expect(sidebar.locator('.nav-item', { hasText: 'Projects' })).toBeVisible();
    await snap(adminPage, 'sidebar-shows-contributions');

    await contributions.click();
    await expect(adminPage).toHaveURL(/#\/dashboard\/contributions$/, { timeout: 15_000 });
    await snap(adminPage, 'contributions-page-opens');
  });

  test('mobile bottom bar keeps Contributions as a primary tab', async ({ adminPage, snap }) => {
    test.setTimeout(120_000);
    await adminPage.setViewportSize(PHONE);
    await enterCommunity(adminPage);

    const tab = adminPage.locator('.bottom-nav .bottom-nav-item', { hasText: 'Contributions' });
    await expect(tab).toBeVisible({ timeout: 15_000 });
    await snap(adminPage, 'mobile-bottom-bar-contributions');
  });
});
