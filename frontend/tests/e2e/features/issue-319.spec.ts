import { test, expect, Page } from './fixtures';

// Feature (#319, rbac-tables 7/7): a read-only "Roles overview" table on the
// Roles & Permissions page. One row per role (community + project scope,
// builtin + custom), one column per feature area, each cell summarizing that
// role's grants in that area as a granted/total count. No toggles. The overview
// reflects a grant change made in a feature table below immediately (it reads
// the same live editable state), before any save.

const CUSTOM_ROLE_NAME = 'Kaitiaki';
const CUSTOM_ROLE_ID = 'kaitiaki';

// Login lands on the "Enter Community" welcome screen or straight on the
// dashboard; get to the Roles & Permissions page either way.
async function openRolesPage(page: Page): Promise<void> {
  const enter = page.getByRole('button', { name: /enter community/i });
  if (await enter.isVisible().catch(() => false)) {
    await enter.click();
  }
  const rolesNav = page.locator('.nav-item', { hasText: 'Roles' });
  await expect(rolesNav).toBeVisible({ timeout: 30_000 });
  await rolesNav.click();
  await expect(page.getByRole('heading', { name: 'Roles & Permissions' })).toBeVisible();
}

test.describe('Roles overview table (#319)', () => {
  test('overview lists every role by feature area and reflects a live grant edit', async ({
    adminPage,
    snap,
  }) => {
    test.setTimeout(120_000);
    await openRolesPage(adminPage);

    const overview = adminPage.locator('.roles-matrix.roles-overview');
    await expect(adminPage.getByRole('heading', { name: 'Roles overview' })).toBeVisible();
    await expect(overview).toBeVisible();

    // One column per feature area (from the backend capability metadata).
    const headers = await overview.locator('thead th').allTextContents();
    expect(headers.map((h) => h.trim())).toEqual([
      'Role',
      'Projects & Contributions',
      'Proposals',
      'Chat',
      'Notices',
      'Community',
    ]);

    // Builtin roles of both scopes appear (community founder + project steward).
    await expect(overview.locator('tbody tr', { hasText: 'Founding Member' })).toBeVisible();
    await expect(overview.locator('tbody tr', { hasText: 'Project Steward' })).toBeVisible();
    await snap(adminPage, 'overview-default-policy');

    // Add a custom community role with no starting grants.
    await adminPage.locator('.community-section').getByRole('button', { name: 'New role' }).click();
    const dialog = adminPage.getByRole('dialog');
    await expect(dialog.getByText('New community role')).toBeVisible();
    await dialog.getByLabel('Role name').fill(CUSTOM_ROLE_NAME);
    await dialog.getByRole('button', { name: 'Add role' }).click();

    // The overview immediately gains a row for the new role, 0/N in Proposals.
    const proposalsCell = overview.locator(
      `[data-role="${CUSTOM_ROLE_ID}"][data-group="Proposals"]`,
    );
    await expect(overview.locator('tbody tr', { hasText: CUSTOM_ROLE_NAME })).toBeVisible();
    await expect(proposalsCell.locator('.overview-count')).toHaveText(/^0\//);
    await snap(adminPage, 'overview-new-custom-role');

    // Toggle a Proposals capability (Governance) ON for the custom role in the
    // Proposals feature table (#315 owns that column now), then confirm the
    // overview count rose — no save.
    const proposalsTable = adminPage.locator('.roles-matrix.proposals-table');
    const capHeaders = await proposalsTable.locator('thead th').allTextContents();
    const govCol = capHeaders.findIndex((h) => h.trim().startsWith('Governance'));
    expect(govCol).toBeGreaterThan(0);
    const customRow = proposalsTable.locator('tbody tr', { hasText: CUSTOM_ROLE_NAME });
    await customRow.locator('td').nth(govCol).locator('.q-toggle').click();

    await expect(proposalsCell.locator('.overview-count')).toHaveText(/^1\//);
    await expect(proposalsCell.locator('.overview-count.has-grants')).toBeVisible();
    await snap(adminPage, 'overview-reflects-live-grant-edit');
  });
});
