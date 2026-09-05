import { test, expect, Page } from './fixtures';

// Feature (#315): Proposals gets its own per-feature permission table on the
// Community Settings page, with two columns — Create proposals (NEW
// create_proposals capability, gating proposal create + submit) and Governance
// (existing manage_governance). Community roles hold both freely; a project
// role appears in this table only when it grandfather-holds a governance grant
// (per #201, project_steward's manage_governance), which may be switched off
// but never re-added. Backend now enforces create_proposals on the proposal
// create/submit endpoints — a role stripped of it gets a 403.

const API = 'http://localhost:9080/api/v1';

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

function proposalBody(proposerId: string) {
  return {
    proposer_id: proposerId,
    title: 'Create-gate probe',
    type: ['technical'],
    priority: 'low',
    description: 'd',
    problem_statement: 'p',
    solution: 's',
    expected_outcomes: ['o'],
    estimated_budget: '$0',
    timeline: '1w',
  };
}

async function openRolesPage(page: Page): Promise<void> {
  const enter = page.getByRole('button', { name: /enter community/i });
  if (await enter.isVisible().catch(() => false)) {
    await enter.click();
  }
  const gear = page.locator('.community-settings-btn');
  await expect(gear).toBeVisible({ timeout: 30_000 });
  await gear.click();
  await expect(page.getByRole('heading', { name: 'Community Settings' })).toBeVisible();
}

test.describe('Proposals permission table (#315)', () => {
  test('renders its own table; project_steward governance is grandfathered', async ({
    adminPage,
    snap,
  }) => {
    test.setTimeout(120_000);
    await openRolesPage(adminPage);

    // The Proposals feature table exists with exactly its two columns.
    await expect(adminPage.getByRole('heading', { name: 'Proposals' })).toBeVisible();
    const proposals = adminPage.locator('.roles-matrix.proposals-table');
    await expect(proposals).toBeVisible();
    const headers = (await proposals.locator('thead th').allTextContents()).map((h) => h.trim());
    expect(headers).toEqual(['Role', 'Create proposals', 'Governance']);
    await snap(adminPage, 'proposals-table-default-policy');

    // Community roles appear; a member holds create_proposals by default.
    await expect(proposals.locator('tbody tr', { hasText: 'Member' }).first()).toBeVisible();
    const memberCreate = proposals.locator('td[data-role="member"][data-cap="create_proposals"] .q-toggle');
    await expect(memberCreate).toHaveAttribute('aria-checked', 'true');

    // project_steward is grandfathered in: it shows here with manage_governance
    // ON, but create_proposals (community-only) is disabled — it can never gain
    // a community-only capability it does not already hold.
    const stewardRow = proposals.locator('tbody tr', { hasText: 'Project Steward' });
    await expect(stewardRow).toBeVisible();
    const stewardGov = proposals.locator(
      'td[data-role="project_steward"][data-cap="manage_governance"] .q-toggle',
    );
    await expect(stewardGov).toHaveAttribute('aria-checked', 'true');
    const stewardCreate = proposals.locator(
      'td[data-role="project_steward"][data-cap="create_proposals"] .q-toggle',
    );
    await expect(stewardCreate).toHaveAttribute('aria-disabled', 'true');
    await snap(adminPage, 'grandfathered-project-steward-row');

    // The two proposal columns have moved OUT of the shared Community table.
    const community = adminPage.locator('.roles-matrix.community-roles');
    const communityHeaders = (await community.locator('thead th').allTextContents()).map((h) =>
      h.trim(),
    );
    expect(communityHeaders).not.toContain('Create proposals');
    expect(communityHeaders).not.toContain('Governance');
  });

  test('a role stripped of create_proposals is refused proposal create (403)', async () => {
    const aid = await adminAid();

    // Baseline: admin (Founding Member) can create.
    const asAdmin = await apiJson(aid, 'POST', '/proposals', proposalBody(aid));
    expect(asAdmin.status, JSON.stringify(asAdmin.body)).toBe(201);

    // A plain AID resolves to the `member` role by default and can create too.
    const memberAid = 'member-create-probe';
    const before = await apiJson(memberAid, 'POST', '/proposals', proposalBody(memberAid));
    expect(before.status, JSON.stringify(before.body)).toBe(201);

    // Narrow the org: strip create_proposals from the member role.
    const current = await apiJson(aid, 'GET', '/role-policy');
    expect(current.status).toBe(200);
    const grants = { ...current.body.policy.grants } as Record<string, string[]>;
    grants['member'] = (grants['member'] ?? []).filter((c) => c !== 'create_proposals');
    const put = await apiJson(aid, 'PUT', '/role-policy', {
      version: current.body.policy.version,
      roles: current.body.policy.roles,
      grants,
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);

    try {
      // Now a member-only caller is forbidden from creating.
      const after = await apiJson(memberAid, 'POST', '/proposals', proposalBody(memberAid));
      expect(after.status, JSON.stringify(after.body)).toBe(403);
    } finally {
      // Restore the original policy so other specs see the default grants.
      const now = await apiJson(aid, 'GET', '/role-policy');
      await apiJson(aid, 'PUT', '/role-policy', {
        version: now.body.policy.version,
        roles: current.body.policy.roles,
        grants: current.body.policy.grants,
      });
    }
  });

  test('the #201 governance grandfather still holds: a project role cannot gain manage_governance (400)', async () => {
    const aid = await adminAid();
    const current = await apiJson(aid, 'GET', '/role-policy');
    expect(current.status).toBe(200);

    const grants = { ...current.body.policy.grants } as Record<string, string[]>;
    // project_lead is a project role that does NOT already hold manage_governance.
    grants['project_lead'] = [...(grants['project_lead'] ?? []), 'manage_governance'];

    const rejected = await apiJson(aid, 'PUT', '/role-policy', {
      version: current.body.policy.version,
      roles: current.body.policy.roles,
      grants,
    });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(400);
    expect(String(rejected.body?.error)).toMatch(/community-only capability/i);
  });
});
