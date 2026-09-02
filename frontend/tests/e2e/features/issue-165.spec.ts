import { test, expect, Page } from './fixtures';

// Feature (#165): the Roles & Permissions page is split into two tables —
// Community roles (who you are; full capability set) and Project roles (what
// you hold on one project; project-scoped capabilities only). The project
// table carries the `contributor` row (per the triage ruling it lives here
// only, not in the community table), and community-only capability toggles are
// disabled on project roles. The backend rejects (400) a project role granted
// a community-only capability.
//
// UI + policy-model only — no enforcement change (that is #166).

const API = 'http://localhost:9080/api/v1';

async function adminAid(): Promise<string> {
  const res = await fetch(`${API}/identity`);
  const body = await res.json();
  if (!body?.aid) throw new Error(`admin backend has no identity: ${JSON.stringify(body)}`);
  return body.aid as string;
}

async function apiJson(aid: string, method: string, route: string, body?: unknown) {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-User-AID': aid },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// Log in leaves the app on the "Enter Community" welcome screen or already on
// the dashboard; get to the Roles & Permissions page either way.
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

test.describe('Roles & Permissions split: community vs project tables (#165)', () => {
  test('two scoped tables render, contributor lives on the project table, community-only toggles disabled', async ({
    adminPage,
    snap,
  }) => {
    test.setTimeout(120_000);
    await openRolesPage(adminPage);

    const community = adminPage.locator('.roles-matrix.community-roles');
    const project = adminPage.locator('.roles-matrix.project-roles');

    // Both section headings present.
    await expect(adminPage.getByRole('heading', { name: 'Community roles' })).toBeVisible();
    await expect(adminPage.getByRole('heading', { name: 'Project roles' })).toBeVisible();
    await snap(adminPage, 'both-tables-default-policy');

    // Community table: no contributor row (it lives on the project side only).
    await expect(community.getByText('Founding Member')).toBeVisible();
    await expect(community.getByText('Contributor')).toHaveCount(0);

    // Project table: contributor / project_lead / project_steward.
    await expect(project.locator('tbody tr', { hasText: 'Contributor' })).toBeVisible();
    await expect(project.locator('tbody tr', { hasText: 'Project Lead' })).toBeVisible();
    await expect(project.locator('tbody tr', { hasText: 'Project Steward' })).toBeVisible();
    await snap(adminPage, 'project-table-with-contributor-row');

    // A community-only capability (Manage roles) is a disabled toggle on a
    // project role.
    const headers = await project.locator('thead th').allTextContents();
    const manageRolesCol = headers.findIndex((h) => h.trim().startsWith('Manage roles'));
    expect(manageRolesCol).toBeGreaterThan(0);
    const contributorRow = project.locator('tbody tr', { hasText: 'Contributor' });
    await expect(
      contributorRow.locator('td').nth(manageRolesCol).locator('.q-toggle'),
    ).toHaveAttribute('aria-disabled', 'true');
    await snap(adminPage, 'community-only-toggle-disabled-on-project-role');

    // New-role dialog for a project role.
    await adminPage.locator('.project-section').getByRole('button', { name: 'New role' }).click();
    const dialog = adminPage.getByRole('dialog');
    await expect(dialog.getByText('New project role')).toBeVisible();
    await dialog.getByLabel('Role name').fill('Kaimahi');
    await snap(adminPage, 'new-project-role-dialog');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });

  test('backend rejects a project role granted a community-only capability (400)', async () => {
    const aid = await adminAid();
    const current = await apiJson(aid, 'GET', '/role-policy');
    expect(current.status).toBe(200);

    const grants = { ...current.body.policy.grants } as Record<string, string[]>;
    // project_lead is a project role; manage_governance is community-only.
    grants['project_lead'] = [...(grants['project_lead'] ?? []), 'manage_governance'];

    const rejected = await apiJson(aid, 'PUT', '/role-policy', {
      version: current.body.policy.version,
      roles: current.body.policy.roles,
      grants,
    });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(400);
    expect(String(rejected.body?.error)).toMatch(/community-only capability/i);
  });
});
