import { test, expect, Page } from './fixtures';
import { loginAs, jsonSessionHeaders } from '../utils/signed-auth';

// Feature (#773): a sub-contribution shows only once on the plan page — nested
// under its parent — even when it wrongly carries a milestone_id. Before the
// fix such a sub was drawn twice (nested AND as its own top-level card) and
// double-counted in the milestone's contribution count.
//
// Two halves of the fix are exercised here end-to-end:
//   - add_contribution drops milestone_id when a parent is given, so a sub
//     created with both is never added to the milestone's top-level list.
//   - MilestoneCard skips any sub whose parent is in the same milestone, so
//     even a legacy sub that already carries a milestone_id shows only nested.
//
// Seeding goes through the backend API as the admin (lead + steward); the
// lifecycle of standing up a parent + sub through the UI is out of scope here.

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

// Project → plan → milestone → one parent contribution, then a sub created with
// BOTH parent_contribution and milestone_id — the exact shape that used to
// duplicate the sub on the plan page.
async function seedParentAndSub(
  aid: string,
  projectTitle: string,
  parentTitle: string,
  subTitle: string,
): Promise<void> {
  const proj = await api(aid, 'POST', '/projects', {
    title: projectTitle,
    description: 'Seeded by issue-773 feature spec.',
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
    description: 'Parent contribution.',
    contribution_type: 'task',
    priority: 'medium',
    created_by: aid,
    objectives: ['demonstrate nesting'],
    deliverables: ['a plan'],
    acceptance_criteria: ['sub shows once'],
  });

  await api(aid, 'POST', '/contributions', {
    project_id: proj.id,
    // Both supplied on purpose — the backend must drop milestone_id for a sub.
    parent_contribution: parent.id,
    milestone_id: milestoneId,
    title: subTitle,
    description: 'Sub-contribution.',
    contribution_type: 'task',
    priority: 'medium',
    created_by: aid,
    objectives: ['nest under parent'],
    deliverables: ['a sub'],
    acceptance_criteria: ['shown only nested'],
  });
}

async function openProject(page: Page, projectTitle: string) {
  await page.getByRole('button', { name: /enter community/i }).click({ timeout: 15_000 }).catch(() => {});
  await page.getByRole('button', { name: 'Projects' }).click();
  const projectCard = page.locator('.project-card', { hasText: projectTitle }).first();
  await expect(projectCard).toBeVisible({ timeout: 30_000 });
  await projectCard.click();
  await expect(page).toHaveURL(/\/dashboard\/projects\//, { timeout: 15_000 });
  const firstCard = page.locator('.reorder-card .compact-title').first();
  if (!(await firstCard.isVisible().catch(() => false))) {
    await page.locator('.milestone-header').first().click().catch(() => {});
  }
  await expect(firstCard).toBeVisible({ timeout: 15_000 });
}

test.describe('sub-contribution shows once on the plan page (#773)', () => {
  test('a sub with a milestone_id is nested under its parent, not duplicated at top level', async ({ adminPage, snap }) => {
    test.setTimeout(300_000);
    const aid = await adminAid();
    await loginAs(adminPage);

    const runTag = Date.now().toString(36);
    const projectTitle = `Nesting Project ${runTag}`;
    const parentTitle = `Parent task ${runTag}`;
    const subTitle = `Sub task ${runTag}`;
    await seedParentAndSub(aid, projectTitle, parentTitle, subTitle);

    await openProject(adminPage, projectTitle);

    // Exactly one top-level card — the parent. The sub is NOT a top-level card.
    const topLevelRows = adminPage.locator('.contributions-list > .reorder-row');
    await expect(topLevelRows).toHaveCount(1);
    await expect(adminPage.locator('.reorder-card .compact-title').first()).toHaveText(parentTitle);

    // The milestone's contribution count reflects top-level only (1, not 2).
    await expect(adminPage.locator('.milestone-meta-count').first()).toHaveText(/^1 contributions$/);
    await snap(adminPage, 'sub-not-duplicated-at-top-level');

    // The sub lives in the parent's Sub-Contributions section.
    const subToggle = adminPage.getByRole('button', { name: /Sub-Contributions \(1\)/ });
    await expect(subToggle).toBeVisible();
    await subToggle.click();
    await expect(adminPage.locator('.sub-list').getByText(subTitle)).toBeVisible();
    await snap(adminPage, 'sub-nested-under-parent');
  });
});
