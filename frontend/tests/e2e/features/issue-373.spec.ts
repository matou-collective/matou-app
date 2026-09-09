import { test, expect, Page } from './fixtures';

// Feature (#373, follow-up to #312/#314): the view_contribution_amounts
// capability is now resolved against the caller's role ON THE CONTRIBUTION'S
// PROJECT, not against their community-wide (credential-derived) roles. A
// steward assigned on project A (via assign-role) sees the budget/actuals on A's
// contributions but they are redacted on project B's; a credential-derived
// project_steward/lead (as the Founding Member admin holds) no longer reveals
// amounts on every project — only an actual assignment on the target project
// does. The assigned contributor always sees their own contribution's amounts.
//
// Enforcement lives in the backend (proven by Go unit tests in
// rbac_projects_amounts_test.go); this spec drives it through the API and
// snapshots the admin projects view. Identity here is a self-asserted X-User-AID
// header (the harness issue-17/#166 use), exercising the policy layer directly;
// in production it is meaningful under MATOU_REQUIRE_SIGNED_AUTH=1.

const API = 'http://localhost:9080/api/v1';

// Non-admin AIDs resolve to the baseline `member` role via ProfileRoleLookup.
const STEWARD_A = 'EStewardOfProjectAForIssue373Test00000000000';
const STRANGER = 'EStrangerMemberForIssue373Test00000000000000';

async function adminAid(): Promise<string> {
  const res = await fetch(`${API}/identity`);
  const body = await res.json();
  if (!body?.aid) throw new Error(`admin backend has no identity: ${JSON.stringify(body)}`);
  return body.aid as string;
}

async function apiJson(aid: string, method: string, route: string, body?: unknown) {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-User-AID': aid },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function budgetSeenBy(aid: string, contribId: string): Promise<string> {
  const res = await apiJson(aid, 'GET', `/contributions/${contribId}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body?.budget ?? '') as string;
}

test.describe('per-project contribution-amount visibility (#373)', () => {
  test('amounts follow the caller PROJECT role, not community roles', async ({
    adminPage,
    snap,
  }) => {
    test.setTimeout(120_000);
    const admin = await adminAid();

    // --- Admin creates two projects, each with a budgeted contribution. ---
    const mkProject = async (title: string) => {
      const p = await apiJson(admin, 'POST', '/projects', {
        title,
        description: `${title} for the #373 amounts test`,
        created_by: admin,
      });
      expect(p.status, JSON.stringify(p.body)).toBe(201);
      return p.body.id as string;
    };
    const mkContribution = async (projectId: string, budget: string, assignee: string) => {
      const c = await apiJson(admin, 'POST', '/contributions', {
        project_id: projectId,
        title: 'Do the mahi',
        description: 'A budgeted contribution',
        objectives: ['obj'],
        deliverables: ['del'],
        acceptance_criteria: ['crit'],
        budget,
        assigned_contributor_id: assignee,
        created_by: admin,
      });
      expect(c.status, JSON.stringify(c.body)).toBe(201);
      return c.body.id as string;
    };

    const projectA = await mkProject('Project A (#373)');
    const projectB = await mkProject('Project B (#373)');
    const assigneeB = 'EassigneeB_' + Date.now();
    const contribA = await mkContribution(projectA, '5000', 'EassigneeA_' + Date.now());
    const contribB = await mkContribution(projectB, '9000', assigneeB);

    // --- Assign STEWARD_A as steward of project A only. ---
    expect(
      (await apiJson(admin, 'POST', `/projects/${projectA}/assign-role`, {
        role: 'steward',
        user_id: STEWARD_A,
      })).status,
    ).toBe(200);

    // --- Steward of A: sees A's amounts, redacted on B. ---
    expect(await budgetSeenBy(STEWARD_A, contribA)).toBe('5000');
    expect(await budgetSeenBy(STEWARD_A, contribB)).toBe('');

    // --- Admin holds a credential-derived project_steward/lead bundle, but is
    // assigned on neither project: under #373 those no longer reveal amounts,
    // so the budget is redacted on both. (This is the bug the issue fixes.) ---
    expect(await budgetSeenBy(admin, contribA)).toBe('');
    expect(await budgetSeenBy(admin, contribB)).toBe('');

    // --- A stranger member sees nothing; the assignee always sees their own. ---
    expect(await budgetSeenBy(STRANGER, contribA)).toBe('');
    expect(await budgetSeenBy(assigneeB, contribB)).toBe('9000');

    // --- The admin projects view still loads unchanged. ---
    await openProjectsView(adminPage);
    await snap(adminPage, 'projects-view-per-project-amounts');
  });
});

// Login lands on the "Enter Community" welcome screen or straight on the
// dashboard; reach the projects view either way.
async function openProjectsView(page: Page): Promise<void> {
  const enter = page.getByRole('button', { name: /enter community/i });
  if (await enter.isVisible().catch(() => false)) {
    await enter.click().catch(() => {});
  }
  await page
    .getByRole('button', { name: /projects/i })
    .first()
    .click()
    .catch(() => {});
}
