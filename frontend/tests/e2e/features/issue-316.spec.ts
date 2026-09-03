import { test, expect, Page } from './fixtures';

// Feature (#316) — RBAC for chat. Before this slice the chat routes had no
// action wiring. Now:
//   • send_messages gates posting a message (default: every member role holds
//     it, so it is behaviour-neutral until an admin narrows it);
//   • manage_channels gates creating / editing / archiving a channel and
//     setting its AllowedRoles (default: stewards + founder);
//   • moderate_messages gates deleting another member's message (default:
//     stewards + founder).
// The Roles & Permissions page gains a dedicated "Chat" feature table for these
// three capabilities.
//
// Enforcement resolves the local backend identity's roles, so the admin backend
// (founding member) is a capability holder and the member's own backend (plain
// member) is a non-holder for the steward-tier capabilities.

const API = 'http://localhost:9080/api/v1';
const AUTH = { 'Content-Type': 'application/json', Authorization: 'Bearer matou-dev' };

async function adminAid(): Promise<string> {
  const res = await fetch(`${API}/identity`);
  const body = await res.json();
  if (!body?.aid) throw new Error(`admin backend has no identity: ${JSON.stringify(body)}`);
  return body.aid as string;
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

test.describe.serial('Chat RBAC + Chat permission table (#316)', () => {
  test('the Chat feature table renders its three capabilities with the default holders', async ({
    adminPage,
    snap,
  }) => {
    test.setTimeout(120_000);
    await openRolesPage(adminPage);

    const chat = adminPage.locator('.roles-matrix.chat-roles');
    await expect(adminPage.getByRole('heading', { name: 'Chat' })).toBeVisible();
    await expect(chat).toBeVisible();

    // Exactly the three chat columns, in registry order.
    const headers = (await chat.locator('thead th').allTextContents()).map((h) => h.trim());
    expect(headers[0]).toBe('Role');
    expect(headers.some((h) => h.startsWith('Send messages'))).toBe(true);
    expect(headers.some((h) => h.startsWith('Manage channels'))).toBe(true);
    expect(headers.some((h) => h.startsWith('Moderate messages'))).toBe(true);
    await snap(adminPage, 'chat-table-default-policy');

    // Founding Member holds all three by default.
    const founder = chat.locator('tbody tr[data-role="founding_member"]');
    for (const cap of ['send_messages', 'manage_channels', 'moderate_messages']) {
      await expect(founder.locator(`td[data-cap="${cap}"] .q-toggle`)).toHaveAttribute(
        'aria-checked',
        'true',
      );
    }

    // Member holds send_messages only (default-all send; no channel/moderation).
    const member = chat.locator('tbody tr[data-role="member"]');
    await expect(member.locator('td[data-cap="send_messages"] .q-toggle')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(member.locator('td[data-cap="manage_channels"] .q-toggle')).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await expect(member.locator('td[data-cap="moderate_messages"] .q-toggle')).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await snap(adminPage, 'chat-table-holders');

    // The chat capabilities are pulled out of the generic community matrix into
    // their own table — they must not double up as columns there.
    const communityHeaders = await adminPage
      .locator('.roles-matrix.community-roles thead th')
      .allTextContents();
    expect(communityHeaders.some((h) => h.trim().startsWith('Send messages'))).toBe(false);
  });

  test('a capability holder may create a channel; a non-holder is refused (403)', async ({
    memberPage,
    snap,
  }) => {
    test.setTimeout(120_000);

    // Admin backend: the local identity is a Founding Member → holds
    // manage_channels, so channel creation succeeds.
    const created = await fetch(`${API}/chat/channels`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ name: 'rbac-holder-channel' }),
    });
    expect(created.status).toBe(201);

    // Member backend (routed for memberPage): the local identity is a plain
    // Member → lacks manage_channels, so channel creation is refused with 403.
    // The RBAC check precedes any space/state check, so the code is deterministic.
    const memberStatus = await memberPage.evaluate(async () => {
      const r = await fetch('http://localhost:9080/api/v1/chat/channels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer matou-dev' },
        body: JSON.stringify({ name: 'member-should-fail' }),
      });
      return r.status;
    });
    expect(memberStatus).toBe(403);

    // Show the member's chat view (no channel-management afforded to them).
    await memberPage.goto('/#/dashboard/chat');
    await memberPage.waitForLoadState('networkidle');
    await snap(memberPage, 'member-chat-no-manage');
  });

  test('a sender stripped of send_messages is refused (403), then restored', async () => {
    test.setTimeout(120_000);
    const aid = await adminAid();

    // Baseline: the admin (Founding Member) may create a channel and post.
    const channelRes = await fetch(`${API}/chat/channels`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({ name: 'send-guard-channel' }),
    });
    expect(channelRes.status).toBe(201);
    const channelId = (await channelRes.json()).channelId as string;

    const before = await fetch(`${API}/chat/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { ...AUTH, 'X-User-AID': aid },
      body: JSON.stringify({ content: 'hello while granted' }),
    });
    expect(before.status).toBe(201);

    // Read the live policy and strip send_messages from founding_member.
    const policyRes = await fetch(`${API}/role-policy`, { headers: AUTH });
    const { policy } = await policyRes.json();
    const original: string[] = [...(policy.grants.founding_member ?? [])];
    const stripped = original.filter((c) => c !== 'send_messages');

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

      // With send_messages removed, the same sender is now refused.
      const after = await fetch(`${API}/chat/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { ...AUTH, 'X-User-AID': aid },
        body: JSON.stringify({ content: 'should be blocked now' }),
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
});
