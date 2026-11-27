import { test, expect, Page } from './fixtures';

// Feature (#709): a steward (keys[0] founder) who could not apply some peer
// stewards' credential changes — the "keys[0] unsignable" skip path — now sees
// a notice on the dashboard carrying the org-act inbox's `lastError`, with an
// expandable list of the affected members. In normal operation a steward
// drains its inbox cleanly, so no notice renders; the populated state only
// appears after an interrupted promotion (a peer act whose anchor predates the
// group's latest establishment event). That populated state needs a bespoke
// multi-steward + group-rotation backend scenario the e2e harness does not set
// up, so this spec demonstrates the clean-operation half (the notice is hidden
// on a healthy steward dashboard) — the populated rendering is covered by the
// Vitest component test (tests/scripts/steward-inbox-notice.test.ts).

const NOTICE = '[data-test="steward-inbox-notice"]';

// Dismiss the welcome splash if present so the dashboard is reachable.
async function enterCommunity(page: Page) {
  await page
    .getByRole('button', { name: /enter community/i })
    .click({ timeout: 15_000 })
    .catch(() => {});
}

test.describe('steward org-act inbox notice (#709)', () => {
  test('a healthy steward dashboard shows no skipped-acts notice', async ({ adminPage, snap }) => {
    test.setTimeout(120_000);
    await enterCommunity(adminPage);

    // The founder is a steward, so the dashboard right column is present.
    await expect(adminPage.locator('.welcome-header')).toBeVisible({ timeout: 15_000 });

    // Normal operation: the inbox drains cleanly, so the notice stays hidden.
    await expect(adminPage.locator(NOTICE)).toHaveCount(0);
    await snap(adminPage, 'steward-dashboard-no-inbox-notice');
  });
});
