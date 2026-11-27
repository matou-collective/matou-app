import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * #531 — the approve card: one tap signs the community's challenge and presents
 * the member's credential (idss #1492 stories 10, 13–18, 28; wireframe WS-A2).
 *
 * Drives the wallet's approve card over the web build (the matou-app precedent:
 * prove the screens in our own suite). The sign-in site is faked with route
 * interception — the card navigates from the `matou://signin` link's fields,
 * carried here as the `/signin` route query, and the door's verdict is
 * fulfilled so proving → done, a refusal, and the wallet-only site-unreachable
 * line can each be shown without a live bridge.
 */

// A fake sign-in site; the present POST goes to the ask's present URL verbatim
// (never derived from the door), per the app-door golden wire (#574).
const DOOR = 'https://door.test';
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

test.describe('#531 wallet sign-in approve card', () => {
  test('the card names the service, site and credential (WS-A2)', async ({ memberPage, snap }) => {
    await openCard(memberPage, 'c_show');

    const ask = memberPage.locator('[data-field="ask"]');
    await expect(ask).toContainText('Sign in to');
    await expect(memberPage.locator('[data-field="service"]')).toHaveText('Files');
    await expect(memberPage.locator('[data-field="community"]')).toHaveText('Te Rūnanga o Example');
    await expect(memberPage.locator('[data-field="site"]')).toContainText('door.test');

    // No identifier is on the face; the details disclosure carries them.
    const details = memberPage.locator('[data-action="details"]');
    await expect(details).toHaveJSProperty('tagName', 'DETAILS');
    await details.locator('summary').click();
    await expect(memberPage.locator('[data-field="bound-message"]')).toContainText('idss-idp:' + DOOR);
    await expect(memberPage.locator('[data-field="challenge-id"]')).toHaveText('c_show');

    await snap(memberPage, 'approve-card');
  });

  test('Approve proves then reads Signed in (WS-A2p → WS-A2d)', async ({ memberPage, snap }) => {
    // Hold the verdict briefly so the Proving face is observable, then verify.
    // The bridge answers VERIFIED with `body.status`, not a bare 2xx (#574).
    await memberPage.route(PRESENT, async (route) => {
      await new Promise((r) => setTimeout(r, 1200));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'verified' }) });
    });

    await openCard(memberPage, 'c_ok');
    const approve = memberPage.locator('[data-action="approve"]');
    // The member holds a membership credential from registration, so Approve is live.
    await expect(approve).toBeEnabled();
    await approve.click();

    await expect(memberPage.locator('[data-status="proving"]')).toContainText("Proving you're a member");
    await snap(memberPage, 'proving');

    await expect(memberPage.locator('[data-status="done"]')).toContainText('Signed in.');
    await snap(memberPage, 'signed-in');
  });

  test('a refusal shows the shared sentence and tail (WS-A2r)', async ({ memberPage, snap }) => {
    // A refusal is HTTP 200 with `status: refused` (+ kind), never a non-2xx (#574).
    await memberPage.route(PRESENT, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'refused', refusal: 'revoked' }),
      });
    });

    await openCard(memberPage, 'c_revoked');
    await memberPage.locator('[data-action="approve"]').click();

    const region = memberPage.locator('[data-status="refused"]');
    await expect(region).toHaveAttribute('data-refusal', 'revoked');
    await expect(region).toContainText('Your access could not be verified.');
    await expect(region).toContainText('has been revoked');
    await expect(memberPage.locator('[data-action="try-again"]')).toBeVisible();
    await expect(memberPage.locator('[data-field="contact-line"]')).toBeVisible();
    await snap(memberPage, 'refused-revoked');
  });

  test('a post that gets no answer is the wallet-only site-unreachable line (story 28)', async ({
    memberPage,
    snap,
  }) => {
    await memberPage.route(PRESENT, (route) => route.abort());

    await openCard(memberPage, 'c_dead');
    await memberPage.locator('[data-action="approve"]').click();

    await expect(memberPage.locator('[data-status="site-unreachable"]')).toContainText(
      "Couldn't reach the sign-in site",
    );
    await snap(memberPage, 'site-unreachable');
  });
});
