import { test, expect, Page } from './fixtures';
import { loginAs, jsonSessionHeaders } from '../utils/signed-auth';

// Feature (#753): every contribution shows an auto-generated reference beside
// its title, in the format milestone.contribution.sub ("M.C.S"). A top-level
// contribution ends in .0 (e.g. 1.1.0, 1.2.0); its sub-contributions extend it
// (1.1.1, 1.1.2). The reference is derived from position — never part of the
// title text — and is matchable by the contributions search.
//
// Seeding: standing up a plan + milestone + contributions is the whole project
// lifecycle, so we drive the backend API as the admin, then read the UI.

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

async function createContribution(
  aid: string,
  projectId: string,
  title: string,
  extra: Record<string, unknown>,
) {
  return api(aid, 'POST', '/contributions', {
    project_id: projectId,
    title,
    description: `Seeded contribution ${title}.`,
    contribution_type: 'task',
    priority: 'medium',
    created_by: aid,
    objectives: ['demonstrate references'],
    deliverables: ['numbered list'],
    acceptance_criteria: ['reference is derived'],
    ...extra,
  });
}

// Project → plan → one milestone → two top-level contributions (created in a
// deliberately NON-alphabetical sequence so the reference reflects position,
// not a title sort) → one sub-contribution under the first.
async function seedReferencedContributions(aid: string, projectTitle: string, tag: string) {
  const proj = await api(aid, 'POST', '/projects', {
    title: projectTitle,
    description: 'Seeded by issue-753 feature spec to demo contribution references.',
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

  // First-created → 1.1.0, second-created → 1.2.0 (position, not title).
  const first = await createContribution(aid, proj.id, `Zebra audit ${tag}`, {
    milestone_id: milestoneId,
  });
  const second = await createContribution(aid, proj.id, `Apple build ${tag}`, {
    milestone_id: milestoneId,
  });
  // Sub-contribution under the first → 1.1.1.
  const sub = await createContribution(aid, proj.id, `Fence subtask ${tag}`, {
    parent_contribution: first.id,
  });
  return { projectId: proj.id, first, second, sub };
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

test.describe('auto-numbered contribution references (#753)', () => {
  test('references show beside titles in the milestone view and are searchable', async ({ adminPage, snap }) => {
    test.setTimeout(300_000);
    const aid = await adminAid();
    await loginAs(adminPage);

    const tag = Date.now().toString(36);
    const projectTitle = `Reference Project ${tag}`;
    await seedReferencedContributions(aid, projectTitle, tag);

    await openProject(adminPage, projectTitle);

    // The milestone's two top-level contributions carry M.C.0 references,
    // shown beside — not inside — the title.
    const refs = adminPage.locator('.reorder-card .contribution-ref');
    await expect.poll(() => refs.allInnerTexts()).toEqual(['1.1.0', '1.2.0']);
    // The title text itself stays free of the number.
    await expect(adminPage.locator('.reorder-card .compact-title').first()).toHaveText(
      `Zebra audit ${tag}`,
    );
    await snap(adminPage, 'references-in-milestone-view');

    // Open the first contribution's detail to see its sub-contribution numbered
    // 1.1.1 under it.
    await adminPage.locator('.reorder-card', { hasText: `Zebra audit ${tag}` }).first().click();
    const subRef = adminPage.locator('.sub-item-title .contribution-ref').first();
    await expect(subRef).toHaveText('1.1.1', { timeout: 15_000 });
    await snap(adminPage, 'sub-contribution-reference');
    await adminPage.keyboard.press('Escape').catch(() => {});

    // Searching the Contributions list by a reference string finds the match.
    await adminPage.getByRole('button', { name: 'Contributions' }).click();
    const search = adminPage.getByPlaceholder('Search contributions');
    await expect(search).toBeVisible({ timeout: 15_000 });
    await search.fill('1.2.0');
    const cards = adminPage.locator('.contribution-card');
    await expect.poll(() => cards.count()).toBe(1);
    await expect(cards.first()).toContainText(`Apple build ${tag}`);
    await expect(cards.first().locator('.contribution-ref')).toHaveText('1.2.0');
    await snap(adminPage, 'search-by-reference');
  });
});
