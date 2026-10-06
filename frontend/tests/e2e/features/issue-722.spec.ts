import { test, expect, Page } from './fixtures';
import { loginAs, jsonSessionHeaders } from '../utils/signed-auth';

// Feature (#722): a contributor can save evidence on an assigned contribution
// as a DRAFT, come back later to add more, and only later explicitly submit it
// for review. Saving a draft must NOT move the contribution into needs_review
// (it stays assigned and non-reviewable) and the draft is owner-private.
//
// Seeding: the UI path to an assigned-to-me contribution is the whole project
// lifecycle, so we drive the backend API as the admin to stand one up quickly,
// then exercise the Save Draft / Submit for Review UI.

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

// Stand up project → plan → milestone → contribution, confirm it and assign it
// to the admin, leaving it in the pre-submission `assigned` state.
async function seedAssignedContribution(
  aid: string,
  projectTitle: string,
  contribTitle: string,
): Promise<{ projectId: string; contribId: string }> {
  const proj = await api(aid, 'POST', '/projects', {
    title: projectTitle,
    description: 'Seeded by issue-722 feature spec to demo draft evidence.',
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
    description: 'Single seeded contribution, assigned to the admin.',
    contribution_type: 'task',
    priority: 'medium',
    created_by: aid,
    objectives: ['demonstrate draft evidence'],
    deliverables: ['a saved draft, then a submission'],
    acceptance_criteria: ['draft can be saved and resumed'],
    deadline: '2027-01-01',
  });

  await api(aid, 'POST', `/contributions/${contrib.id}/confirm`);
  await api(aid, 'POST', `/contributions/${contrib.id}/assign`, { user_id: aid });

  const got = await api(aid, 'GET', `/contributions/${contrib.id}`);
  const status = got.status ?? got.contribution?.status;
  if (status !== 'assigned') throw new Error(`seed ended at status ${status}, wanted assigned`);
  return { projectId: proj.id, contribId: contrib.id };
}

async function openContributionDetail(page: Page, projectTitle: string, contribTitle: string) {
  const enterBtn = page.getByRole('button', { name: /enter community/i });
  await enterBtn.click({ timeout: 15_000 }).catch(() => {});
  await page.getByRole('button', { name: 'Projects' }).click();

  const projectCard = page.locator('.project-card', { hasText: projectTitle }).first();
  await expect(projectCard).toBeVisible({ timeout: 30_000 });
  await projectCard.click();
  await expect(page).toHaveURL(/\/dashboard\/projects\//, { timeout: 15_000 });

  // Expand the milestone if its contributions are collapsed, then open the
  // contribution's detail dialog.
  const contribCard = page.locator('.contribution-compact').filter({ hasText: contribTitle });
  if (!(await contribCard.first().isVisible().catch(() => false))) {
    await page.locator('.milestone-header').first().click().catch(() => {});
  }
  await expect(contribCard.first()).toBeVisible({ timeout: 15_000 });
  await contribCard.first().click();
  await expect(page.locator('.q-dialog')).toBeVisible({ timeout: 10_000 });
}

test.describe('draft submit evidence (#722)', () => {
  test('save evidence as a draft, resume it, then submit for review', async ({ adminPage, snap }) => {
    test.setTimeout(300_000);
    const aid = await adminAid();
    await loginAs(adminPage); // signed-auth session so API calls act as the admin

    const runTag = Date.now().toString(36);
    const projectTitle = `Draft Evidence Project ${runTag}`;
    const contribTitle = `Weave the korowai ${runTag}`;
    await seedAssignedContribution(aid, projectTitle, contribTitle);

    await openContributionDetail(adminPage, projectTitle, contribTitle);
    const dialog = adminPage.locator('.q-dialog');

    // Open the evidence form — it now offers BOTH "Save Draft" and
    // "Submit for Review".
    await dialog.getByRole('button', { name: /Submit Evidence & Complete/i }).click();
    const saveDraftBtn = dialog.getByRole('button', { name: /^Save Draft$/i });
    const submitBtn = dialog.getByRole('button', { name: /Submit for Review/i });
    await expect(saveDraftBtn).toBeVisible({ timeout: 10_000 });
    await expect(submitBtn).toBeVisible();
    await snap(adminPage, 'evidence-form-save-draft-and-submit');

    // Fill partial evidence and SAVE AS DRAFT. The completion-notes field is
    // the first textarea inside the evidence form.
    const completionNotes = dialog.locator('.submit-completion-form textarea').first();
    await completionNotes.fill('Started the weaving — more to come.');
    await saveDraftBtn.click();
    await expect(adminPage.getByText(/Draft saved/i)).toBeVisible({ timeout: 10_000 });
    await snap(adminPage, 'draft-saved-toast');

    // The contribution is still assigned (not needs_review): the footer now
    // invites the owner to CONTINUE the draft rather than start fresh, and the
    // read-only panel marks the evidence as an unsubmitted draft.
    const continueBtn = dialog.getByRole('button', { name: /Continue Draft Evidence/i });
    await expect(continueBtn).toBeVisible({ timeout: 10_000 });
    await expect(dialog.getByText(/Draft Evidence \(not yet submitted\)/i)).toBeVisible();
    await snap(adminPage, 'draft-indicator-visible');

    // Resume the draft — the form is prefilled with the saved notes.
    await continueBtn.click();
    const resumedNotes = dialog.locator('.submit-completion-form textarea').first();
    await expect(resumedNotes).toHaveValue(/Started the weaving/);
    await snap(adminPage, 'draft-resumed-prefilled');

    // Now explicitly SUBMIT FOR REVIEW — this performs the assigned →
    // needs_review transition.
    await resumedNotes.fill('Finished the korowai — ready for review.');
    await dialog.getByRole('button', { name: /Submit for Review/i }).click();
    await expect(adminPage.getByText(/Submitted for review/i)).toBeVisible({ timeout: 10_000 });
    await snap(adminPage, 'submitted-for-review');
  });
});
