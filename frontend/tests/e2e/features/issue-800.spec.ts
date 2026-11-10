import { test, expect, Page } from './fixtures';
import { loginAs, jsonSessionHeaders } from '../utils/signed-auth';

// Feature (#800): approving a sub-contribution that has no assignee must land
// it in `confirmed`, not `assigned`. The old behaviour forced every approved
// sub to `assigned`, which read as "someone is on this" even when nobody was —
// the reporter saw a sub with no assignee showing the Assigned badge after
// approval. Cherese's ruling: "It should be confirmed but only when there is no
// assignee." A sub that does carry an assignee still lands in `assigned`.
//
// Seeding: the UI path to a parent-with-sub inside a plan is the whole project
// lifecycle, so we drive the backend API as the admin to stand one up quickly,
// leaving the parent (and therefore the inherited child) unassigned, then
// approve the sub through the UI and assert its status badge.

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
// all left UNASSIGNED so the approved sub has no contributor to inherit. The
// plan is left unsigned so the lead can still approve its sub-contributions.
async function seedPlanWithUnassignedSub(
  aid: string,
  projectTitle: string,
  parentTitle: string,
  subTitle: string,
): Promise<void> {
  const proj = await api(aid, 'POST', '/projects', {
    title: projectTitle,
    description: 'Seeded by issue-800 feature spec to demo unassigned-sub approval.',
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

  // Parent left unassigned so the auto-inherit at child creation seeds no
  // assignee on the sub.
  const parent = await api(aid, 'POST', '/contributions', {
    project_id: proj.id,
    milestone_id: milestoneId,
    title: parentTitle,
    description: 'Parent contribution with one unassigned sub.',
    contribution_type: 'task',
    priority: 'medium',
    created_by: aid,
    objectives: ['coordinate the work'],
    deliverables: ['a completed parent'],
    acceptance_criteria: ['parent done'],
    deadline: '2027-01-01',
  });

  await api(aid, 'POST', '/contributions', {
    project_id: proj.id,
    milestone_id: milestoneId,
    parent_contribution: parent.id,
    title: subTitle,
    description: 'Sub-contribution with no assignee — approval must land it in confirmed.',
    contribution_type: 'task',
    priority: 'medium',
    created_by: aid,
    objectives: ['do the sub work'],
    deliverables: ['a completed sub'],
    acceptance_criteria: ['sub done'],
    deadline: '2027-01-01',
  });
}

async function openParentContributionDetail(page: Page, projectTitle: string, parentTitle: string) {
  const enterBtn = page.getByRole('button', { name: /enter community/i });
  await enterBtn.click({ timeout: 15_000 }).catch(() => {});
  await page.getByRole('button', { name: 'Projects' }).click();

  const projectCard = page.locator('.project-card', { hasText: projectTitle }).first();
  await expect(projectCard).toBeVisible({ timeout: 30_000 });
  await projectCard.click();
  await expect(page).toHaveURL(/\/dashboard\/projects\//, { timeout: 15_000 });

  const parentCard = page.locator('.contribution-compact').filter({ hasText: parentTitle });
  if (!(await parentCard.first().isVisible().catch(() => false))) {
    await page.locator('.milestone-header').first().click().catch(() => {});
  }
  await expect(parentCard.first()).toBeVisible({ timeout: 15_000 });
  await parentCard.first().click();
  await expect(page.locator('.q-dialog')).toBeVisible({ timeout: 10_000 });
}

test.describe('approving an unassigned sub-contribution lands it in confirmed, not assigned (#800)', () => {
  test('unassigned sub shows Confirmed (not Assigned) after approval', async ({ adminPage, snap }) => {
    test.setTimeout(300_000);
    const aid = await adminAid();
    await loginAs(adminPage); // signed-auth session so API calls act as the admin

    const runTag = Date.now().toString(36);
    const projectTitle = `Unassigned Sub Project ${runTag}`;
    const parentTitle = `Coordinate hapu liaison ${runTag}`;
    const subTitle = `Draft consultation flyer ${runTag}`;
    await seedPlanWithUnassignedSub(aid, projectTitle, parentTitle, subTitle);

    await openParentContributionDetail(adminPage, projectTitle, parentTitle);
    const dialog = adminPage.locator('.q-dialog');

    // The parent's detail dialog lists the unassigned sub in Created status,
    // with an Approve button and no assignee pill.
    const subItem = dialog.locator('.sub-item').filter({ hasText: subTitle }).first();
    await expect(subItem).toBeVisible({ timeout: 15_000 });
    await expect(subItem.locator('.status-badge')).toHaveText('Created');
    await expect(subItem.locator('.sub-item-assignee')).toHaveCount(0);
    const approveBtn = subItem.getByRole('button', { name: 'Approve' });
    await expect(approveBtn).toBeVisible();
    await snap(adminPage, 'unassigned-sub-before-approval');

    // Approve it. With no assignee the sub must land in Confirmed, not Assigned.
    await approveBtn.click();
    await expect(adminPage.getByText('Sub-contribution approved!', { exact: true })).toBeVisible({
      timeout: 10_000,
    });

    const approvedSub = dialog.locator('.sub-item').filter({ hasText: subTitle }).first();
    await expect(approvedSub.locator('.status-badge')).toHaveText('Confirmed', { timeout: 15_000 });
    await expect(approvedSub.locator('.status-badge.assigned')).toHaveCount(0);
    await snap(adminPage, 'unassigned-sub-confirmed-after-approval');
  });
});
