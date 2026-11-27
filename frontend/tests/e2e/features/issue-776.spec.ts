import { test, expect, Page } from './fixtures';
import { loginAs, jsonSessionHeaders } from '../utils/signed-auth';

// Feature (#776): when editing an implementation plan, an admin/lead/steward can
// move a top-level contribution to a different milestone via a milestone picker
// in the contribution edit dialog. After the move the contribution appears under
// the target milestone and disappears from the source, without a manual refresh.
//
// Seeding goes through the backend API as the admin (lead + steward): a project
// with a plan carrying two milestones and one contribution in the first. The
// move itself is driven through the UI (detail dialog → edit → milestone picker
// → save), which is what the feature delivers.

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

// Project → plan → two milestones → one contribution in the first milestone.
async function seedTwoMilestones(
  aid: string,
  projectTitle: string,
  m1Title: string,
  m2Title: string,
  contribTitle: string,
): Promise<void> {
  const proj = await api(aid, 'POST', '/projects', {
    title: projectTitle,
    description: 'Seeded by issue-776 feature spec.',
    created_by: aid,
  });
  const plan = await api(aid, 'POST', '/implementation-plans', {
    project_id: proj.id,
    total_budget: '100',
    project_lead: aid,
    project_steward_id: aid,
  });
  // Each POST returns the full plan with its milestones so far; the first one's
  // milestones[0] is the source milestone we drop the contribution into.
  const afterM1 = await api(aid, 'POST', `/implementation-plans/${plan.id}/milestones`, {
    title: m1Title,
    duration: '1 week',
  });
  await api(aid, 'POST', `/implementation-plans/${plan.id}/milestones`, {
    title: m2Title,
    duration: '1 week',
  });
  const milestoneId = (afterM1.milestones ?? afterM1.Milestones)[0].milestone_id;

  await api(aid, 'POST', '/contributions', {
    project_id: proj.id,
    milestone_id: milestoneId,
    title: contribTitle,
    description: 'Contribution to be moved.',
    contribution_type: 'task',
    priority: 'medium',
    created_by: aid,
    objectives: ['get moved'],
    deliverables: ['a plan edit'],
    acceptance_criteria: ['lands in the new milestone'],
  });
}

async function openProject(page: Page, projectTitle: string) {
  await page.getByRole('button', { name: /enter community/i }).click({ timeout: 15_000 }).catch(() => {});
  await page.getByRole('button', { name: 'Projects' }).click();
  const projectCard = page.locator('.project-card', { hasText: projectTitle }).first();
  await expect(projectCard).toBeVisible({ timeout: 30_000 });
  await projectCard.click();
  await expect(page).toHaveURL(/\/dashboard\/projects\//, { timeout: 15_000 });
  await expect(page.locator('.milestone-card').first()).toBeVisible({ timeout: 30_000 });
}

test.describe('move a contribution to another milestone (#776)', () => {
  test('editing a contribution can relocate it to a different milestone', async ({ adminPage, snap }) => {
    test.setTimeout(300_000);
    const aid = await adminAid();
    await loginAs(adminPage);

    const runTag = Date.now().toString(36);
    const projectTitle = `Move Project ${runTag}`;
    const m1Title = `Milestone One ${runTag}`;
    const m2Title = `Milestone Two ${runTag}`;
    const contribTitle = `Movable task ${runTag}`;
    await seedTwoMilestones(aid, projectTitle, m1Title, m2Title, contribTitle);

    await openProject(adminPage, projectTitle);

    // Before: the contribution sits under the first milestone.
    const m1Card = adminPage.locator('.milestone-card', { hasText: m1Title });
    const m2Card = adminPage.locator('.milestone-card', { hasText: m2Title });
    await expect(m1Card.locator('.compact-title', { hasText: contribTitle })).toBeVisible();
    await expect(m2Card.locator('.compact-title', { hasText: contribTitle })).toHaveCount(0);
    await snap(adminPage, 'before-move-in-milestone-one');

    // Open the contribution detail, then its edit dialog.
    await m1Card.locator('.compact-title', { hasText: contribTitle }).click();
    await adminPage.locator('.title-edit-btn').first().click();

    const dialog = adminPage.locator('.contribution-dialog');
    await expect(dialog).toBeVisible();

    // Pick the second milestone in the move selector and save.
    const milestoneSelect = dialog.locator('.q-select').filter({ hasText: m1Title }).first();
    await expect(milestoneSelect).toBeVisible();
    await milestoneSelect.click();
    await adminPage.locator('.q-menu .q-item', { hasText: m2Title }).click();
    await snap(adminPage, 'milestone-picker-set-to-two');
    await dialog.getByRole('button', { name: 'Save Changes' }).click();

    // After: the contribution now sits under the second milestone, and is gone
    // from the first — no manual refresh.
    await expect(m2Card.locator('.compact-title', { hasText: contribTitle })).toBeVisible({ timeout: 15_000 });
    await expect(m1Card.locator('.compact-title', { hasText: contribTitle })).toHaveCount(0);
    await snap(adminPage, 'after-move-in-milestone-two');
  });
});
