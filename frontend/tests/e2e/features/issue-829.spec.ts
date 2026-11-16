import { test, expect, Page } from './fixtures';

// Regression (#829) — "Admins only" channels never showed up anywhere.
//
// The CreateChannelModal writes allowedRoles ["admin","steward"] for the
// "Admins only" visibility option. The backend channel-list read filtered each
// channel's gate against the caller's role, but resolved that role with a stub
// (getUserRole) that returned an empty string for everyone — so the gate matched
// no one and an admins-only channel was hidden from every user, the steward who
// created it included. The fix resolves the caller's real roles and matches the
// gate word-aware (so the "steward" label admits an operations_steward), the
// same rule the push-side gate already used.
//
// Enforcement runs on the local backend identity's roles: the admin backend is a
// Founding Member (steward-tier) and so may see the channel; the member backend
// is a plain member and so may not.

const API = 'http://localhost:9080/api/v1';
const AUTH = { 'Content-Type': 'application/json', Authorization: 'Bearer matou-dev' };

// A unique name so repeated runs against the shared admin backend don't collide.
const CHANNEL_NAME = `admins-only-829-${Date.now()}`;

async function enterCommunity(page: Page): Promise<void> {
  const enter = page.getByRole('button', { name: /enter community/i });
  if (await enter.isVisible().catch(() => false)) {
    await enter.click();
  }
}

test.describe.serial('Admins-only channel visibility (#829)', () => {
  test('a steward sees the admins-only channel they created', async ({ adminPage, snap }) => {
    test.setTimeout(120_000);

    // Admin backend (Founding Member) creates an "Admins only" channel — the
    // exact gate the CreateChannelModal writes.
    const created = await fetch(`${API}/chat/channels`, {
      method: 'POST',
      headers: AUTH,
      body: JSON.stringify({
        name: CHANNEL_NAME,
        allowedRoles: ['admin', 'steward'],
      }),
    });
    expect(created.status).toBe(201);
    const channelId = (await created.json()).channelId as string;

    // The channel list served to the steward now includes it (the bug: it did
    // not — the gate hid it from everyone).
    const list = await (await fetch(`${API}/chat/channels`, { headers: AUTH })).json();
    const names = (list.channels as Array<{ id: string; name: string }>).map((c) => c.name);
    expect(names).toContain(CHANNEL_NAME);

    // The detail endpoint serves it to the steward too (no 403).
    const detail = await fetch(`${API}/chat/channels/${channelId}`, { headers: AUTH });
    expect(detail.status).toBe(200);

    // And it appears in the steward's chat sidebar.
    await enterCommunity(adminPage);
    await adminPage.goto('/#/dashboard/chat');
    await adminPage.waitForLoadState('networkidle');
    await expect(adminPage.locator('.channel-name', { hasText: CHANNEL_NAME })).toBeVisible({
      timeout: 30_000,
    });
    await snap(adminPage, 'steward-sees-admins-only-channel');
  });

  test('a plain member does not see the admins-only channel', async ({ memberPage, snap }) => {
    test.setTimeout(120_000);

    // Member backend (plain member) list must not include the gated channel.
    const names = await memberPage.evaluate(async () => {
      const r = await fetch('http://localhost:9080/api/v1/chat/channels', {
        headers: { Authorization: 'Bearer matou-dev' },
      });
      const body = await r.json();
      return (body.channels as Array<{ name: string }>).map((c) => c.name);
    });
    expect(names).not.toContain(CHANNEL_NAME);

    await memberPage.goto('/#/dashboard/chat');
    await memberPage.waitForLoadState('networkidle');
    await expect(
      memberPage.locator('.channel-name', { hasText: CHANNEL_NAME }),
    ).toHaveCount(0);
    await snap(memberPage, 'member-does-not-see-admins-only-channel');
  });
});
