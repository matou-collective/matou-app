import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * #574 — the approve path speaks the REAL sign-in bridge's wire, not prototype
 * #1301's (idss #1669; app-door golden). Three corrections, each shown here over
 * the web build (route interception fakes the bridge):
 *
 *  1. The presentation POSTs to the ask's `present` URL verbatim — never a path
 *     derived from the door. The link carries `present=…`; the wallet posts there.
 *  2. A refusal is HTTP 200 with `body.status === "refused"` — it must read as
 *     refused, NEVER as "signed in" (the old any-2xx-is-verified bug).
 *  3. The challenge-lifecycle verdicts ride the HTTP code: 410 is an expired
 *     code, shown as a stale-code line (get a fresh code), not a credential fault.
 */

const DOOR = 'https://door.test';
// The bridge's present route, carried in the link and posted to verbatim.
const PRESENT = `${DOOR}/login/app/present`;

/** Navigate the member to the approve card for a fresh challenge. */
async function openCard(page: Page, challenge: string): Promise<void> {
  const q = new URLSearchParams({
    door: DOOR,
    present: PRESENT,
    c: challenge,
    name: 'Te Rūnanga o Example',
    service: 'Files',
  });
  await page.goto(`/signin?${q.toString()}`);
  await expect(page.locator('[data-field="ask"]')).toBeVisible();
}

test.describe('#574 sign-in speaks the real bridge wire', () => {
  test('Approve POSTs to the present URL and a status:verified is Signed in', async ({ memberPage, snap }) => {
    let postedUrl = '';
    let postedBody: Record<string, unknown> = {};
    await memberPage.route(PRESENT, async (route) => {
      const req = route.request();
      postedUrl = req.url();
      postedBody = JSON.parse(req.postData() ?? '{}');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'verified' }),
      });
    });

    await openCard(memberPage, 'nonce-ok');
    await memberPage.locator('[data-action="approve"]').click();

    await expect(memberPage.locator('[data-status="done"]')).toContainText('Signed in.');
    // Posted to the present URL verbatim, snake_case body — never a derived path.
    expect(postedUrl).toBe(PRESENT);
    expect(postedBody).toHaveProperty('challenge_id', 'nonce-ok');
    expect(postedBody).not.toHaveProperty('challengeID');
    await snap(memberPage, 'signed-in-real-wire');
  });

  test('a 200 refused reads as refused, never Signed in', async ({ memberPage, snap }) => {
    await memberPage.route(PRESENT, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'refused', refusal: 'signature' }),
      });
    });

    await openCard(memberPage, 'nonce-refused');
    await memberPage.locator('[data-action="approve"]').click();

    const region = memberPage.locator('[data-status="refused"]');
    await expect(region).toBeVisible();
    await expect(region).toContainText('Your access could not be verified.');
    // The 200 must NOT have been read as a verified sign-in.
    await expect(memberPage.locator('[data-status="done"]')).toHaveCount(0);
    await snap(memberPage, 'refused-on-200');
  });

  test('a 410 is an expired code — a stale-code line, not a credential fault', async ({ memberPage, snap }) => {
    await memberPage.route(PRESENT, async (route) => {
      await route.fulfill({
        status: 410,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'expired' }),
      });
    });

    await openCard(memberPage, 'nonce-expired');
    await memberPage.locator('[data-action="approve"]').click();

    const region = memberPage.locator('[data-status="refused"]');
    await expect(region).toHaveAttribute('data-refusal', 'expired');
    await expect(region).toContainText('expired');
    await snap(memberPage, 'expired-code');
  });
});
