import { test, expect, Page } from './fixtures';
import { loginAs, jsonSessionHeaders } from '../utils/signed-auth';

// Feature (#803): accepting an offered contribution is now atomic and
// idempotent. Previously, accepting an offer committed the contribution to
// `assigned` on the backend but then ran a best-effort child-offer propagation
// whose error was returned as the whole accept's error — so the client saw a
// failure, never refreshed, and kept showing the "Accept Offer" button. Worse,
// re-trying hit the offer/accept guards with "current: assigned" and hard-
// errored.
//
// The fix (backend contributions service):
//   - child propagation is best-effort: a propagation hiccup no longer fails
//     the parent's accept, which keeps returning the committed `assigned`
//     record so the UI updates and the button disappears;
//   - re-accepting a contribution already assigned to the accepting user is an
//     idempotent no-op (HTTP success), not an error;
//   - re-offering a contribution already assigned to that same user is an
//     idempotent no-op too.
//
// We drive the backend API to stand up a parent-with-child contribution offered
// to the admin, then exercise both the UI accept (button disappears, status
// flips to assigned) and the API idempotency.

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
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

async function must(aid: string, method: string, route: string, body?: unknown) {
  const r = await api(aid, method, route, body);
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`${method} ${route} → ${r.status}: ${JSON.stringify(r.body)}`);
  }
  return r.body;
}

// Stand up project → plan → milestone → parent contribution (with one child),
// confirm the parent and OFFER it to `offerTo`, leaving it in `offered` status.
async function seedOfferedParentWithChild(
  aid: string,
  offerTo: string,
  projectTitle: string,
  contribTitle: string,
): Promise<{ parentId: string; childId: string }> {
  const proj = await must(aid, 'POST', '/projects', {
    title: projectTitle,
    description: 'Seeded by issue-803 feature spec to demo offer/accept.',
    created_by: aid,
  });
  const plan = await must(aid, 'POST', '/implementation-plans', {
    project_id: proj.id,
    total_budget: '100',
    project_lead: aid,
    project_steward_id: aid,
  });
  const planWithMs = await must(aid, 'POST', `/implementation-plans/${plan.id}/milestones`, {
    title: 'Only milestone',
    duration: '1 week',
  });
  const milestoneId = (planWithMs.milestones ?? planWithMs.Milestones)[0].milestone_id;

  const parent = await must(aid, 'POST', '/contributions', {
    project_id: proj.id,
    milestone_id: milestoneId,
    title: contribTitle,
    description: 'Parent contribution offered to the member.',
    contribution_type: 'task',
    priority: 'medium',
    created_by: aid,
    objectives: ['demonstrate accepting an offer'],
    deliverables: ['an accepted, assigned contribution'],
    acceptance_criteria: ['the accept succeeds and the button disappears'],
    deadline: '2027-01-01',
  });

  // A child contribution so the accept runs its child-offer propagation.
  const child = await must(aid, 'POST', '/contributions', {
    project_id: proj.id,
    parent_contribution: parent.id,
    title: `${contribTitle} — sub`,
    description: 'Child contribution to exercise offer propagation.',
    contribution_type: 'task',
    priority: 'medium',
    created_by: aid,
    objectives: ['inherit the parent assignee'],
    deliverables: ['a propagated offer'],
    acceptance_criteria: ['propagation never fails the parent accept'],
    deadline: '2027-01-01',
  });

  await must(aid, 'POST', `/contributions/${parent.id}/confirm`);
  await must(aid, 'POST', `/contributions/${parent.id}/offer`, {
    offered_to: offerTo,
    offered_to_name: 'Accepting User',
  });

  const got = await must(aid, 'GET', `/contributions/${parent.id}`);
  const status = got.status ?? got.contribution?.status;
  if (status !== 'offered') throw new Error(`seed ended at status ${status}, wanted offered`);
  return { parentId: parent.id, childId: child.id };
}

async function openContributionDetail(page: Page, projectTitle: string, contribTitle: string) {
  const enterBtn = page.getByRole('button', { name: /enter community/i });
  await enterBtn.click({ timeout: 15_000 }).catch(() => {});
  await page.getByRole('button', { name: 'Projects' }).click();

  const projectCard = page.locator('.project-card', { hasText: projectTitle }).first();
  await expect(projectCard).toBeVisible({ timeout: 30_000 });
  await projectCard.click();
  await expect(page).toHaveURL(/\/dashboard\/projects\//, { timeout: 15_000 });

  const contribCard = page.locator('.contribution-compact').filter({ hasText: contribTitle });
  if (!(await contribCard.first().isVisible().catch(() => false))) {
    await page.locator('.milestone-header').first().click().catch(() => {});
  }
  await expect(contribCard.first()).toBeVisible({ timeout: 15_000 });
  await contribCard.first().click();
  await expect(page.locator('.q-dialog')).toBeVisible({ timeout: 10_000 });
}

test.describe('accept offered contribution (#803)', () => {
  test('accepting an offer assigns it and removes the Accept Offer button; re-accept is idempotent', async ({
    adminPage,
    snap,
  }) => {
    test.setTimeout(300_000);
    const aid = await adminAid();
    await loginAs(adminPage); // signed-auth session so API + UI act as the admin

    const runTag = Date.now().toString(36);
    const projectTitle = `Offer Accept Project ${runTag}`;
    const contribTitle = `Carve the waka ${runTag}`;
    const { parentId } = await seedOfferedParentWithChild(aid, aid, projectTitle, contribTitle);

    // The contribution is offered to the admin: the detail dialog shows the
    // "Accept Offer" affordance.
    await openContributionDetail(adminPage, projectTitle, contribTitle);
    const dialog = adminPage.locator('.q-dialog');
    const acceptBtn = dialog.getByRole('button', { name: /Accept Offer/i });
    await expect(acceptBtn).toBeVisible({ timeout: 15_000 });
    await snap(adminPage, 'offer-pending-accept-button');

    // Accept the offer — the fix means this succeeds even though the parent has
    // a child to propagate to, so the UI refreshes to `assigned` and the
    // "Accept Offer" button disappears (the reported bug: it used to stay).
    await acceptBtn.click();
    await expect(acceptBtn).toBeHidden({ timeout: 15_000 });
    await snap(adminPage, 'accepted-button-gone');

    // Backend confirms the accept committed to `assigned`.
    const afterAccept = await must(aid, 'GET', `/contributions/${parentId}`);
    expect(afterAccept.status ?? afterAccept.contribution?.status).toBe('assigned');

    // Idempotency: re-accepting the now-assigned contribution as the same user
    // is a benign no-op (HTTP success), not the old "current: assigned" error.
    const reAccept = await api(aid, 'POST', `/contributions/${parentId}/accept-offer`);
    expect(reAccept.status, JSON.stringify(reAccept.body)).toBeGreaterThanOrEqual(200);
    expect(reAccept.status).toBeLessThan(300);
    const reAcceptStatus = reAccept.body?.status ?? reAccept.body?.contribution?.status;
    expect(reAcceptStatus).toBe('assigned');

    // Idempotency: re-offering the contribution to the user it is already
    // assigned to is also a no-op, not an error.
    const reOffer = await api(aid, 'POST', `/contributions/${parentId}/offer`, {
      offered_to: aid,
      offered_to_name: 'Accepting User',
    });
    expect(reOffer.status, JSON.stringify(reOffer.body)).toBeGreaterThanOrEqual(200);
    expect(reOffer.status).toBeLessThan(300);
  });
});
