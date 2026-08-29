import { test, expect, Page } from './fixtures';
import { loginAs, jsonSessionHeaders } from '../utils/signed-auth';

// Feature (#168): on mobile the chat composer ("Type a message…" + send button)
// was rendered underneath the fixed bottom tab bar / Android navigation bar and
// could not be tapped — the `.chat-page` filled the whole viewport height while
// `nav.bottom-nav` (position: fixed) overlaid its bottom edge. The fix reserves
// space below the chat column equal to the tab-bar height + bottom safe-area
// inset, so the composer sits fully above `nav.bottom-nav`.
//
// This is distinct from #125 (list resize under the keyboard) and #126 (tab bar
// auto-hide): those concern the keyboard-open state; here the composer must be
// reachable in the first place, keyboard closed.

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

async function openChannel(page: Page, channelName: string) {
  await page.getByRole('button', { name: /enter community/i }).click({ timeout: 15_000 }).catch(() => {});
  await page.goto(CHAT_URL);
  await expect(page.locator('.sidebar-title')).toHaveText('Channels', { timeout: 20_000 });
  const channelItem = page.locator('.channel-item').filter({ hasText: channelName });
  await expect(channelItem).toBeVisible({ timeout: 15_000 });
  await channelItem.click();
  await expect(page.locator('.channel-header .channel-name')).toBeVisible({ timeout: 10_000 });
}

test.describe('chat composer clears the bottom tab bar (#168)', () => {
  test('composer is fully visible above nav.bottom-nav at phone width', async ({
    adminPage,
    snap,
  }) => {
    test.setTimeout(180_000);

    const aid = await adminAid();
    await loginAs(adminPage);

    const runTag = Date.now().toString(36);
    const channelName = `composer-${runTag}`;
    const { channelId } = await api(aid, 'POST', '/chat/channels', {
      name: channelName,
      description: 'Seeded by the issue-168 feature spec.',
    });
    for (let i = 1; i <= 3; i++) {
      await api(aid, 'POST', `/chat/channels/${channelId}/messages`, {
        content: `Message ${i} of 3 — the composer below must stay tappable.`,
      });
    }

    await adminPage.setViewportSize(PHONE);
    await openChannel(adminPage, channelName);

    const composer = adminPage.locator('.message-composer');
    const bottomNav = adminPage.locator('nav.bottom-nav');
    await expect(composer).toBeVisible({ timeout: 10_000 });
    // The bottom tab bar is what the composer used to hide behind.
    await expect(bottomNav).toBeVisible();

    const composerBox = await composer.boundingBox();
    const navBox = await bottomNav.boundingBox();
    expect(composerBox).not.toBeNull();
    expect(navBox).not.toBeNull();
    if (!composerBox || !navBox) return;

    // The composer sits entirely above the tab bar: its bottom edge does not
    // cross the tab bar's top edge (1px tolerance for sub-pixel rounding).
    expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(navBox.y + 1);

    // …and it is within the viewport, not pushed off-screen.
    expect(composerBox.y).toBeGreaterThanOrEqual(0);
    expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(PHONE.height + 1);

    // The centre of the composer is actually the composer (not the nav): the
    // element hit-tested there belongs to the composer, so it is tappable.
    const composerOwnsCentre = await composer.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return el.contains(hit);
    });
    expect(composerOwnsCentre).toBe(true);

    await snap(adminPage, 'composer-above-tab-bar');
  });
});
