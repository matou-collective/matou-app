import { test, expect, Page } from './fixtures';

// Feature (#314, rbac-tables 2/7): a "Projects & Contributions" permission table
// on the Roles & Permissions page. It has one column per project-and-
// contribution capability (11 columns, incl. the new View amounts / Assign
// steward / Assign lead) and — uniquely among the feature tables — its rows
// include the project-scoped roles (contributor / lead / steward) alongside the
// community roles.
//
// Enforcement lands in the backend (view_contribution_amounts strips budget/
// actuals on contribution reads; assign_project_steward/assign_project_lead gate
// the assign-role endpoint) and is proven by Go unit tests. This spec drives the
// UI table and demonstrates the amount-stripping through the API.

const API = 'http://localhost:9080/api/v1';

const EXPECTED_COLUMNS = [
  'Role',
  'Contribute',
  'Manage projects',
  'Review work',
  'Sign off',
  'Reward',
  'Submit completion',
  'Approve completion',
  'Archive',
  'View amounts',
  'Assign steward',
  'Assign lead',
];

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

test.describe('Projects & Contributions permission table (#314)', () => {
  test('table renders the 11 project columns with community + project role rows', async ({
    adminPage,
    snap,
  }) => {
    test.setTimeout(120_000);
    await openRolesPage(adminPage);

    const table = adminPage.locator('.roles-matrix.projects-roles');
    await expect(
      adminPage.getByRole('heading', { name: 'Projects & Contributions' }),
    ).toBeVisible();
    await expect(table).toBeVisible();
    await snap(adminPage, 'projects-table-default-policy');

    // Exactly the 11 project-and-contribution columns, in order.
    const headers = await table.locator('thead th').allTextContents();
    expect(headers.map((h) => h.trim())).toEqual(EXPECTED_COLUMNS);

    // Uniquely, project-scoped roles are rows here (the only table with them),
    // alongside the community roles.
    await expect(table.locator('tbody tr', { hasText: 'Founding Member' })).toBeVisible();
    await expect(table.locator('tbody tr', { hasText: 'Contributor' })).toBeVisible();
    await expect(table.locator('tbody tr', { hasText: 'Project Lead' })).toBeVisible();
    await expect(table.locator('tbody tr', { hasText: 'Project Steward' })).toBeVisible();
    await snap(adminPage, 'projects-table-role-rows');

    // Default grants: project_lead and project_steward hold View amounts; a
    // plain member does not.
    const viewCol = EXPECTED_COLUMNS.indexOf('View amounts');
    const leadRow = table.locator('tbody tr', { hasText: 'Project Lead' });
    const memberRow = table.locator('tbody tr', { hasText: 'Member' }).first();
    await expect(
      leadRow.locator('td').nth(viewCol).locator('.q-toggle'),
    ).toHaveAttribute('aria-checked', 'true');
    await expect(
      memberRow.locator('td').nth(viewCol).locator('.q-toggle'),
    ).toHaveAttribute('aria-checked', 'false');

    // Reward is community-only: disabled on a project role (Contributor).
    const rewardCol = EXPECTED_COLUMNS.indexOf('Reward');
    const contributorRow = table.locator('tbody tr', { hasText: 'Contributor' });
    await expect(
      contributorRow.locator('td').nth(rewardCol).locator('.q-toggle'),
    ).toHaveAttribute('aria-disabled', 'true');
    await snap(adminPage, 'projects-table-reward-disabled-on-project-role');
  });

  test('budget/actuals are stripped from callers without view_contribution_amounts', async () => {
    const admin = await adminAid();

    // Seed a project + a contribution carrying a budget, assigned to a chosen
    // contributor AID.
    const proj = await apiJson(admin, 'POST', '/projects', {
      title: 'Amounts Demo',
      description: 'A project for the amounts test',
      created_by: admin,
    });
    expect(proj.status, JSON.stringify(proj.body)).toBe(201);
    const projectId = proj.body.id as string;

    const assignee = 'Eassignee_' + Date.now();
    const contrib = await apiJson(admin, 'POST', '/contributions', {
      project_id: projectId,
      title: 'Do the mahi',
      description: 'A budgeted contribution',
      objectives: ['obj'],
      deliverables: ['del'],
      acceptance_criteria: ['crit'],
      budget: '5000',
      assigned_contributor_id: assignee,
      created_by: admin,
    });
    expect(contrib.status, JSON.stringify(contrib.body)).toBe(201);
    const contribId = contrib.body.id as string;

    // The admin (Founding Member) — note: view_contribution_amounts defaults to
    // the project roles, so a plain read by an arbitrary non-project caller must
    // be stripped. A caller with no roles sees no budget.
    const stranger = await apiJson('Estranger_' + Date.now(), 'GET', `/contributions/${contribId}`);
    expect(stranger.status).toBe(200);
    expect(stranger.body.budget ?? '').toBe('');

    // The assigned contributor always sees the amounts on their own
    // contribution, regardless of role.
    const asAssignee = await apiJson(assignee, 'GET', `/contributions/${contribId}`);
    expect(asAssignee.status).toBe(200);
    expect(asAssignee.body.budget).toBe('5000');
  });
});
