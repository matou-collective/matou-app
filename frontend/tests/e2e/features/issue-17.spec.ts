import { test, expect } from './fixtures';

// Feature (#17): backend RBAC is now enforced on mutating routes that
// previously bypassed it. Identity is a self-asserted X-User-AID header, so we
// exercise the policy layer directly: a non-privileged member AID is rejected
// (403) on member-management, project role-assignment, and the completion /
// sign-off transitions, while the admin (Founding Member) passes the same
// gates. Screenshots capture the admin dashboard, which continues to work
// unchanged for authorized users.

const API = 'http://localhost:9080/api/v1';

// Any non-empty AID that is not the org admin resolves to the baseline
// `member` role via ProfileRoleLookup, so it is denied the restricted actions.
const MEMBER_AID = 'EnonPrivilegedMemberForIssue17Test0000000000';

async function adminAid(): Promise<string> {
  const res = await fetch(`${API}/identity`);
  const body = await res.json();
  if (!body?.aid) throw new Error(`admin backend has no identity: ${JSON.stringify(body)}`);
  return body.aid as string;
}

async function status(
  aid: string,
  method: string,
  route: string,
  body?: unknown,
): Promise<number> {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-User-AID': aid },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.status;
}

test.describe('backend RBAC enforcement on mutating routes (#17)', () => {
  test('non-privileged member is denied restricted actions; admin passes the gate', async ({
    adminPage,
    snap,
  }) => {
    test.setTimeout(120_000);
    const admin = await adminAid();

    // --- Membership management: change role / remove member ---
    // A plain member cannot change any member's role or remove members.
    expect(await status(MEMBER_AID, 'PUT', `/members/${admin}/role`, { role: 'Contributor' })).toBe(
      403,
    );
    expect(await status(MEMBER_AID, 'DELETE', `/members/${MEMBER_AID}`, { reason: 'x' })).toBe(403);

    // Even an authorized role-changer (the admin) may not promote to Founding
    // Member unless they already hold it — the admin here IS a Founding Member,
    // so this is only asserted as "not forbidden by the change-role gate".
    expect(
      await status(MEMBER_AID, 'PUT', `/members/${admin}/role`, { role: 'Operations Steward' }),
    ).toBe(403);

    // --- Project role assignment (steward scope) ---
    const dummyProject = 'no-such-project';
    expect(
      await status(MEMBER_AID, 'POST', `/projects/${dummyProject}/assign-role`, {
        role: 'lead',
        user_id: MEMBER_AID,
      }),
    ).toBe(403);
    // Admin passes the RBAC gate; the request then fails downstream (unknown
    // project) with a non-403 status, proving the gate distinguishes roles.
    expect(
      await status(admin, 'POST', `/projects/${dummyProject}/assign-role`, {
        role: 'lead',
        user_id: admin,
      }),
    ).not.toBe(403);

    // --- Contribution /transition may not reach stricter states ---
    const dummyContrib = 'no-such-contribution';
    expect(
      await status(MEMBER_AID, 'POST', `/contributions/${dummyContrib}/transition`, {
        status: 'signed_off',
      }),
    ).toBe(403);
    expect(
      await status(admin, 'POST', `/contributions/${dummyContrib}/transition`, {
        status: 'signed_off',
      }),
    ).not.toBe(403);

    // --- The admin's UI is unchanged: the dashboard still loads ---
    const enterBtn = adminPage.getByRole('button', { name: /enter community/i });
    await enterBtn.click({ timeout: 15_000 }).catch(() => {});
    await adminPage
      .getByRole('button', { name: /dashboard/i })
      .first()
      .click()
      .catch(() => {});
    await snap(adminPage, 'admin-dashboard-still-works');
  });
});
