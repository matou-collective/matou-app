import { test, expect, Page } from './fixtures';

// Feature (#317) — RBAC for the notice board. Before this slice the notice
// routes were gated only by space read/write. Now:
//   • post_notices gates authoring a notice — create and publish (default:
//     every community member role holds it, so it is behaviour-neutral until an
//     admin narrows it);
//   • manage_notices gates moderating any member's notice — pin and archive
//     (default: stewards + founder).
// The Roles & Permissions page gains a dedicated "Notices" feature table for
// these two capabilities.
//
// Enforcement resolves the caller's roles from the X-User-AID header, so the
// admin identity (founding member) holds both capabilities while a plain member
// holds post_notices only.

const API = 'http://localhost:9080/api/v1';
const AUTH = { 'Content-Type': 'application/json', Authorization: 'Bearer matou-dev' };

async function adminAid(): Promise<string> {
  const res = await fetch(`${API}/identity`);
  const body = await res.json();
  if (!body?.aid) throw new Error(`admin backend has no identity: ${JSON.stringify(body)}`);
  return body.aid as string;
}

// Create a notice on the admin backend as the given caller. Returns the new
// notice id. Published notices can then be pinned/archived.
async function createNotice(aid: string, title: string): Promise<string> {
  const res = await fetch(`${API}/notices`, {
    method: 'POST',
    headers: { ...AUTH, 'X-User-AID': aid },
    body: JSON.stringify({
      type: 'announcement',
      title,
      summary: 'RBAC fixture notice',
      state: 'published',
    }),
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  const id = body.noticeId ?? body.id ?? body.notice?.id;
  if (!id) throw new Error(`create notice returned no id: ${JSON.stringify(body)}`);
  return id as string;
}

// Navigate to the Roles & Permissions page from wherever login left the app.
async function openRolesPage(page: Page): Promise<void> {
  const enter = page.getByRole('button', { name: /enter community/i });
  if (await enter.isVisible().catch(() => false)) {
    await enter.click();
  }
  const rolesNav = page.locator('.nav-item', { hasText: 'Roles' });
  await expect(rolesNav).toBeVisible({ timeout: 30_000 });
  await rolesNav.click();
  await expect(page.getByRole('heading', { name: 'Roles & Permissions' })).toBeVisible();
}

test.describe.serial('Notices RBAC + Notices permission table (#317)', () => {
  test('the Notices feature table renders its two capabilities with the default holders', async ({
    adminPage,
    snap,
  }) => {
    test.setTimeout(120_000);
    await openRolesPage(adminPage);

    const notices = adminPage.locator('.roles-matrix.notices-roles');
    await expect(adminPage.getByRole('heading', { name: 'Notices' })).toBeVisible();
    await expect(notices).toBeVisible();

    // Exactly the two notice columns, in registry order.
    const headers = (await notices.locator('thead th').allTextContents()).map((h) => h.trim());
    expect(headers[0]).toBe('Role');
    expect(headers.some((h) => h.startsWith('Post notices'))).toBe(true);
    expect(headers.some((h) => h.startsWith('Manage notices'))).toBe(true);
    await snap(adminPage, 'notices-table-default-policy');

    // Founding Member holds both by default.
    const founder = notices.locator('tbody tr[data-role="founding_member"]');
    for (const cap of ['post_notices', 'manage_notices']) {
      await expect(founder.locator(`td[data-cap="${cap}"] .q-toggle`)).toHaveAttribute(
        'aria-checked',
        'true',
      );
    }

    // Member holds post_notices only (default-all posting; no moderation).
    const member = notices.locator('tbody tr[data-role="member"]');
    await expect(member.locator('td[data-cap="post_notices"] .q-toggle')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(member.locator('td[data-cap="manage_notices"] .q-toggle')).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await snap(adminPage, 'notices-table-holders');

    // The notice capabilities are pulled out of the generic community matrix
    // into their own table — they must not double up as columns there.
    const communityHeaders = await adminPage
      .locator('.roles-matrix.community-roles thead th')
      .allTextContents();
    expect(communityHeaders.some((h) => h.trim().startsWith('Post notices'))).toBe(false);
  });

  test('post_notices gates create: a caller without it is refused (403), then restored', async () => {
    test.setTimeout(120_000);
    const aid = await adminAid();

    // Baseline: the admin (Founding Member) may create a notice.
    const before = await fetch(`${API}/notices`, {
      method: 'POST',
      headers: { ...AUTH, 'X-User-AID': aid },
      body: JSON.stringify({ type: 'update', title: 'granted', summary: 'while granted' }),
    });
    expect(before.status).toBe(201);

    // Read the live policy and strip post_notices from founding_member.
    const { policy } = await (await fetch(`${API}/role-policy`, { headers: AUTH })).json();
    const original: string[] = [...(policy.grants.founding_member ?? [])];
    const stripped = original.filter((c) => c !== 'post_notices');

    try {
      const put = await fetch(`${API}/role-policy`, {
        method: 'PUT',
        headers: { ...AUTH, 'X-User-AID': aid },
        body: JSON.stringify({
          version: policy.version,
          roles: policy.roles,
          grants: { ...policy.grants, founding_member: stripped },
        }),
      });
      expect(put.ok).toBe(true);

      // With post_notices removed, the same caller is now refused on create.
      const after = await fetch(`${API}/notices`, {
        method: 'POST',
        headers: { ...AUTH, 'X-User-AID': aid },
        body: JSON.stringify({ type: 'update', title: 'blocked', summary: 'should 403 now' }),
      });
      expect(after.status).toBe(403);
    } finally {
      // Restore the grant so the shared admin policy is left as we found it.
      const latest = await (await fetch(`${API}/role-policy`, { headers: AUTH })).json();
      await fetch(`${API}/role-policy`, {
        method: 'PUT',
        headers: { ...AUTH, 'X-User-AID': aid },
        body: JSON.stringify({
          version: latest.policy.version,
          roles: latest.policy.roles,
          grants: { ...latest.policy.grants, founding_member: original },
        }),
      });
    }
  });

  test('manage_notices gates pin/archive: a steward moderates, a caller without it is refused (403)', async () => {
    test.setTimeout(120_000);
    const aid = await adminAid();

    // The admin (Founding Member = steward tier) holds manage_notices, so it may
    // pin and archive a notice — moderation authority over any member's notice.
    const noticeId = await createNotice(aid, 'moderation target');
    const pin = await fetch(`${API}/notices/${encodeURIComponent(noticeId)}/pin`, {
      method: 'POST',
      headers: { ...AUTH, 'X-User-AID': aid },
    });
    expect(pin.ok).toBe(true);
    const archive = await fetch(`${API}/notices/${encodeURIComponent(noticeId)}/archive`, {
      method: 'POST',
      headers: { ...AUTH, 'X-User-AID': aid },
    });
    expect(archive.ok).toBe(true);

    // Strip manage_notices from founding_member: the same caller — who keeps
    // post_notices, so may still author — is now refused pin/archive (403). This
    // is exactly a plain member's posture: may post, may not moderate.
    const { policy } = await (await fetch(`${API}/role-policy`, { headers: AUTH })).json();
    const original: string[] = [...(policy.grants.founding_member ?? [])];
    const stripped = original.filter((c) => c !== 'manage_notices');

    try {
      const put = await fetch(`${API}/role-policy`, {
        method: 'PUT',
        headers: { ...AUTH, 'X-User-AID': aid },
        body: JSON.stringify({
          version: policy.version,
          roles: policy.roles,
          grants: { ...policy.grants, founding_member: stripped },
        }),
      });
      expect(put.ok).toBe(true);

      const target = await createNotice(aid, 'unmoderatable');
      const pinDenied = await fetch(`${API}/notices/${encodeURIComponent(target)}/pin`, {
        method: 'POST',
        headers: { ...AUTH, 'X-User-AID': aid },
      });
      expect(pinDenied.status).toBe(403);
      const archiveDenied = await fetch(`${API}/notices/${encodeURIComponent(target)}/archive`, {
        method: 'POST',
        headers: { ...AUTH, 'X-User-AID': aid },
      });
      expect(archiveDenied.status).toBe(403);
    } finally {
      const latest = await (await fetch(`${API}/role-policy`, { headers: AUTH })).json();
      await fetch(`${API}/role-policy`, {
        method: 'PUT',
        headers: { ...AUTH, 'X-User-AID': aid },
        body: JSON.stringify({
          version: latest.policy.version,
          roles: latest.policy.roles,
          grants: { ...latest.policy.grants, founding_member: original },
        }),
      });
    }
  });
});
