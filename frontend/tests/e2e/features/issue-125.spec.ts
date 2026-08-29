import { test, expect, Page } from './fixtures';
import { loginAs, jsonSessionHeaders } from '../utils/signed-auth';

// Feature (#125): on mobile the chat column is sized to a fixed 100vh, so when
// the soft keyboard opens the message list keeps its full height and, in a
// channel with only a few messages, the earliest messages are pushed behind the
// keyboard. The fix sizes the `.chat-page` to `window.visualViewport.height`
// (which shrinks under the keyboard while 100vh does not) on mobile, and the
// message list re-pins to the latest message on a visual-viewport resize.
//
// A real soft keyboard can't be summoned in headless Chromium, so we simulate
// it the way our code observes it: shadow `visualViewport.height` with a
// smaller value and dispatch its `resize` event. That drives the exact code
// path the keyboard would (ChatPage's height binding + MessageList's re-pin).

const API = 'http://localhost:9080/api/v1';
const CHAT_URL = '/#/dashboard/chat';
const PHONE = { width: 390, height: 844 };
const KEYBOARD_HEIGHT = 340; // visible area once a soft keyboard is up.

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

// Shadow visualViewport.height (or restore it) and fire the resize event our
// composable listens for. height=null restores the real getter.
async function fakeKeyboard(page: Page, height: number | null) {
  await page.evaluate((h) => {
    const vv = window.visualViewport!;
    if (h === null) {
      // Delete the shadowing own-property so the native getter shows through.
      delete (vv as unknown as Record<string, unknown>).height;
    } else {
      Object.defineProperty(vv, 'height', { value: h, configurable: true });
    }
    vv.dispatchEvent(new Event('resize'));
  }, height);
}

test.describe('chat resizes for the keyboard (#125)', () => {
  test('opening the keyboard keeps all messages reachable and pinned to the latest', async ({
    adminPage,
    snap,
  }) => {
    test.setTimeout(180_000);

    const aid = await adminAid();
    await loginAs(adminPage);

    // A fresh channel with only a few messages — the case where the bug bites.
    const runTag = Date.now().toString(36);
    const channelName = `kbd-${runTag}`;
    const { channelId } = await api(aid, 'POST', '/chat/channels', {
      name: channelName,
      description: 'Seeded by the issue-125 feature spec.',
    });
    for (let i = 1; i <= 3; i++) {
      await api(aid, 'POST', `/chat/channels/${channelId}/messages`, {
        content: `Message ${i} of 3 — should stay reachable when the keyboard opens.`,
      });
    }

    await adminPage.setViewportSize(PHONE);
    await openChannel(adminPage, channelName);

    const firstMessage = adminPage.locator('.message-item').first();
    const lastMessage = adminPage.locator('.message-item').last();
    await expect(firstMessage).toBeVisible({ timeout: 10_000 });
    await snap(adminPage, 'channel-keyboard-closed');

    // Keyboard opens: the chat column shrinks to the visible viewport.
    await fakeKeyboard(adminPage, KEYBOARD_HEIGHT);
    await expect
      .poll(async () => adminPage.locator('.chat-page').evaluate((el) => el.getBoundingClientRect().height))
      .toBeCloseTo(KEYBOARD_HEIGHT, -1);

    // Every message stays within the (now smaller) visible area — none hidden
    // behind the keyboard — and the latest message is visible (pinned).
    for (const msg of [firstMessage, lastMessage]) {
      const box = await msg.boundingBox();
      expect(box).not.toBeNull();
      if (!box) continue;
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(KEYBOARD_HEIGHT + 1);
    }
    await snap(adminPage, 'channel-keyboard-open');

    // Keyboard closes: the full-height layout is restored.
    await fakeKeyboard(adminPage, null);
    await expect
      .poll(async () => adminPage.locator('.chat-page').evaluate((el) => el.getBoundingClientRect().height))
      .toBeCloseTo(PHONE.height, -1);
    await snap(adminPage, 'channel-keyboard-closed-restored');
  });
});
