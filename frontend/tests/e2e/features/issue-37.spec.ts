import { test, expect, Page } from './fixtures';

// Feature (#37): the @-mention machinery shipped for `person` in #12 now covers
// the remaining five entity types (project, proposal, event, update,
// contribution). This spec drives the `project` type end-to-end — it exercises
// the parts unique to #37: a non-person candidate in the typeahead (icon + type
// label instead of an avatar), the `@[project:…|Title]` token, the rendered
// chip, and the chip navigating to the entity's home page. It also demonstrates
// the carry-over "match across a space" fix by querying with two words.
//
// Person is already covered by issue-12.spec.ts; the other four types reuse the
// exact same machinery this spec drives for projects.

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

test.describe('in-chat @-mentions: project type (#37)', () => {
  test('@ typeahead inserts a project mention that renders and opens the project', async ({
    adminPage,
    snap,
  }) => {
    test.setTimeout(180_000);

    const aid = await adminAid();

    // Seed a project with a distinctive multi-word title so the typeahead has
    // an unambiguous match, then a fresh channel to post in.
    const runTag = Date.now().toString(36);
    const projectTitle = `Kaitiaki Restoration ${runTag}`;
    const project = await api(aid, 'POST', '/projects', {
      title: projectTitle,
      description: 'Seeded by the issue-37 feature spec.',
      created_by: aid,
    });
    const projectId: string = project.id;
    expect(projectId, 'seeded project should have an id').toBeTruthy();

    const channelName = `mentions37-${runTag}`;
    await api(aid, 'POST', '/chat/channels', {
      name: channelName,
      description: 'Seeded by the issue-37 feature spec.',
    });

    await openChannel(adminPage, channelName);

    // Type '@' plus two words of the title — the second word crosses a space,
    // which the Slack-style matcher (a #37 carry-over fix) now handles.
    const input = adminPage.locator('.message-input');
    await input.click();
    await input.pressSequentially(`Look at @Kaitiaki ${runTag}`);

    // Typeahead shows the project as a non-person candidate: a type label and
    // the icon glyph rather than an avatar.
    const dropdown = adminPage.locator('.mention-dropdown');
    await expect(dropdown).toBeVisible({ timeout: 10_000 });
    const option = dropdown.locator('.mention-option').filter({ hasText: projectTitle }).first();
    await expect(option).toBeVisible({ timeout: 10_000 });
    await expect(option.locator('.mention-option-type')).toHaveText('project');
    await snap(adminPage, 'project-typeahead-open');

    // Picking the option inserts the project token into the composer.
    await option.click();
    await expect(input).toHaveValue(new RegExp(`@\\[project:${projectId}\\|`));
    await expect(dropdown).toHaveCount(0);

    // Send it — the message renders the mention as a clickable chip.
    await adminPage.locator('.send-btn').click();
    await expect(input).toHaveValue('');

    const chip = adminPage
      .locator('.message-body .mention-chip')
      .filter({ hasText: projectTitle })
      .last();
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await snap(adminPage, 'project-chip-in-message');

    // Clicking the chip navigates to that project's detail page.
    await chip.click();
    await expect(adminPage).toHaveURL(new RegExp(`/dashboard/projects/${projectId}`), {
      timeout: 10_000,
    });
    await snap(adminPage, 'project-chip-opens-detail');
  });
});
