import { test, expect, Page } from './fixtures';

// Feature (#846): an archived contribution can be restored. Archiving records
// the status the contribution had; a project lead/steward/admin sees an
// "Archived contributions" list on the project page with a Restore action, and
// restoring puts the contribution (and the sub-contributions archived with it)
// back to where they were.
//
// Seeding goes through the backend API as the admin: a project with a plan, a
// milestone and one contribution, which is then archived via the API.

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
    headers: { 'Content-Type': 'application/json', 'X-User-AID': aid },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : undefined;
}

async function seedArchived(aid: string, projectTitle: string, taskTitle: string) {
  const proj = await api(aid, 'POST', '/projects', {
    title: projectTitle,
    description: 'Seeded by issue-846 feature spec.',
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
  const contrib = await api(aid, 'POST', '/contributions', {
    project_id: proj.id,
    milestone_id: milestoneId,
    title: taskTitle,
    description: 'Archived by mistake.',
    contribution_type: 'task',
    priority: 'medium',
    created_by: aid,
    objectives: ['be restored'],
    deliverables: ['a deliverable'],
    acceptance_criteria: ['comes back after restore'],
  });
  await api(aid, 'POST', `/contributions/${contrib.id}/archive`);
  return contrib.id as string;
}

async function openProject(page: Page, projectTitle: string) {
  await page.getByRole('button', { name: /enter community/i }).click({ timeout: 15_000 }).catch(() => {});
  await page.getByRole('button', { name: 'Projects' }).click();
  const projectCard = page.locator('.project-card', { hasText: projectTitle }).first();
  await expect(projectCard).toBeVisible({ timeout: 30_000 });
  await projectCard.click();
  await expect(page).toHaveURL(/\/dashboard\/projects\//, { timeout: 15_000 });
}

test.describe('restore archived contributions (#846)', () => {
  test('an archived contribution can be restored from the project page', async ({ adminPage, snap }) => {
    test.setTimeout(300_000);
    const aid = await adminAid();
    const runTag = Date.now().toString(36);
    const projectTitle = `Restore Project ${runTag}`;
    const taskTitle = `Archived task ${runTag}`;
    const contribId = await seedArchived(aid, projectTitle, taskTitle);

    await openProject(adminPage, projectTitle);

    const archived = adminPage.getByTestId('archived-contributions');
    await expect(archived).toBeVisible({ timeout: 30_000 });
    await expect(archived.getByText(taskTitle)).toBeVisible();
    await snap(adminPage, 'archived-list-with-restore');

    await archived.getByTestId('restore-contribution').click();

    // Back in the plan; the archived list is gone.
    await expect(adminPage.getByTestId('archived-contributions')).toHaveCount(0, { timeout: 15_000 });
    await expect(adminPage.getByText(taskTitle).first()).toBeVisible();
    await snap(adminPage, 'contribution-restored');

    const restored = await api(aid, 'GET', `/contributions/${contribId}`);
    expect(restored.status).not.toBe('archived');
  });
});
