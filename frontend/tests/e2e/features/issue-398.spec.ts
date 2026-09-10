import { test, expect } from './fixtures';

// Feature (#398): Community Settings — nested Roles | Data sub-nav.
//   - A sub-nav sits directly under the page header with two entries: Roles
//     (default) and Data.
//   - Roles holds everything the page had after #386: the Community permission
//     table, the per-feature tables, and Org details. The header "Save changes"
//     button belongs to Roles and is hidden on Data.
//   - Data is the placeholder home for the schema editor (#396 slice 4); until
//     then it lists the type definitions read-only (name, field count, and the
//     core/custom split).
//   - The active section is carried in the URL (?section=) so reload and deep
//     links keep the section. The #318 access gate fronts both sections.

test.describe('Community Settings nested nav (#398)', () => {
  test('founder switches between the Roles and Data sections', async ({
    adminPage,
    snap,
  }) => {
    test.setTimeout(120_000);

    // Log in leaves the app on the welcome screen or already on the dashboard;
    // get onto the dashboard either way.
    const enter = adminPage.getByRole('button', { name: /enter community/i });
    if (await enter.isVisible().catch(() => false)) {
      await enter.click();
    }
    await expect(adminPage.locator('.sidebar-nav')).toBeVisible({
      timeout: 30_000,
    });

    const gear = adminPage.locator('.community-settings-btn');
    await expect(gear).toBeVisible({ timeout: 30_000 });
    await gear.click();
    await expect(
      adminPage.getByRole('heading', { name: 'Community Settings' }),
    ).toBeVisible();

    // The sub-nav is present and Roles is the default section: the Community
    // permission table is visible and the Save changes button belongs here.
    const subnav = adminPage.locator('.cs-subnav');
    await expect(subnav).toBeVisible();
    await expect(subnav.getByRole('button', { name: 'Roles' })).toBeVisible();
    await expect(subnav.getByRole('button', { name: 'Data' })).toBeVisible();
    await expect(adminPage.locator('.community-permissions-table')).toBeVisible();
    await expect(
      adminPage.getByRole('button', { name: /save changes/i }),
    ).toBeVisible();
    await snap(adminPage, 'roles-section-default');

    // Switch to Data: the type overview table appears, the permission tables and
    // the Save changes button are gone, and the URL records the section.
    await subnav.getByRole('button', { name: 'Data' }).click();
    await expect(adminPage.locator('.data-types-table')).toBeVisible();
    await expect(
      adminPage.getByRole('heading', { name: 'Data types' }),
    ).toBeVisible();
    await expect(adminPage.locator('.community-permissions-table')).toBeHidden();
    await expect(
      adminPage.getByRole('button', { name: /save changes/i }),
    ).toHaveCount(0);
    await expect(adminPage).toHaveURL(/section=data/);
    await snap(adminPage, 'data-section-type-overview');

    // Back to Roles restores the permission tables and the Save button.
    await subnav.getByRole('button', { name: 'Roles' }).click();
    await expect(adminPage.locator('.community-permissions-table')).toBeVisible();
    await expect(
      adminPage.getByRole('button', { name: /save changes/i }),
    ).toBeVisible();
    await snap(adminPage, 'roles-section-restored');
  });

  test('a reload on the Data section keeps the section (URL-carried)', async ({
    adminPage,
    snap,
  }) => {
    test.setTimeout(120_000);

    const enter = adminPage.getByRole('button', { name: /enter community/i });
    if (await enter.isVisible().catch(() => false)) {
      await enter.click();
    }
    await expect(adminPage.locator('.sidebar-nav')).toBeVisible({
      timeout: 30_000,
    });

    const gear = adminPage.locator('.community-settings-btn');
    await expect(gear).toBeVisible({ timeout: 30_000 });
    await gear.click();

    // Land on Data, then reload: the ?section= in the URL restores the tab.
    await adminPage.locator('.cs-subnav').getByRole('button', { name: 'Data' }).click();
    await expect(adminPage).toHaveURL(/section=data/);
    await adminPage.reload();
    await expect(
      adminPage.getByRole('heading', { name: 'Community Settings' }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(adminPage.locator('.data-types-table')).toBeVisible();
    await expect(adminPage.locator('.community-permissions-table')).toBeHidden();
    await snap(adminPage, 'data-section-after-reload');
  });
});
