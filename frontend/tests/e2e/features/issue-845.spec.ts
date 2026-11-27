import { test, expect } from './fixtures';

// #845 — archiving a parent contribution that has sub-contributions requires an
// explicit choice: archive them (rewarded ones are never archived) or keep them
// and promote them to top-level contributions in the same milestone.

const API = 'http://localhost:9080/api/v1';
const AUTH = { 'Content-Type': 'application/json', Authorization: 'Bearer matou-dev' };
const RUN = Date.now();

async function post(path: string, body: unknown) {
  const res = await fetch(`${API}${path}`, { method: 'POST', headers: AUTH, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

async function get(path: string) {
  return (await fetch(`${API}${path}`, { headers: AUTH })).json();
}

function contribBody(projectId: string, title: string, extra: Record<string, unknown> = {}) {
  return {
    project_id: projectId,
    title,
    description: 'e2e',
    contribution_type: 'development',
    objectives: ['o'],
    deliverables: ['d'],
    acceptance_criteria: ['a'],
    skill_requirements: [],
    created_by: 'e2e',
    ...extra,
  };
}

test('archiving a parent asks for a sub-contribution choice and promote keeps children top-level', async ({
  adminPage,
  snap,
}) => {
  test.setTimeout(120_000);

  const project = (await post('/projects', { title: `e2e-845-${RUN}`, description: 'e2e', created_by: 'e2e' })).json;
  const plan = (
    await post('/implementation-plans', { project_id: project.id, title: 'Plan', description: 'e2e', created_by: 'e2e' })
  ).json;
  const withMs = (await post(`/implementation-plans/${plan.id}/milestones`, { title: 'M1', duration: '1 week' })).json;
  const milestoneId = withMs.milestones[0].milestone_id as string;

  const parent = (await post('/contributions', contribBody(project.id, 'Parent', { milestone_id: milestoneId }))).json;
  const child = (await post('/contributions', contribBody(project.id, 'Child', { parent_contribution: parent.id }))).json;

  await adminPage.goto(`/#/dashboard/projects/${project.id}`);
  await adminPage.waitForLoadState('networkidle');
  await snap(adminPage, 'parent-with-sub-contribution');

  // No choice: rejected, parent untouched.
  const rejected = await post(`/contributions/${parent.id}/archive`, {});
  expect(rejected.status).toBe(400);
  expect((await get(`/contributions/${parent.id}`)).status).not.toBe('archived');

  // Promote: parent archived, child is top-level in the same milestone.
  const ok = await post(`/contributions/${parent.id}/archive`, { sub_contributions: 'promote' });
  expect(ok.status).toBe(200);
  const afterParent = await get(`/contributions/${parent.id}`);
  const afterChild = await get(`/contributions/${child.id}`);
  expect(afterParent.status).toBe('archived');
  expect(afterParent.child_contributions ?? []).not.toContain(child.id);
  expect(afterChild.status).not.toBe('archived');
  expect(afterChild.parent_contribution ?? '').toBe('');
  expect(afterChild.milestone_id).toBe(milestoneId);

  await adminPage.reload();
  await adminPage.waitForLoadState('networkidle');
  await snap(adminPage, 'child-promoted-to-top-level');
});
