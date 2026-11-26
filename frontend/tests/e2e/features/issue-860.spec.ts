import { test, expect, Page } from './fixtures';

// Feature (#860): the "Archived contributions" section on the project page can
// grow extremely long. It now renders collapsed by default — only its header
// and count show — and expands/collapses when the header is clicked. The count
// stays visible while collapsed.
//
// Seeding goes through the backend API as the admin: a project with a plan, a
// milestone and one contribution, which is then archived via the API so the
// archived section has something to show.

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
    description: 'Seeded by issue-860 feature spec.',
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
    description: 'Archived to populate the archived list.',
    contribution_type: 'task',
    priority: 'medium',
    created_by: aid,
    objectives: ['appear in the archived list'],
    deliverables: ['a deliverable'],
    acceptance_criteria: ['hidden until the section is expanded'],
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

test.describe('archived contributions collapsed by default (#860)', () => {
  test('the archived section is collapsed by default and toggles on click', async ({ adminPage, snap }) => {
    test.setTimeout(300_000);
    const aid = await adminAid();
    const runTag = Date.now().toString(36);
    const projectTitle = `Collapse Project ${runTag}`;
    const taskTitle = `Archived task ${runTag}`;
    await seedArchived(aid, projectTitle, taskTitle);

    await openProject(adminPage, projectTitle);

    const archived = adminPage.getByTestId('archived-contributions');
    await expect(archived).toBeVisible({ timeout: 30_000 });

    // Collapsed by default: header + count visible, individual rows hidden.
    const toggle = archived.getByTestId('archived-contributions-toggle');
    await expect(toggle).toBeVisible();
    await expect(toggle.getByText('Archived contributions')).toBeVisible();
    await expect(archived.getByTestId('archived-list')).toHaveCount(0);
    await expect(archived.getByText(taskTitle)).toHaveCount(0);
    await snap(adminPage, 'archived-collapsed-default');

    // Expand: rows become visible.
    await toggle.click();
    await expect(archived.getByTestId('archived-list')).toBeVisible();
    await expect(archived.getByText(taskTitle)).toBeVisible();
    await snap(adminPage, 'archived-expanded');

    // Collapse again: rows hidden, header still shows.
    await toggle.click();
    await expect(archived.getByTestId('archived-list')).toHaveCount(0);
    await expect(toggle.getByText('Archived contributions')).toBeVisible();
    await snap(adminPage, 'archived-collapsed-again');
  });
});
