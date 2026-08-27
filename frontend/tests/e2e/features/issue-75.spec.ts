import { test, expect, Page } from './fixtures';
import { loginAs, jsonSessionHeaders } from '../utils/signed-auth';

// Feature (#75): mobile single-pane ChatLayout. On a phone viewport (≤767px)
// the 3-pane chat (channel list | messages | thread) collapses to one pane:
//   - no channel selected  → the channel list fills the screen
//   - a channel selected   → the message view fills the screen, and the
//     ChannelHeader shows a back button that returns to the list
// Desktop (≥768px) keeps the side-by-side panes unchanged.

const API = 'http://localhost:9080/api/v1';
const CHAT_URL = '/#/dashboard/chat';
const PHONE = { width: 390, height: 844 };

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

// Navigate to chat and make sure we're on the channel-list pane. Chat may
// auto-select a channel on mount; if so, click the mobile back button to
// return to the list.
async function gotoChatList(page: Page) {
  await page.getByRole('button', { name: /enter community/i }).click({ timeout: 15_000 }).catch(() => {});
  await page.goto(CHAT_URL);
  await expect(page.locator('.sidebar-title')).toHaveText('Channels', { timeout: 20_000 });

  const backBtn = page.locator('.channel-header .back-btn');
  if (await backBtn.isVisible().catch(() => false)) {
    await backBtn.click();
  }
}

test.describe('mobile single-pane chat (#75)', () => {
  test('list → channel → back → list, single pane at 390×844', async ({ adminPage, snap }) => {
    test.setTimeout(180_000);

    const aid = await adminAid();
    await loginAs(adminPage); // signed-auth session so API calls act as the admin
    const runTag = Date.now().toString(36);
    const channelName = `mobile-nav-${runTag}`;
    await api(aid, 'POST', '/chat/channels', {
      name: channelName,
      description: 'Seeded by the issue-75 feature spec.',
    });

    await adminPage.setViewportSize(PHONE);
    await gotoChatList(adminPage);

    // List pane: the channel sidebar fills the screen; no message header yet.
    const sidebar = adminPage.locator('.channel-sidebar');
    const header = adminPage.locator('.channel-header');
    await expect(sidebar).toBeVisible();
    await expect(header).toHaveCount(0);
    await snap(adminPage, 'mobile-channel-list');

    // Open a channel → message pane replaces the list (single pane), and the
    // back button appears in the header.
    const channelItem = adminPage.locator('.channel-item').filter({ hasText: channelName });
    await expect(channelItem).toBeVisible({ timeout: 15_000 });
    await channelItem.click();

    await expect(header.locator('.channel-name')).toHaveText(channelName, { timeout: 10_000 });
    await expect(adminPage.locator('.channel-header .back-btn')).toBeVisible();
    await expect(sidebar).toHaveCount(0);
    await snap(adminPage, 'mobile-channel-open');

    // Back → the list pane returns; the message header is gone again.
    await adminPage.locator('.channel-header .back-btn').click();
    await expect(sidebar).toBeVisible();
    await expect(header).toHaveCount(0);
    await snap(adminPage, 'mobile-back-to-list');
  });

  test('desktop keeps list and message panes side by side', async ({ adminPage, snap }) => {
    test.setTimeout(180_000);

    const aid = await adminAid();
    await loginAs(adminPage); // signed-auth session so API calls act as the admin
    const runTag = Date.now().toString(36);
    const channelName = `desktop-panes-${runTag}`;
    await api(aid, 'POST', '/chat/channels', {
      name: channelName,
      description: 'Seeded by the issue-75 feature spec.',
    });

    // Default (desktop) viewport — both panes coexist and no back button shows.
    await adminPage.getByRole('button', { name: /enter community/i }).click({ timeout: 15_000 }).catch(() => {});
    await adminPage.goto(CHAT_URL);
    await expect(adminPage.locator('.sidebar-title')).toHaveText('Channels', { timeout: 20_000 });

    const channelItem = adminPage.locator('.channel-item').filter({ hasText: channelName });
    await expect(channelItem).toBeVisible({ timeout: 15_000 });
    await channelItem.click();

    // Both the channel list and the message header are visible together.
    await expect(adminPage.locator('.channel-sidebar')).toBeVisible();
    await expect(adminPage.locator('.channel-header .channel-name')).toHaveText(channelName, { timeout: 10_000 });
    // No back button on desktop.
    await expect(adminPage.locator('.channel-header .back-btn')).toHaveCount(0);
    await snap(adminPage, 'desktop-three-pane');
  });
});
