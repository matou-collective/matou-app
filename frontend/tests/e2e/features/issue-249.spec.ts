import { test, expect, Page } from './fixtures';
import { loginAs, jsonSessionHeaders } from '../utils/signed-auth';

// Feature (#249, refs #177 slice 4/5): push-notification frontend.
//
// User-facing surfaces this spec exercises (the receipt handler + token
// lifecycle are covered by the Vitest unit suite with the Capacitor plugin
// mocked — they can't run without a device/Firebase):
//   1. The Notifications settings card in Account Settings — a global push
//      toggle plus a per-channel mute list (docs/architecture/
//      08-push-notifications.md §7).
//   2. The notification-tap deep link — /chat?c=<channelId> selects that
//      channel on mount, no router change (§6). We drive the same URL a tap
//      would open.

const API = 'http://localhost:9080/api/v1';
const SETTINGS_URL = '/#/dashboard/settings';
const CHAT_DEEPLINK = (channelId: string) => `/#/dashboard/chat?c=${encodeURIComponent(channelId)}`;

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

async function enterCommunity(page: Page) {
  await page
    .getByRole('button', { name: /enter community/i })
    .click({ timeout: 15_000 })
    .catch(() => {});
}

test.describe('push notification preferences + deep link (#249)', () => {
  test('the notifications settings card toggles push and mutes a channel', async ({
    adminPage,
    snap,
  }) => {
    test.setTimeout(180_000);

    const aid = await adminAid();
    await loginAs(adminPage);

    // Seed a channel so the per-channel mute list has an entry to render.
    const runTag = Date.now().toString(36);
    const channelName = `push-${runTag}`;
    await api(aid, 'POST', '/chat/channels', {
      name: channelName,
      description: 'Seeded by the issue-249 feature spec.',
    });

    await enterCommunity(adminPage);
    await adminPage.goto(SETTINGS_URL);

    const card = adminPage.locator('[data-test="push-settings"]');
    await expect(card).toBeVisible({ timeout: 20_000 });
    await snap(adminPage, 'settings-notifications-card');

    // Push is enabled by default → the mute list is shown and lists the channel.
    const channelRow = adminPage
      .locator('[data-test^="push-channel-"]')
      .filter({ hasText: channelName });
    await expect(channelRow).toBeVisible({ timeout: 15_000 });

    // Mute the seeded channel.
    await channelRow.scrollIntoViewIfNeeded();
    await channelRow.locator('input[type="checkbox"]').click();
    await snap(adminPage, 'settings-channel-muted');

    // Turn the global toggle off → the per-channel mute list is hidden.
    await adminPage.locator('[data-test="push-enabled-toggle"]').click();
    await expect(
      adminPage.locator('[data-test="push-settings"]').getByText(`#${channelName}`),
    ).toHaveCount(0);
    await snap(adminPage, 'settings-push-disabled');
  });

  test('a notification tap deep-links to /chat?c=<channelId>', async ({ adminPage, snap }) => {
    test.setTimeout(180_000);

    const aid = await adminAid();
    await loginAs(adminPage);

    const runTag = Date.now().toString(36);
    const channelName = `deeplink-${runTag}`;
    const { channelId } = await api(aid, 'POST', '/chat/channels', {
      name: channelName,
      description: 'Seeded by the issue-249 feature spec.',
    });

    await enterCommunity(adminPage);
    // Drive the exact URL a notification tap opens.
    await adminPage.goto(CHAT_DEEPLINK(channelId));

    // ChatPage selects the deep-linked channel on mount.
    await expect(adminPage.locator('.channel-header .channel-name')).toHaveText(channelName, {
      timeout: 20_000,
    });
    await snap(adminPage, 'deep-link-channel-selected');
  });
});
