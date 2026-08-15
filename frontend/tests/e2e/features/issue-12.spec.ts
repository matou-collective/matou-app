import { test, expect, Page } from './fixtures';

// Feature (#12): typed @-mentions in the in-app chat. Typing `@` opens a
// typeahead over the community roster; picking a person inserts a mention
// token into the message; the sent message renders the mention as a clickable
// chip; clicking the chip opens that person's profile dialog.
//
// People-first per Benz's design ruling (2026-08-13): this ships the shared
// machinery (token format, parser/renderer, chip, typeahead composable) plus
// the `person` type end-to-end. The other five entity types follow later.

const API = 'http://localhost:9080/api/v1';
const CHAT_URL = '/#/dashboard/chat';

async function adminAid(): Promise<string> {
  const res = await fetch(`${API}/identity`);
  const body = await res.json();
  if (!body?.aid) throw new Error(`admin backend has no identity: ${JSON.stringify(body)}`);
  return body.aid as string;
}

async function api(aid: string, method: string, route: string, body?: unknown) {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-User-AID': aid },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${route} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : undefined;
}

// The first community member with a display name — the person we'll mention.
async function firstMentionablePerson(): Promise<{ aid: string; name: string }> {
  const res = await fetch(`${API}/profiles/SharedProfile`);
  const body = await res.json();
  const profiles: Array<{ data: { aid?: string; displayName?: string } }> = body.profiles ?? [];
  for (const p of profiles) {
    if (p.data?.aid && p.data?.displayName) {
      return { aid: p.data.aid, name: p.data.displayName };
    }
  }
  throw new Error('no SharedProfile with a display name to mention');
}

async function openChannel(page: Page, channelName: string) {
  const enterBtn = page.getByRole('button', { name: /enter community/i });
  await enterBtn.click({ timeout: 15_000 }).catch(() => {});
  await page.goto(CHAT_URL);
  await expect(page.locator('.sidebar-title')).toHaveText('Channels', { timeout: 20_000 });
  const channelItem = page.locator('.channel-item').filter({ hasText: channelName });
  await expect(channelItem).toBeVisible({ timeout: 15_000 });
  await channelItem.click();
  await expect(page.locator('.channel-header .channel-name')).toBeVisible({ timeout: 10_000 });
}

test.describe('in-chat @-mentions (#12)', () => {
  test('@ typeahead inserts a person mention that renders and opens the profile', async ({
    adminPage,
    snap,
  }) => {
    test.setTimeout(180_000);

    const aid = await adminAid();
    const person = await firstMentionablePerson();

    // A fresh channel so this run's message can't collide with leftovers.
    const runTag = Date.now().toString(36);
    const channelName = `mentions-${runTag}`;
    await api(aid, 'POST', '/chat/channels', {
      name: channelName,
      description: 'Seeded by the issue-12 feature spec.',
    });

    await openChannel(adminPage, channelName);

    // Type '@' plus the first word of the person's name to open the typeahead.
    const query = person.name.split(/\s+/)[0];
    const input = adminPage.locator('.message-input');
    await input.click();
    await input.type(`Kia ora @${query}`);

    // Typeahead dropdown appears with the person as an option.
    const dropdown = adminPage.locator('.mention-dropdown');
    await expect(dropdown).toBeVisible({ timeout: 10_000 });
    const option = dropdown.locator('.mention-option').filter({ hasText: person.name }).first();
    await expect(option).toBeVisible({ timeout: 10_000 });
    await snap(adminPage, 'mention-typeahead-open');

    // Picking the option inserts the mention token into the composer.
    await option.click();
    await expect(input).toHaveValue(new RegExp(`@\\[person:${person.aid}\\|`));
    await expect(dropdown).toHaveCount(0);

    // Send it — the message renders the mention as a clickable chip.
    await adminPage.locator('.send-btn').click();
    await expect(input).toHaveValue('');

    const chip = adminPage.locator('.message-body .mention-chip').filter({ hasText: person.name }).last();
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await snap(adminPage, 'mention-chip-in-message');

    // Clicking the chip opens that person's read-only profile dialog.
    await chip.click();
    const profileDialog = adminPage.locator('.modal-overlay').filter({ hasText: person.name });
    await expect(profileDialog).toBeVisible({ timeout: 10_000 });
    await snap(adminPage, 'mention-opens-profile');
  });
});
