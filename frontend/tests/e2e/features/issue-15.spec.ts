import { test, expect } from './fixtures';
import { loginAs, jsonSessionHeaders } from '../utils/signed-auth';

// Feature (#15): completed projects are hidden from the project lists by
// default. "My Projects" gets a Completed toggle alongside Archived; the
// "All Projects" default filter hides completed until the Completed pill is
// clicked.
//
// Seeding: the UI path to a completed project is the full contribution
// lifecycle, so we drive the backend API directly (as the admin) to walk one
// project through it, and create a second project that stays visible.

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

// Walk a fresh project through plan → milestone → contribution lifecycle →
// plan sign-off → completion approval, ending at status "completed".
async function seedCompletedProject(aid: string, title: string): Promise<string> {
  const proj = await api(aid, 'POST', '/projects', {
    title,
    description: 'Seeded by issue-15 feature spec, then completed via the API lifecycle.',
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
    title: 'Only contribution',
    description: 'Single seeded contribution.',
    contribution_type: 'task',
    priority: 'medium',
    created_by: aid,
    objectives: ['demonstrate completion'],
    deliverables: ['a completed project'],
    acceptance_criteria: ['project reaches completed status'],
    deadline: '2027-01-01',
  });

  await api(aid, 'POST', `/contributions/${contrib.id}/confirm`);
  await api(aid, 'POST', `/contributions/${contrib.id}/assign`, { user_id: aid });
  await api(aid, 'POST', `/contributions/${contrib.id}/submit-evidence`, {
    completion_notes: 'Done — seeded lifecycle.',
  });
  await api(aid, 'POST', `/contributions/${contrib.id}/review`, {
    decision: 'approved',
    review_notes: 'Approved by seeding.',
  });
  await api(aid, 'POST', `/implementation-plans/${plan.id}/sign-off`);
  await api(aid, 'POST', `/contributions/${contrib.id}/sign-off`);
  await api(aid, 'POST', `/projects/${proj.id}/submit-completion`);
  await api(aid, 'POST', `/projects/${proj.id}/approve-completion`);

  const done = await api(aid, 'GET', `/projects/${proj.id}`);
  const status = done.status ?? done.project?.status;
  if (status !== 'completed') throw new Error(`seed ended at status ${status}, wanted completed`);
  return proj.id;
}

test.describe('hide completed projects by default (#15)', () => {
  test('completed projects hidden by default, revealed by Completed toggle and filter', async ({
    adminPage,
    snap,
  }) => {
    test.setTimeout(300_000);
    const aid = await adminAid();
    await loginAs(adminPage); // signed-auth session so API calls act as the admin

    // Unique per run so leftovers from an interrupted earlier run can't
    // collide with this run's assertions.
    const runTag = Date.now().toString(36);
    const completedTitle = `Whare Renovation (finished ${runTag})`;
    const activeTitle = `Kai Garden Working Bee ${runTag}`;
    await seedCompletedProject(aid, completedTitle);
    await api(aid, 'POST', '/projects', {
      title: activeTitle,
      description: 'Stays in progress — should always be visible by default.',
      created_by: aid,
    });

    // Get past the welcome splash (if showing) and open Projects from the
    // sidebar — the app is hash-routed, so a bare /projects URL won't land.
    const enterBtn = adminPage.getByRole('button', { name: /enter community/i });
    await enterBtn.click({ timeout: 15_000 }).catch(() => {});
    await adminPage.getByRole('button', { name: 'Projects' }).click();

    // Default view: the in-progress project is listed, the completed one is not.
    await expect(adminPage.getByText(activeTitle).first()).toBeVisible({ timeout: 30_000 });
    await expect(adminPage.getByText(completedTitle)).toHaveCount(0);
    await snap(adminPage, 'default-hides-completed');

    // "My Projects" Completed toggle reveals only the completed project.
    const myProjects = adminPage.locator('section.my-projects-section');
    await myProjects.getByRole('button', { name: 'Completed' }).click();
    await expect(myProjects.getByText(completedTitle).first()).toBeVisible();
    await expect(myProjects.getByText(activeTitle)).toHaveCount(0);
    await snap(adminPage, 'my-projects-completed-toggle');

    // Back to default.
    await myProjects.getByRole('button', { name: 'Completed' }).click();
    await expect(myProjects.getByText(activeTitle).first()).toBeVisible();

    // "All Projects" Completed filter pill reveals it there too.
    const allProjects = adminPage.locator('section.all-projects-section');
    await allProjects.getByRole('button', { name: 'Completed' }).click();
    await expect(allProjects.getByText(completedTitle).first()).toBeVisible();
    await snap(adminPage, 'all-projects-completed-filter');
  });
});
