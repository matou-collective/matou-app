import { test, expect } from './fixtures';

// Bug (#717): opening the submit-evidence form always showed one blank
// evidence-URL row that the contributor had to delete by hand. The evidence
// form seeded its `evidence_urls` list with a single empty string; the row is
// pointless because URLs are added via a separate input + "Add" button. The
// fix seeds the list empty, so a fresh form shows zero evidence-URL rows and
// the Add flow is unchanged.
//
// Seeding mirrors issue-9.spec.ts: drive the backend API directly (as the
// admin, who is also the assigned contributor) to walk one contribution to
// status `assigned`, then open the submit-evidence form through the UI.

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

// Walk a fresh project to a contribution in status `assigned`, assigned to the
// admin, with no evidence submitted yet — the state in which the contributor
// opens the submit-evidence form.
async function seedAssignedContribution(
  aid: string,
  projectTitle: string,
  contribTitle: string,
): Promise<void> {
  const proj = await api(aid, 'POST', '/projects', {
    title: projectTitle,
    description: 'Seeded by issue-717 feature spec.',
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
    title: contribTitle,
    description: 'Single seeded contribution to submit evidence for.',
    contribution_type: 'task',
    priority: 'medium',
    created_by: aid,
    objectives: ['demonstrate the evidence form'],
    deliverables: ['a submission'],
    acceptance_criteria: ['form opens with no blank evidence-URL row'],
    deadline: '2027-01-01',
  });

  await api(aid, 'POST', `/contributions/${contrib.id}/confirm`);
  await api(aid, 'POST', `/contributions/${contrib.id}/assign`, { user_id: aid });

  const got = await api(aid, 'GET', `/contributions/${contrib.id}`);
  const status = got.status ?? got.contribution?.status;
  if (status !== 'assigned') {
    throw new Error(`seed ended at status ${status}, wanted assigned`);
  }
}

test.describe('submit-evidence form has no blank evidence-URL row (#717)', () => {
  test('fresh evidence form starts with zero URL rows; Add still works', async ({
    adminPage,
    snap,
  }) => {
    test.setTimeout(300_000);
    const aid = await adminAid();

    const runTag = Date.now().toString(36);
    const projectTitle = `Carving Project ${runTag}`;
    const contribTitle = `Carve the pou ${runTag}`;
    await seedAssignedContribution(aid, projectTitle, contribTitle);

    // Get past the welcome splash (if showing) and open Projects.
    const enterBtn = adminPage.getByRole('button', { name: /enter community/i });
    await enterBtn.click({ timeout: 15_000 }).catch(() => {});
    await adminPage.getByRole('button', { name: 'Projects' }).click();

    // Open the seeded project, then the contribution detail dialog.
    const projectCard = adminPage.locator('.project-card', { hasText: projectTitle }).first();
    await expect(projectCard).toBeVisible({ timeout: 30_000 });
    await projectCard.click();

    const contribCard = adminPage.locator('.contribution-compact').filter({ hasText: contribTitle });
    await expect(contribCard).toBeVisible({ timeout: 30_000 });
    await contribCard.click();

    const dialog = adminPage.locator('.q-dialog');
    await expect(dialog).toBeVisible({ timeout: 15_000 });

    // Open the submit-evidence form.
    await dialog.getByRole('button', { name: 'Submit Evidence & Complete' }).click();
    await expect(dialog.getByText('Submit Completion')).toBeVisible({ timeout: 15_000 });

    // The evidence-URL list starts empty — no blank, deletable row to tidy up.
    await expect(dialog.locator('.evidence-url-item')).toHaveCount(0);
    await snap(adminPage, 'fresh-form-no-blank-url-row');

    // Adding a URL via the input + Add button still works and renders one row.
    await dialog.locator('.evidence-url-input input').fill('https://example.org/evidence');
    await dialog.locator('.evidence-url-add-btn').click();
    await expect(dialog.locator('.evidence-url-item')).toHaveCount(1);
    await expect(dialog.getByText('https://example.org/evidence')).toBeVisible();
    await snap(adminPage, 'url-added-one-row');
  });
});
