import { test, expect } from './fixtures';

// Bug (#747): editing a contribution (in `created` status) and clearing the
// Budget or Estimated Hours field, then saving, showed a positive
// "Contribution updated!" toast — but the old value reappeared immediately and
// after an app reload. The cleared value was never persisted. The create/edit
// submit builder coerced an emptied Budget to `undefined` (dropped from the
// request) and sent an emptied Estimated Hours as "" (ignored by the backend).
// The fix sends a cleared Budget as "" and a cleared Estimated Hours as 0, so
// clearing is an honest, persisted action.
//
// Seeding mirrors issue-717.spec.ts: drive the backend API directly (as the
// admin, who is also the project lead so can see/edit budget) to create one
// project with a contribution in `created` status that has a budget and an
// estimated duration, then clear both through the edit dialog in the UI.

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
  if (!res.ok) throw new Error(`${method} ${route} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : undefined;
}

// Create a project (admin is the project lead, so the budget field is visible)
// with one contribution in `created` status carrying a budget and estimate.
async function seedCreatedContribution(
  aid: string,
  projectTitle: string,
  contribTitle: string,
): Promise<void> {
  const proj = await api(aid, 'POST', '/projects', {
    title: projectTitle,
    description: 'Seeded by issue-747 feature spec.',
    created_by: aid,
  });
  const plan = await api(aid, 'POST', '/implementation-plans', {
    project_id: proj.id,
    total_budget: '1000',
    project_lead: aid,
    project_steward_id: aid,
  });
  const planWithMs = await api(aid, 'POST', `/implementation-plans/${plan.id}/milestones`, {
    title: 'Only milestone',
    duration: '1 week',
  });
  const milestoneId = (planWithMs.milestones ?? planWithMs.Milestones)[0].milestone_id;

  await api(aid, 'POST', '/contributions', {
    project_id: proj.id,
    milestone_id: milestoneId,
    title: contribTitle,
    description: 'A seeded contribution with a budget and an estimate to clear.',
    contribution_type: 'task',
    priority: 'medium',
    created_by: aid,
    objectives: ['demonstrate clearing budget and estimate'],
    deliverables: ['a persisted clear'],
    acceptance_criteria: ['cleared values survive a reload'],
    estimated_duration: 10,
    budget: '500',
  });
}

// Open the seeded project, then the contribution detail dialog, for the admin.
async function openContributionDetail(
  page: import('@playwright/test').Page,
  projectTitle: string,
  contribTitle: string,
) {
  const enterBtn = page.getByRole('button', { name: /enter community/i });
  await enterBtn.click({ timeout: 15_000 }).catch(() => {});
  await page.getByRole('button', { name: 'Projects' }).click();

  const projectCard = page.locator('.project-card', { hasText: projectTitle }).first();
  await expect(projectCard).toBeVisible({ timeout: 30_000 });
  await projectCard.click();

  const contribCard = page.locator('.contribution-compact').filter({ hasText: contribTitle });
  await expect(contribCard).toBeVisible({ timeout: 30_000 });
  await contribCard.click();

  const detail = page.locator('.q-dialog').filter({ hasText: contribTitle });
  await expect(detail).toBeVisible({ timeout: 15_000 });
  return detail;
}

test.describe('clearing budget & estimated hours on a contribution persists (#747)', () => {
  test('cleared Budget and Estimated Hours survive a reload', async ({ adminPage, snap }) => {
    test.setTimeout(300_000);
    const aid = await adminAid();

    const runTag = Date.now().toString(36);
    const projectTitle = `Weaving Project ${runTag}`;
    const contribTitle = `Prepare the harakeke ${runTag}`;
    await seedCreatedContribution(aid, projectTitle, contribTitle);

    const detail = await openContributionDetail(adminPage, projectTitle, contribTitle);

    // Starting state: the detail dialog shows the seeded budget and estimate.
    const estimatedStat = detail.locator('.stat-card', { hasText: 'Estimated' }).locator('.stat-value');
    const budgetStat = detail.locator('.stat-card', { hasText: 'Budget' }).locator('.stat-value');
    await expect(estimatedStat).toHaveText('10h');
    await expect(budgetStat).toHaveText('500');
    await snap(adminPage, 'before-clear');

    // Open the edit dialog (pencil on the title).
    await detail.locator('.title-edit-btn').click();
    const editDialog = adminPage.locator('.q-dialog').filter({ hasText: 'Edit Contribution' });
    await expect(editDialog).toBeVisible({ timeout: 15_000 });

    // Clear both planning fields.
    const estimateInput = editDialog
      .locator('.q-field', { hasText: 'Estimated Hours' })
      .locator('input');
    const budgetInput = editDialog.locator('.q-field', { hasText: 'Budget' }).locator('input');
    await estimateInput.fill('');
    await budgetInput.fill('');
    await snap(adminPage, 'fields-cleared');

    await editDialog.getByRole('button', { name: 'Save Changes' }).click();
    await expect(adminPage.getByText('Contribution updated!')).toBeVisible({ timeout: 15_000 });

    // Reload the whole app — the cleared values must still be cleared.
    await adminPage.reload();

    const detailAfter = await openContributionDetail(adminPage, projectTitle, contribTitle);
    const estimatedAfter = detailAfter
      .locator('.stat-card', { hasText: 'Estimated' })
      .locator('.stat-value');
    const budgetAfter = detailAfter.locator('.stat-card', { hasText: 'Budget' }).locator('.stat-value');
    // Cleared estimate (0) and budget ("") both render as the em dash.
    await expect(estimatedAfter).toHaveText('—');
    await expect(budgetAfter).toHaveText('—');
    await snap(adminPage, 'after-reload-cleared');
  });
});
