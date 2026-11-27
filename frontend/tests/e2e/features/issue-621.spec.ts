import { test, expect, Page } from './fixtures';

// Feature (#621) — Community Settings' Roles section renders only the
// permission tables for the features the community's kit turned on. Every
// feature table now gates on KIT.features (the same source the nav reads),
// while the always-on rows (Community, Community roles, Org details) stay.
//
// The live e2e build is stock Mātou, which enables every feature, so this
// spec demonstrates acceptance clause 2: with every feature on, all tables
// show as before — and each feature-gated section now carries a data-feature
// marker (projects / proposals / chat / notices). The hidden-table behaviour
// (a build with features off) is covered by the Vitest unit test, since the
// live environment cannot turn a kit feature off.

async function openRolesPage(page: Page): Promise<void> {
  const enter = page.getByRole('button', { name: /enter community/i });
  if (await enter.isVisible().catch(() => false)) {
    await enter.click();
  }
  const gear = page.locator('.community-settings-btn');
  await expect(gear).toBeVisible({ timeout: 30_000 });
  await gear.click();
  await expect(page.getByRole('heading', { name: 'Community Settings' })).toBeVisible();
}

test.describe('Community Settings feature-gated tables (#621)', () => {
  test('stock Mātou (every feature on) shows all permission tables, each gated section marked', async ({
    adminPage,
    snap,
  }) => {
    test.setTimeout(120_000);
    await openRolesPage(adminPage);

    // The always-on sections are present.
    await expect(adminPage.locator('.community-permissions-section')).toBeVisible();
    await expect(adminPage.locator('.community-section')).toBeVisible();
    await expect(adminPage.locator('.org-section')).toBeVisible();

    // Every feature table renders, and each carries its data-feature marker.
    await expect(adminPage.locator('.projects-section[data-feature="projects"]')).toBeVisible();
    await expect(adminPage.locator('.project-section[data-feature="projects"]')).toBeVisible();
    await expect(adminPage.locator('.proposals-section[data-feature="proposals"]')).toBeVisible();
    await expect(adminPage.locator('.chat-section[data-feature="chat"]')).toBeVisible();
    await expect(adminPage.locator('.notices-section[data-feature="notices"]')).toBeVisible();

    await snap(adminPage, 'roles-all-features-on');
  });
});
