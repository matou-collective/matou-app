import { test, expect, Page } from './fixtures';

// Feature (#749): the project management controls now match the backend's
// enforced rule, so a button is never shown that the backend would refuse with
// "insufficient permissions".
//
//  - The community-wide fast-path (manage any project) is granted ONLY to
//    Operations Steward / Founding Member. Other *-Steward credentials
//    (Technical / Financial / Cultural / Community) no longer count as full
//    community admins — they fall through to the per-project
//    project_lead_id / project_steward_id match, exactly as the backend does.
//  - The assigned project steward may assign roles (assign_project_role =
//    stewardScope); a bare lead may not.
//  - The "Delete Project" control honestly reads "Archive Project" (it calls
//    the archive endpoint, not a destructive delete).
//
// The precise role→permission mapping is locked by the Vitest unit spec
// (tests/scripts/issue-749-project-permissions.test.ts) and the backend
// RBAC test (TestRequireProjectAction_LeadScopedToOwnProject). This spec
// captures the corrected UI for the reviewer: the admin (Founding Member) sees
// and uses the controls, and the danger-zone label reflects that it archives.

const API = 'http://localhost:9080/api/v1';

async function adminAid(): Promise<string> {
  const res = await fetch(`${API}/identity`);
  const body = await res.json();
  if (!body?.aid) throw new Error(`admin backend has no identity: ${JSON.stringify(body)}`);
  return body.aid as string;
}

async function createProject(aid: string, title: string): Promise<string> {
  const res = await fetch(`${API}/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-AID': aid },
    body: JSON.stringify({ title, description: 'Permission-visibility test (#749)', created_by: aid }),
  });
  const body = await res.json().catch(() => null);
  expect(body?.id, `project create: ${JSON.stringify(body)}`).toBeTruthy();
  return body.id as string;
}

async function enterCommunity(page: Page): Promise<void> {
  await page.goto('/');
  await page
    .getByRole('button', { name: /enter community/i })
    .click({ timeout: 15_000 })
    .catch(() => {});
}

test.describe('project management controls match backend permissions (#749)', () => {
  test('a community admin sees Assign Lead/Steward and the honest Archive Project label', async ({
    adminPage,
    snap,
  }) => {
    test.setTimeout(120_000);

    const admin = await adminAid();
    const projectId = await createProject(admin, 'Marae Restoration (#749)');

    await enterCommunity(adminPage);
    await adminPage.goto(`/#/projects/${projectId}`).catch(() => {});
    // Fall back to in-app navigation if the hash route did not resolve.
    if (!(await adminPage.getByText('Marae Restoration (#749)').first().isVisible().catch(() => false))) {
      await adminPage.getByRole('button', { name: /projects/i }).first().click().catch(() => {});
      await adminPage.getByText('Marae Restoration (#749)').first().click({ timeout: 15_000 }).catch(() => {});
    }

    // The admin (Founding Member) is granted the community-wide fast-path, so
    // the assign controls render on a project they are not assigned to.
    await expect(adminPage.getByRole('button', { name: /assign lead/i })).toBeVisible({
      timeout: 30_000,
    });
    await expect(adminPage.getByRole('button', { name: /assign steward/i })).toBeVisible();
    await snap(adminPage, 'admin-sees-assign-controls');

    // Open the edit dialog and confirm the danger-zone control now reads
    // "Archive Project" rather than the misleading "Delete Project".
    await adminPage.getByRole('button', { name: /^edit$/i }).click({ timeout: 15_000 });
    await expect(adminPage.getByRole('button', { name: /archive project/i })).toBeVisible({
      timeout: 15_000,
    });
    await expect(adminPage.getByRole('button', { name: /delete project/i })).toHaveCount(0);
    await snap(adminPage, 'admin-archive-project-label');
  });

  test('a non-admin member session carries no project-creation control', async ({
    memberPage,
    snap,
  }) => {
    await enterCommunity(memberPage);
    await memberPage.getByRole('button', { name: /projects/i }).first().click().catch(() => {});
    await expect(memberPage.getByRole('heading', { name: 'Projects' })).toBeVisible({
      timeout: 30_000,
    });
    // A plain member is not a community admin, so the "+ New Project" control
    // is absent — the same narrowing that hides the management controls on
    // projects they are not assigned to.
    await expect(memberPage.getByRole('button', { name: /new project/i })).toHaveCount(0);
    await snap(memberPage, 'member-projects-view');
  });
});
