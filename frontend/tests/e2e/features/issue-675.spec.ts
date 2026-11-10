import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * #675 — the wallet must never keep presenting a spent/expired sign-in code
 * after a fresh one has been minted. Two corrections, shown over the web build
 * (route interception fakes the bridge, mirroring issue-574's harness):
 *
 *  1. A fresh code that arrives while the approve card is already open replaces
 *     the held one — the newest challenge always wins. Approve then presents the
 *     NEW challenge, never the first one the card saw.
 *  2. After the door answers `409 spent`, "try again" does NOT re-present the
 *     dead code (which could only be refused again): the card holds the
 *     stale-code line asking for a fresh code, and posts nothing more. A freshly
 *     minted code lifts the hold and signs in.
 */

const DOOR = 'https://door.test';
// The bridge's present route, carried in the link and posted to verbatim.
const PRESENT = `${DOOR}/login/app/present`;

function askQuery(challenge: string, service: string): string {
  return new URLSearchParams({
    door: DOOR,
    present: PRESENT,
    c: challenge,
    name: 'Te Rūnanga o Example',
    service,
  }).toString();
}

/** Navigate the member to the approve card for a given challenge / service. */
async function openCard(page: Page, challenge: string, service = 'Files'): Promise<void> {
  await page.goto(`/signin?${askQuery(challenge, service)}`);
  await expect(page.locator('[data-field="ask"]')).toBeVisible();
}

/**
 * A fresh code arriving while the card is ALREADY open: an in-app (hash) route
 * change to the same `signin-approve` route with a new challenge, so the page
 * component is reused — the exact scenario #675 is about (no remount to lean on).
 */
async function arriveFreshCode(page: Page, challenge: string, service: string): Promise<void> {
  const q = askQuery(challenge, service);
  await page.evaluate((query) => {
    window.location.hash = `#/signin?${query}`;
  }, q);
}

test.describe('#675 the newest sign-in code always wins', () => {
  test('a fresh code that arrives while the card is open supersedes the held one', async ({
    memberPage,
    snap,
  }) => {
    const posted: Record<string, unknown>[] = [];
    await memberPage.route(PRESENT, async (route) => {
      posted.push(JSON.parse(route.request().postData() ?? '{}'));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'verified' }),
      });
    });

    // The card opens on the first code…
    await openCard(memberPage, 'nonce-first', 'Files');
    await snap(memberPage, 'card-first-code');

    // …then a freshly minted code arrives (a re-scan / new deep link) while the
    // card is still mounted (in-app hash nav, no remount). The card rebuilds.
    await arriveFreshCode(memberPage, 'nonce-fresh', 'Photos');
    await expect(memberPage.locator('[data-field="ask"]')).toContainText('Photos');
    await snap(memberPage, 'card-rebuilt-on-fresh-code');

    // Approving presents the FRESH challenge, never the first one.
    await memberPage.locator('[data-action="approve"]').click();
    await expect(memberPage.locator('[data-status="done"]')).toContainText('Signed in.');
    expect(posted).toHaveLength(1);
    expect(posted[0]).toHaveProperty('challenge_id', 'nonce-fresh');
    await snap(memberPage, 'signed-in-with-fresh-code');
  });

  test('after a 409 spent, try again holds the stale-code line and posts nothing more', async ({
    memberPage,
    snap,
  }) => {
    let spentAnswers = 0;
    let verifiedAnswers = 0;
    await memberPage.route(PRESENT, async (route) => {
      const challenge = (JSON.parse(route.request().postData() ?? '{}') as { challenge_id?: string })
        .challenge_id;
      // The first (spent) code is refused; only a freshly minted code verifies.
      if (challenge === 'nonce-spent') {
        spentAnswers++;
        await route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'spent' }),
        });
      } else {
        verifiedAnswers++;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'verified' }),
        });
      }
    });

    await openCard(memberPage, 'nonce-spent');
    await memberPage.locator('[data-action="approve"]').click();

    const region = memberPage.locator('[data-status="refused"]');
    await expect(region).toHaveAttribute('data-refusal', 'spent');
    await expect(region).toContainText('already used');
    expect(spentAnswers).toBe(1);
    await snap(memberPage, 'spent-refusal');

    // Try again must NOT re-present the spent code: the stale-code line holds,
    // and no second present reaches the door.
    await memberPage.locator('[data-action="try-again"]').click();
    await expect(region).toBeVisible();
    await expect(region).toContainText('already used');
    expect(spentAnswers).toBe(1);
    await snap(memberPage, 'try-again-holds-not-re-presented');

    // A freshly minted code arriving in-app lifts the hold and signs in.
    await arriveFreshCode(memberPage, 'nonce-fresh', 'Files');
    await expect(memberPage.locator('[data-field="ask"]')).toBeVisible();
    await memberPage.locator('[data-action="approve"]').click();
    await expect(memberPage.locator('[data-status="done"]')).toContainText('Signed in.');
    expect(verifiedAnswers).toBe(1);
    await snap(memberPage, 'signed-in-after-fresh-code');
  });
});
