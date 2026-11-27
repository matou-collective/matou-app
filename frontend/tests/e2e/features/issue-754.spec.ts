import { test, expect, Page } from './fixtures';
import { loginAs, jsonSessionHeaders } from '../utils/signed-auth';

// Feature (#754): contributions carry an explicit, persisted sibling order.
// New contributions default to the END of their milestone's list (creation
// order, not the backend's arbitrary store order), and a project lead/steward
// can drag to re-order them. The order persists and is identical for every
// viewer after reload. Sub-contributions reorder the same way within a parent.
//
// Seeding: standing up ordered contributions through the UI is the whole
// project lifecycle, so we drive the backend API as the admin (who is lead +
// steward, hence allowed to reorder), then exercise the drag UI.

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

// Project → plan → milestone → three contributions created in a deliberate
// sequence whose titles are NOT in alphabetical order, so "display order ==
// creation order" is distinguishable from any accidental title sort.
async function seedOrderedContributions(
  aid: string,
  projectTitle: string,
  titles: string[],
): Promise<{ projectId: string; contribIds: string[] }> {
  const proj = await api(aid, 'POST', '/projects', {
    title: projectTitle,
    description: 'Seeded by issue-754 feature spec to demo contribution ordering.',
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

  const contribIds: string[] = [];
  for (const title of titles) {
    const c = await api(aid, 'POST', '/contributions', {
      project_id: proj.id,
      milestone_id: milestoneId,
      title,
      description: `Seeded contribution ${title}.`,
      contribution_type: 'task',
      priority: 'medium',
      created_by: aid,
      objectives: ['demonstrate ordering'],
      deliverables: ['ordered list'],
      acceptance_criteria: ['order is stable'],
    });
    contribIds.push(c.id);
  }
  return { projectId: proj.id, contribIds };
}

async function openProject(page: Page, projectTitle: string) {
  await page.getByRole('button', { name: /enter community/i }).click({ timeout: 15_000 }).catch(() => {});
  await page.getByRole('button', { name: 'Projects' }).click();
  const projectCard = page.locator('.project-card', { hasText: projectTitle }).first();
  await expect(projectCard).toBeVisible({ timeout: 30_000 });
  await projectCard.click();
  await expect(page).toHaveURL(/\/dashboard\/projects\//, { timeout: 15_000 });
  // Expand the milestone if collapsed.
  const firstCard = page.locator('.reorder-card .compact-title').first();
  if (!(await firstCard.isVisible().catch(() => false))) {
    await page.locator('.milestone-header').first().click().catch(() => {});
  }
  await expect(firstCard).toBeVisible({ timeout: 15_000 });
}

function titlesInOrder(page: Page) {
  return page.locator('.reorder-card .compact-title').allInnerTexts();
}

test.describe('contribution ordering & drag-to-reorder (#754)', () => {
  test('new contributions keep creation order, and a lead can drag to reorder (persisted)', async ({ adminPage, snap }) => {
    test.setTimeout(300_000);
    const aid = await adminAid();
    await loginAs(adminPage);

    const runTag = Date.now().toString(36);
    const projectTitle = `Ordering Project ${runTag}`;
    // Deliberately non-alphabetical creation sequence.
    const titles = [`Zebra audit ${runTag}`, `Apple build ${runTag}`, `Mango ship ${runTag}`];
    await seedOrderedContributions(aid, projectTitle, titles);

    await openProject(adminPage, projectTitle);

    // Contributions show in CREATION order (default-to-end), not title order.
    await expect.poll(() => titlesInOrder(adminPage)).toEqual(titles);
    await snap(adminPage, 'initial-creation-order');

    // Drag the first row (Zebra) onto the last row (Mango) to move it to the end.
    const rows = adminPage.locator('.reorder-row');
    await rows.first().dragTo(rows.last());

    const reordered = [titles[1]!, titles[2]!, titles[0]!];
    await expect.poll(() => titlesInOrder(adminPage)).toEqual(reordered);
    await snap(adminPage, 'after-drag-reorder');

    // The order persists for the next viewer — reload and re-check.
    await adminPage.reload();
    await openProject(adminPage, projectTitle);
    await expect.poll(() => titlesInOrder(adminPage)).toEqual(reordered);
    await snap(adminPage, 'order-persisted-after-reload');
  });
});
