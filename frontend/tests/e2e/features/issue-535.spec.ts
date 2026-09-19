import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * #535 — sign-in sites: the home site trusted from the start, a first-contact
 * prompt before any other, and a list the member can undo (idss #1492 stories
 * 11/12/17/19; wireframes WS-A1 / WS-A3).
 *
 * Drives the wallet over the web build (the matou-app precedent). An unmet
 * sign-in site is faked with the `/signin` route query the deep link/scanner
 * would carry; the door itself is never contacted at first contact, so no route
 * interception is needed until (and unless) the member reaches the approve card.
 */

// A sign-in site the wallet has never met (not the member's home community).
const DOOR = 'https://door.test';
const CLAIMED = 'Some Other Community';

/** Navigate the member to a fresh sign-in ask for the unmet door. */
async function openAsk(page: Page, challenge: string): Promise<void> {
  const q = new URLSearchParams({ door: DOOR, c: challenge, name: CLAIMED, service: 'Files' });
  await page.goto(`/signin?${q.toString()}`);
}

test.describe('#535 sign-in sites: first contact and the trusted list', () => {
  test('an unmet site shows the first-contact prompt before any card (WS-A1)', async ({
    memberPage,
    snap,
  }) => {
    await openAsk(memberPage, 'c_first');

    const face = memberPage.locator('[data-face="first-contact"]');
    await expect(face).toBeVisible();
    await expect(memberPage.locator('[data-field="heading"]')).toHaveText(
      "A sign-in site you haven't met",
    );
    // The address is the fact; the name is only a claim.
    await expect(memberPage.locator('[data-field="address"]')).toHaveText('door.test');
    await expect(memberPage.locator('[data-field="claim"]')).toContainText(CLAIMED);

    // No Approve button on this screen — trust must come first.
    await expect(memberPage.locator('[data-action="approve"]')).toHaveCount(0);
    await expect(memberPage.locator('[data-action="trust"]')).toBeVisible();
    await expect(memberPage.locator('[data-action="dont"]')).toBeVisible();

    await snap(memberPage, 'first-contact');
  });

  test('Trust adds the site and continues to the approve card', async ({ memberPage, snap }) => {
    await openAsk(memberPage, 'c_trust');
    await memberPage.locator('[data-action="trust"]').click();

    // The same sign-in now shows the approve card.
    await expect(memberPage.locator('[data-field="ask"]')).toBeVisible();
    await expect(memberPage.locator('[data-field="site"]')).toContainText('door.test');
    await snap(memberPage, 'approve-after-trust');

    // The trusted site is remembered; a second code for it skips first contact.
    await openAsk(memberPage, 'c_again');
    await expect(memberPage.locator('[data-field="ask"]')).toBeVisible();
    await expect(memberPage.locator('[data-face="first-contact"]')).toHaveCount(0);
  });

  test('the trusted list shows the site and Forget makes it prompt again (WS-A3)', async ({
    memberPage,
    snap,
  }) => {
    // Trust the site through the first-contact prompt.
    await openAsk(memberPage, 'c_list');
    await memberPage.locator('[data-action="trust"]').click();
    await expect(memberPage.locator('[data-field="ask"]')).toBeVisible();

    // The "Sign-in sites you trust" screen lists it with a Forget.
    await memberPage.goto('/dashboard/signin-sites');
    const row = memberPage.locator('[data-field="site-row"]', {
      has: memberPage.locator('[data-field="address"]', { hasText: 'door.test' }),
    });
    await expect(row).toBeVisible();
    await expect(row.locator('[data-action="forget"]')).toBeVisible();
    await snap(memberPage, 'sites-list');

    // Forget removes it locally (the site is told nothing)…
    await row.locator('[data-action="forget"]').click();
    await expect(
      memberPage.locator('[data-field="address"]', { hasText: 'door.test' }),
    ).toHaveCount(0);

    // …so the next code naming that address shows the prompt again.
    await openAsk(memberPage, 'c_after_forget');
    await expect(memberPage.locator('[data-face="first-contact"]')).toBeVisible();
    await snap(memberPage, 'prompts-again-after-forget');
  });
});
