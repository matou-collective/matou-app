import { test, expect } from './fixtures';

// Feature (#9): a contributor can edit their own submission any time before
// sign-off. Once evidence is submitted (status needs_review), an "Edit
// Submission" affordance opens the completion form pre-filled with the current
// evidence; saving updates it in place (an approved contribution would drop
// back to needs_review, handled backend-side). Sign-off remains immutable.
//
// Seeding: we drive the backend API directly (as the admin, who is also the
// assigned contributor) to walk one contribution to needs_review, then use the
// UI to edit the submitted evidence.

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

// Walk a fresh project to a contribution in needs_review, assigned to the
// admin, with evidence already submitted.
async function seedSubmittedContribution(
  aid: string,
  projectTitle: string,
  contribTitle: string,
): Promise<void> {
  const proj = await api(aid, 'POST', '/projects', {
    title: projectTitle,
    description: 'Seeded by issue-9 feature spec.',
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
    description: 'Single seeded contribution to edit.',
    contribution_type: 'task',
    priority: 'medium',
    created_by: aid,
    objectives: ['demonstrate editing'],
    deliverables: ['an edited submission'],
    acceptance_criteria: ['submission is editable before sign-off'],
    deadline: '2027-01-01',
  });

  await api(aid, 'POST', `/contributions/${contrib.id}/confirm`);
  await api(aid, 'POST', `/contributions/${contrib.id}/assign`, { user_id: aid });
  await api(aid, 'POST', `/contributions/${contrib.id}/submit-evidence`, {
    completion_notes: 'First draft of my evidence.',
    acceptance_notes: ['Initial explanation.'],
  });

  const got = await api(aid, 'GET', `/contributions/${contrib.id}`);
  const status = got.status ?? got.contribution?.status;
  if (status !== 'needs_review') {
    throw new Error(`seed ended at status ${status}, wanted needs_review`);
  }
}

test.describe('contributor can edit a submission before sign-off (#9)', () => {
  test('edit submitted evidence from the contribution detail', async ({ adminPage, snap }) => {
    test.setTimeout(300_000);
    const aid = await adminAid();

    const runTag = Date.now().toString(36);
    const projectTitle = `Weaving Project ${runTag}`;
    const contribTitle = `Weave the panel ${runTag}`;
    await seedSubmittedContribution(aid, projectTitle, contribTitle);

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
    // The original evidence is on show and an Edit Submission affordance exists.
    await expect(dialog.getByText('First draft of my evidence.')).toBeVisible();
    const editBtn = dialog.getByRole('button', { name: 'Edit Submission' });
    await expect(editBtn).toBeVisible();
    await snap(adminPage, 'submission-before-edit');

    // Open the edit form — it prefills with the current evidence.
    await editBtn.click();
    const notesField = dialog.getByPlaceholder('Describe how you completed this contribution...');
    await expect(notesField).toHaveValue('First draft of my evidence.');
    await snap(adminPage, 'edit-form-prefilled');

    // Amend the completion notes and save.
    await notesField.fill('Revised evidence — added the finished photos.');
    await dialog.getByRole('button', { name: 'Save Changes' }).click();

    // The updated evidence is reflected back in the read view.
    await expect(dialog.getByText('Revised evidence — added the finished photos.')).toBeVisible({
      timeout: 15_000,
    });
    await expect(dialog.getByText('First draft of my evidence.')).toHaveCount(0);
    await snap(adminPage, 'submission-after-edit');
  });
});
