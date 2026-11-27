import { test, expect, Page } from './fixtures';
import { loginAs, jsonSessionHeaders } from '../utils/signed-auth';

// Feature (#751): editing a sub-contribution (or a top-level contribution)
// while building an implementation plan must update the UI immediately — the
// reporter had to leave the project and come back before the new values showed.
//
// Root cause: the save handler refetched only the implementation plan. The
// detail dialog's sub-list is backed by the flat project-contributions list,
// which the handler never refreshed, so the edited sub kept its old values
// until a route re-enter refetched that list. The fix routes save (and archive)
// through one shared refresh that refetches BOTH lists and re-syncs the open
// dialog.
//
// Seeding: the UI path to a parent-with-sub inside a plan is the whole project
// lifecycle, so we drive the backend API as the admin to stand one up quickly,
// then exercise the edit-sub UI and assert the sub-list updates in place.

const API = 'http://localhost:9080/api/v1';

async function adminAid(): Promise<string> {
  const res = await fetch(`${API}/identity`);
  const body = await res.json();
  if (!body?.aid) throw new Error(`admin backend has no identity: ${JSON.stringify(body)}`);
  return body.aid as string;
}

async function api(aid: string, method: string, route: string, body?: unknown) {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: jsonSessionHeaders(aid),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${route} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : undefined;
}

// Stand up project → plan → milestone → parent contribution → sub-contribution,
// leaving the plan unsigned so the lead can still edit its contributions.
async function seedPlanWithSub(
  aid: string,
  projectTitle: string,
  parentTitle: string,
  subTitle: string,
): Promise<{ projectId: string }> {
  const proj = await api(aid, 'POST', '/projects', {
    title: projectTitle,
    description: 'Seeded by issue-751 feature spec to demo live sub-contribution edits.',
    created_by: aid,
  });
  const plan = await api(aid, 'POST', '/implementation-plans', {
    project_id: proj.id,
    total_budget: '100',
    project_lead: aid,
    project_steward_id: aid,
  });
  const planWithMs = await api(aid, 'POST', `/implementation-plans/${plan.id}/milestones`, {
    title: 'Only milestone',
    duration: '1 week',
  });
  const milestoneId = (planWithMs.milestones ?? planWithMs.Milestones)[0].milestone_id;

  const parent = await api(aid, 'POST', '/contributions', {
    project_id: proj.id,
    milestone_id: milestoneId,
    title: parentTitle,
    description: 'Parent contribution with one sub.',
    contribution_type: 'task',
    priority: 'medium',
    created_by: aid,
    objectives: ['coordinate the work'],
    deliverables: ['a completed parent'],
    acceptance_criteria: ['parent done'],
    deadline: '2027-01-01',
  });

  // Create the sub-contribution linked to the parent (parent_contribution set).
  await api(aid, 'POST', '/contributions', {
    project_id: proj.id,
    milestone_id: milestoneId,
    parent_contribution: parent.id,
    title: subTitle,
    description: 'Sub-contribution whose edit should show immediately.',
    contribution_type: 'task',
    priority: 'medium',
    created_by: aid,
    objectives: ['do the sub work'],
    deliverables: ['a completed sub'],
    acceptance_criteria: ['sub done'],
    deadline: '2027-01-01',
  });

  return { projectId: proj.id };
}

async function openParentContributionDetail(page: Page, projectTitle: string, parentTitle: string) {
  const enterBtn = page.getByRole('button', { name: /enter community/i });
  await enterBtn.click({ timeout: 15_000 }).catch(() => {});
  await page.getByRole('button', { name: 'Projects' }).click();

  const projectCard = page.locator('.project-card', { hasText: projectTitle }).first();
  await expect(projectCard).toBeVisible({ timeout: 30_000 });
  await projectCard.click();
  await expect(page).toHaveURL(/\/dashboard\/projects\//, { timeout: 15_000 });

  // Expand the milestone if its contributions are collapsed, then open the
  // parent contribution's detail dialog.
  const parentCard = page.locator('.contribution-compact').filter({ hasText: parentTitle });
  if (!(await parentCard.first().isVisible().catch(() => false))) {
    await page.locator('.milestone-header').first().click().catch(() => {});
  }
  await expect(parentCard.first()).toBeVisible({ timeout: 15_000 });
  await parentCard.first().click();
  await expect(page.locator('.q-dialog')).toBeVisible({ timeout: 10_000 });
}

test.describe('sub-contribution edit updates the UI in place (#751)', () => {
  test('editing a sub-contribution shows the new title immediately, no re-navigation', async ({
    adminPage,
    snap,
  }) => {
    test.setTimeout(300_000);
    const aid = await adminAid();
    await loginAs(adminPage); // signed-auth session so API calls act as the admin

    const runTag = Date.now().toString(36);
    const projectTitle = `Plan Edit Project ${runTag}`;
    const parentTitle = `Coordinate hapu liaison ${runTag}`;
    const subTitle = `Draft consultation flyer ${runTag}`;
    const subTitleEdited = `${subTitle} (revised)`;
    await seedPlanWithSub(aid, projectTitle, parentTitle, subTitle);

    await openParentContributionDetail(adminPage, projectTitle, parentTitle);
    const dialog = adminPage.locator('.q-dialog');

    // The parent's detail dialog lists the sub-contribution with its seeded title.
    const subItem = dialog.locator('.sub-item').filter({ hasText: subTitle });
    await expect(subItem.first()).toBeVisible({ timeout: 15_000 });
    await snap(adminPage, 'parent-detail-with-sub');

    // Open the sub's edit form from the sub-list pencil button.
    await subItem.first().locator('button').filter({ has: adminPage.locator('.q-icon') }).last().click();
    const editForm = adminPage.locator('.q-dialog').filter({ hasText: 'Edit Contribution' });
    await expect(editForm).toBeVisible({ timeout: 10_000 });

    // Change the title and save.
    const titleInput = editForm.getByLabel('Title *');
    await titleInput.fill(subTitleEdited);
    await snap(adminPage, 'sub-edit-form-new-title');
    await editForm.getByRole('button', { name: /Save Changes/i }).click();
    await expect(adminPage.getByText(/Contribution updated/i)).toBeVisible({ timeout: 10_000 });

    // Back on the still-open parent detail dialog, the sub-list reflects the new
    // title immediately — without leaving the project and coming back.
    const detailDialog = adminPage.locator('.q-dialog').filter({ hasText: 'Sub-Contributions' });
    await expect(detailDialog.locator('.sub-item').filter({ hasText: subTitleEdited }).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(detailDialog.locator('.sub-item-title', { hasText: subTitle }).filter({ hasNotText: '(revised)' })).toHaveCount(0);
    await snap(adminPage, 'sub-list-updated-in-place');
  });
});
