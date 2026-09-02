import { test, expect } from './fixtures';

// Feature (#166): backend RBAC now resolves lead/steward-tier capabilities
// against the caller's role ON THE TARGET PROJECT, not community-globally. A
// project lead of project A is 403'd on project B's lead-only routes and passes
// on A; an assigned contributor may submit/edit evidence on their own
// contribution and is 403'd on someone else's; an unassigned member is 403'd.
//
// Identity here is a self-asserted X-User-AID header (the same harness issue-17
// uses), so we exercise the policy layer directly. In production this
// enforcement is only meaningful under MATOU_REQUIRE_SIGNED_AUTH=1, where the
// AID is cryptographically verified (see docs/RBAC.md, Issue #166 delta).

const API = 'http://localhost:9080/api/v1';

// Non-admin AIDs resolve to the baseline `member` role via ProfileRoleLookup.
const LEAD_A = 'ELeadOfProjectAForIssue166Test0000000000000';
const CONTRIB_AID = 'EContributorForIssue166Test000000000000000';
const STRANGER = 'EStrangerMemberForIssue166Test000000000000';
const MEMBER_AID = 'EUnassignedMemberForIssue166Test0000000000';

async function adminAid(): Promise<string> {
  const res = await fetch(`${API}/identity`);
  const body = await res.json();
  if (!body?.aid)
    throw new Error(`admin backend has no identity: ${JSON.stringify(body)}`);
  return body.aid as string;
}

async function call(
  aid: string,
  method: string,
  route: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-User-AID': aid },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed: any = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

async function status(
  aid: string,
  method: string,
  route: string,
  body?: unknown,
): Promise<number> {
  return (await call(aid, method, route, body)).status;
}

test.describe('project-scoped RBAC enforcement (#166)', () => {
  test('lead is scoped to their own project; evidence is scoped to the assignee', async ({
    adminPage,
    snap,
  }) => {
    test.setTimeout(120_000);
    const admin = await adminAid();

    // --- Admin (Founding Member) creates two projects. ---
    const projA = await call(admin, 'POST', '/projects', {
      title: 'Project A (#166)',
      description: 'Lead-scoping test project A',
      created_by: admin,
    });
    const projB = await call(admin, 'POST', '/projects', {
      title: 'Project B (#166)',
      description: 'Lead-scoping test project B',
      created_by: admin,
    });
    const a = projA.body?.id as string;
    const b = projB.body?.id as string;
    expect(a, `project A create: ${JSON.stringify(projA.body)}`).toBeTruthy();
    expect(b, `project B create: ${JSON.stringify(projB.body)}`).toBeTruthy();

    // --- Assign LEAD_A as lead of project A only. ---
    expect(
      await status(admin, 'POST', `/projects/${a}/assign-role`, {
        role: 'lead',
        user_id: LEAD_A,
      }),
    ).toBe(200);

    // --- Lead-only route (submit-completion) is project-scoped. ---
    // The lead of A passes the gate on A (fails downstream because the project
    // is not active — a non-403 status proves the gate let them through)...
    expect(
      await status(LEAD_A, 'POST', `/projects/${a}/submit-completion`),
    ).not.toBe(403);
    // ...but is 403'd on project B, where they hold no role.
    expect(
      await status(LEAD_A, 'POST', `/projects/${b}/submit-completion`),
    ).toBe(403);
    // An unassigned member is 403'd even on project A.
    expect(
      await status(MEMBER_AID, 'POST', `/projects/${a}/submit-completion`),
    ).toBe(403);
    // The community admin (Founding Member) passes on every project.
    expect(
      await status(admin, 'POST', `/projects/${b}/submit-completion`),
    ).not.toBe(403);
    // The lead of A cannot archive project B either.
    expect(await status(LEAD_A, 'POST', `/projects/${b}/archive`)).toBe(403);

    // --- Contributor evidence is scoped to the assignee. ---
    const contrib = await call(admin, 'POST', '/contributions', {
      project_id: a,
      title: 'Evidence-scoping task (#166)',
      description: 'A contribution assigned to CONTRIB_AID',
      contribution_type: 'technical',
      priority: 'low',
      created_by: admin,
      objectives: ['o'],
      deliverables: ['d'],
      acceptance_criteria: ['a'],
      skill_requirements: ['s'],
    });
    const cid = contrib.body?.id as string;
    expect(
      cid,
      `contribution create: ${JSON.stringify(contrib.body)}`,
    ).toBeTruthy();

    // Drive it to `assigned` so CONTRIB_AID is its assigned contributor.
    expect(
      await status(admin, 'POST', `/contributions/${cid}/confirm`),
    ).not.toBe(403);
    expect(
      await status(admin, 'POST', `/contributions/${cid}/assign`, {
        user_id: CONTRIB_AID,
      }),
    ).toBe(200);

    // A member who is not the assignee is 403'd; the assigned contributor is not.
    expect(
      await status(STRANGER, 'POST', `/contributions/${cid}/submit-evidence`, {
        completion_notes: 'x',
      }),
    ).toBe(403);
    expect(
      await status(
        MEMBER_AID,
        'POST',
        `/contributions/${cid}/submit-evidence`,
        { completion_notes: 'x' },
      ),
    ).toBe(403);
    expect(
      await status(
        CONTRIB_AID,
        'POST',
        `/contributions/${cid}/submit-evidence`,
        {
          completion_notes: 'done',
        },
      ),
    ).not.toBe(403);

    // --- The admin UI is unchanged: the projects view still loads. ---
    const enterBtn = adminPage.getByRole('button', {
      name: /enter community/i,
    });
    await enterBtn.click({ timeout: 15_000 }).catch(() => {});
    await adminPage
      .getByRole('button', { name: /projects/i })
      .first()
      .click()
      .catch(() => {});
    await snap(adminPage, 'projects-view-after-scoped-rbac');
  });
});
