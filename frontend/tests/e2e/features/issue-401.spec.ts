import { test, expect, Page } from './fixtures';

// Feature (#401, #396 slice 4): the schema editor in Community Settings → Data.
//   - The Data section lists every registered type; each renders its fields with
//     core fields locked (name/type immutable, no delete) behind a lock icon +
//     tooltip, and custom fields add/edit/removable.
//   - An admin adds a custom field to the SharedProfile type, saves per-type via
//     PUT /api/v1/types/{name}, and after a reload the field is still there
//     (persisted server-side + boot hydration, #400).
//   - Editing gates on manage_community_settings — the same capability the PUT
//     route enforces; a member without it never reaches this page (#318 gate).

async function openDataSection(page: Page): Promise<void> {
  const enter = page.getByRole('button', { name: /enter community/i });
  if (await enter.isVisible().catch(() => false)) {
    await enter.click();
  }
  const gear = page.locator('.community-settings-btn');
  await expect(gear).toBeVisible({ timeout: 30_000 });
  await gear.click();
  await expect(
    page.getByRole('heading', { name: 'Community Settings' }),
  ).toBeVisible();
  await page.locator('.cs-subnav').getByRole('button', { name: 'Data' }).click();
  await expect(page).toHaveURL(/section=data/);
}

test.describe('Schema editor (#401)', () => {
  test('admin adds a custom field to profiles, saves, and it survives a reload; core fields are locked', async ({
    adminPage,
    snap,
  }) => {
    test.setTimeout(180_000);

    await openDataSection(adminPage);

    // The SharedProfile editor section renders, with core fields locked.
    const profile = adminPage.locator(
      '.schema-type-section[data-type="SharedProfile"]',
    );
    await expect(profile).toBeVisible({ timeout: 30_000 });

    // A core field (aid) shows a lock icon and cannot be removed/edited — the
    // same locked pattern as the manage_roles cells on the Roles tables.
    const coreRow = profile.locator('tr[data-field="aid"]');
    await expect(coreRow).toBeVisible();
    await expect(coreRow.locator('.locked-icon')).toBeVisible();
    await expect(coreRow.locator('.remove-field-btn')).toHaveCount(0);
    await expect(coreRow.locator('.core-badge')).toBeVisible();
    await snap(adminPage, 'schema-editor-core-locked');

    // Add a custom field. A timestamped name keeps reruns from colliding with a
    // field a previous run already persisted into this org's schema.
    const fieldName = `e2e_field_${Date.now()}`;
    await profile.locator('.add-field-btn').click();

    const dialog = adminPage.locator('.q-dialog:has(.apply-field-btn)');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Field name').fill(fieldName);
    await snap(adminPage, 'schema-editor-add-field-dialog');
    await dialog.locator('.apply-field-btn').click();

    // The new custom field row appears in the SharedProfile table (editable).
    const newRow = profile.locator(`tr[data-field="${fieldName}"]`);
    await expect(newRow).toBeVisible();
    await expect(newRow.locator('.remove-field-btn')).toBeVisible();

    // Save this type: PUT /api/v1/types/SharedProfile.
    await profile.locator('.save-type-btn').click();
    await expect(
      adminPage.locator('.q-notification').filter({ hasText: /Saved/ }),
    ).toBeVisible({ timeout: 20_000 });
    await snap(adminPage, 'schema-editor-saved');

    // Reload: the web router guard bounces the deep link to the Welcome overlay
    // (documented in #398), so re-enter the community and re-open Data — the
    // custom field is still there, proving it persisted server-side.
    await adminPage.reload();
    await openDataSection(adminPage);
    await expect(
      adminPage
        .locator('.schema-type-section[data-type="SharedProfile"]')
        .locator(`tr[data-field="${fieldName}"]`),
    ).toBeVisible({ timeout: 30_000 });
    await snap(adminPage, 'schema-editor-field-persisted');
  });
});
