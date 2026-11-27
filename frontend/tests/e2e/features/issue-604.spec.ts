import { test, expect, Page } from './fixtures';
import { loginAs, jsonSessionHeaders } from '../utils/signed-auth';

/**
 * Feature (#604): @-mentioning people in a contribution / sub-task comment.
 *
 * The comment composer on the contribution detail page reuses the same live
 * typeahead the chat composer uses (shared `useMentionTypeahead` composable +
 * `MentionDropdown`): typing `@` opens a list of community people that filters
 * as you type, selecting one inserts a `@[person:AID|Name]` token, and the
 * posted comment renders the mention as a chip. When a person is mentioned the
 * backend notifies them through the existing per-recipient notification rail
 * with a new `contribution:mentioned` type (covered by Go handler tests and the
 * Vitest `useMentionTypeahead` / mentions suites — the notification delivery
 * can't be asserted from a single browser here).
 *
 * This drives the visible half end-to-end: the typeahead, the live filter, the
 * inserted token, and the rendered chip.
 */

const API = 'http://localhost:9080/api/v1';

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

test.describe('@-mention people in contribution comments (#604)', () => {
  test('typing @ opens a live-filtered people list; selecting one inserts a chip', async ({
    adminPage,
    snap,
  }) => {
    test.setTimeout(180_000);

    const aid = await adminAid();
    await loginAs(adminPage); // signed-auth session so API calls act as the admin

    // Seed a project + contribution to comment on.
    const runTag = Date.now().toString(36);
    const project = await api(aid, 'POST', '/projects', {
      title: `Mentions Project ${runTag}`,
      description: 'Seeded by the issue-604 feature spec.',
      created_by: aid,
    });
    const contribution = await api(aid, 'POST', '/contributions', {
      project_id: project.id,
      title: `Weave the net ${runTag}`,
      description: 'Seeded by the issue-604 feature spec.',
      contribution_type: 'technical',
      priority: 'medium',
      created_by: aid,
      objectives: ['o'],
      deliverables: ['d'],
      acceptance_criteria: ['a'],
      skill_requirements: ['s'],
    });
    expect(contribution.id, 'seeded contribution should have an id').toBeTruthy();

    // The typeahead's people come from the community roster preloaded at login;
    // reload so the store is current before we open the detail page.
    await adminPage.reload();
    await enterCommunity(adminPage);

    // Open the contribution detail page directly (same route the "Copy Link"
    // deep link uses); the inline body carries the Discussion composer.
    await adminPage.goto(`/#/dashboard/contributions/${contribution.id}`);
    const input = adminPage.getByPlaceholder(/Add your comment/i);
    await expect(input).toBeVisible({ timeout: 20_000 });

    // Type '@' — the shared typeahead opens with community people.
    await input.click();
    await input.pressSequentially('Great work @');
    const dropdown = adminPage.locator('.mention-dropdown');
    await expect(dropdown).toBeVisible({ timeout: 10_000 });
    const firstOption = dropdown.locator('.mention-option').first();
    await expect(firstOption).toBeVisible({ timeout: 10_000 });
    const personName = (await firstOption.locator('.mention-option-name').innerText()).trim();
    expect(personName.length, 'a community person should be offered').toBeGreaterThan(0);
    await snap(adminPage, 'mention-typeahead-open');

    // Keep typing part of that person's name — the list filters live.
    await input.pressSequentially(personName.slice(0, 3));
    const match = dropdown.locator('.mention-option').filter({ hasText: personName }).first();
    await expect(match).toBeVisible({ timeout: 10_000 });
    await snap(adminPage, 'mention-typeahead-filtered');

    // Selecting the person inserts a person mention token into the composer.
    await match.click();
    await expect(input).toHaveValue(/@\[person:/);
    await expect(dropdown).toHaveCount(0);
    await snap(adminPage, 'mention-token-inserted');

    // Post the comment — it renders the mention as a chip, matching chat.
    await adminPage.locator('.comment-input-row').getByRole('button').click();
    const chip = adminPage
      .locator('.comment-text .mention-chip')
      .filter({ hasText: personName })
      .last();
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await snap(adminPage, 'mention-chip-in-comment');
  });
});
