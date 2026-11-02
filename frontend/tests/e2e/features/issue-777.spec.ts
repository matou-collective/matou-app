import { test, expect, Page } from './fixtures';
import { loginAs, jsonSessionHeaders } from '../utils/signed-auth';

// Feature (#777): the implementation plan draft gains a holding area for
// contributions that aren't yet assigned to a milestone. Planners can jot down
// work while drafting and place it in a milestone later. The area lists every
// top-level, non-archived contribution with no milestone_id and offers an
// "Add Contribution" entry that creates one directly into the holding area.
//
// Seeding goes through the backend API as the admin (lead + steward): a plan
// with one milestone, one contribution inside that milestone, and one
// contribution with NO milestone (the unassigned one). The page must show the
// unassigned one in the holding area and keep the milestone one out of it.

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

async function seedPlan(
  aid: string,
  projectTitle: string,
  milestoneTaskTitle: string,
  unassignedTaskTitle: string,
): Promise<void> {
  const proj = await api(aid, 'POST', '/projects', {
    title: projectTitle,
    description: 'Seeded by issue-777 feature spec.',
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

  // A contribution that IS in the milestone — must stay out of the holding area.
  await api(aid, 'POST', '/contributions', {
    project_id: proj.id,
    milestone_id: milestoneId,
    title: milestoneTaskTitle,
    description: 'In the milestone.',
    contribution_type: 'task',
    priority: 'medium',
    created_by: aid,
    objectives: ['belong to a milestone'],
    deliverables: ['a deliverable'],
    acceptance_criteria: ['stays in the milestone'],
  });

  // A contribution with NO milestone — the holding-area case this feature adds.
  await api(aid, 'POST', '/contributions', {
    project_id: proj.id,
    title: unassignedTaskTitle,
    description: 'Not placed in a milestone yet.',
    contribution_type: 'task',
    priority: 'medium',
    created_by: aid,
    objectives: ['wait to be placed'],
    deliverables: ['a deliverable'],
    acceptance_criteria: ['shows in the holding area'],
  });
}

async function openProject(page: Page, projectTitle: string) {
  await page.getByRole('button', { name: /enter community/i }).click({ timeout: 15_000 }).catch(() => {});
  await page.getByRole('button', { name: 'Projects' }).click();
  const projectCard = page.locator('.project-card', { hasText: projectTitle }).first();
  await expect(projectCard).toBeVisible({ timeout: 30_000 });
  await projectCard.click();
  await expect(page).toHaveURL(/\/dashboard\/projects\//, { timeout: 15_000 });
}

test.describe('unassigned contributions holding area (#777)', () => {
  test('a contribution with no milestone shows in the plan draft holding area', async ({ adminPage, snap }) => {
    test.setTimeout(300_000);
    const aid = await adminAid();
    await loginAs(adminPage);

    const runTag = Date.now().toString(36);
    const projectTitle = `Holding Area Project ${runTag}`;
    const milestoneTaskTitle = `Placed task ${runTag}`;
    const unassignedTaskTitle = `Unplaced task ${runTag}`;
    await seedPlan(aid, projectTitle, milestoneTaskTitle, unassignedTaskTitle);

    await openProject(adminPage, projectTitle);

    // The holding area exists and is labelled.
    const holding = adminPage.locator('.unassigned-section');
    await expect(holding).toBeVisible({ timeout: 30_000 });
    await expect(holding.locator('.unassigned-title')).toHaveText(/not yet in a milestone/i);

    // The unassigned contribution is listed in the holding area …
    await expect(holding.getByText(unassignedTaskTitle)).toBeVisible();
    // … and the milestone's contribution is NOT.
    await expect(holding.getByText(milestoneTaskTitle)).toHaveCount(0);

    // The entry point to add a contribution straight into the holding area.
    await expect(holding.getByRole('button', { name: /add contribution/i })).toBeVisible();

    await snap(adminPage, 'unassigned-contributions-holding-area');
  });
});
