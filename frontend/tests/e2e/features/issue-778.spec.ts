import { test, expect, Page } from './fixtures';
import { loginAs, jsonSessionHeaders } from '../utils/signed-auth';

// Feature (#778): a lead/steward can promote a sub-contribution to a top-level
// contribution in its parent chain's milestone. The promoted contribution
// leaves its parent's Sub-Contributions list and appears directly under the
// milestone as its own card.
//
// (Reordering sub-contributions already shipped in #754 — the drag handles in
// the detail dialog's sub-list. This spec covers the remaining ask: moving a
// sub OUT from under its parent.)
//
// Seeding goes through the backend API as the admin (lead + steward); the
// promotion itself is driven through the UI.

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

// Project → plan → milestone → one parent contribution with one sub-contribution.
async function seedParentAndSub(
  aid: string,
  projectTitle: string,
  parentTitle: string,
  subTitle: string,
): Promise<void> {
  const proj = await api(aid, 'POST', '/projects', {
    title: projectTitle,
    description: 'Seeded by issue-778 feature spec.',
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
    objectives: ['hold a sub'],
    deliverables: ['a plan'],
    acceptance_criteria: ['sub can be promoted'],
  });

  await api(aid, 'POST', '/contributions', {
    project_id: proj.id,
    parent_contribution: parent.id,
    title: subTitle,
    description: 'Sub-contribution to be promoted.',
    contribution_type: 'task',
    priority: 'medium',
    created_by: aid,
    objectives: ['start nested'],
    deliverables: ['a sub'],
    acceptance_criteria: ['becomes top-level'],
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

test.describe('promote a sub-contribution to top-level (#778)', () => {
  test('a lead can promote a sub out from under its parent into the milestone', async ({ adminPage, snap }) => {
    test.setTimeout(300_000);
    const aid = await adminAid();
    await loginAs(adminPage);

    const runTag = Date.now().toString(36);
    const projectTitle = `Promote Project ${runTag}`;
    const parentTitle = `Parent task ${runTag}`;
    const subTitle = `Sub task ${runTag}`;
    await seedParentAndSub(aid, projectTitle, parentTitle, subTitle);

    await openProject(adminPage, projectTitle);

    // Start: one top-level card (the parent), milestone count of 1.
    const topLevelCards = adminPage.locator('.reorder-card .compact-title');
    await expect(topLevelCards).toHaveCount(1);
    await expect(adminPage.locator('.milestone-meta-count').first()).toHaveText(/^1 contributions$/);
    await snap(adminPage, 'before-promote-one-top-level');

    // Open the parent's detail dialog to reach the sub-list.
    await adminPage.locator('.reorder-card', { hasText: parentTitle }).first().click();
    const subItem = adminPage.locator('.sub-item', { hasText: subTitle });
    await expect(subItem).toBeVisible({ timeout: 15_000 });
    await snap(adminPage, 'parent-detail-with-sub');

    // Promote the sub, then confirm in the dialog.
    await subItem.locator('.promote-sub-btn').click();
    await adminPage.getByRole('button', { name: 'Promote' }).click();

    // The sub leaves the parent's sub-list.
    await expect(adminPage.locator('.sub-item', { hasText: subTitle })).toHaveCount(0, { timeout: 15_000 });

    // Close the dialog and confirm the sub is now its own top-level card and the
    // milestone count reflects two top-level contributions.
    await adminPage.keyboard.press('Escape');
    await expect(adminPage.locator('.reorder-card .compact-title')).toHaveCount(2, { timeout: 15_000 });
    await expect(adminPage.locator('.reorder-card .compact-title', { hasText: subTitle })).toBeVisible();
    await expect(adminPage.locator('.milestone-meta-count').first()).toHaveText(/^2 contributions$/);
    await snap(adminPage, 'after-promote-two-top-level');
  });
});
