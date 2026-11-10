import { test, expect, Page } from './fixtures';
import { loginAs } from '../utils/signed-auth';

// Feature (#665, idss #1935, ADR 0282 d.4): "Sign out of the control panel
// everywhere" — one row on the wallet's identity screen (Account Settings),
// beside "Sign-in sites you trust", for a steward. It sends ONE signed request
// to the community control plane's take-back door; the done state states the
// outcome with NO count, and there is no session list, device name or count
// anywhere.
//
// The signed request + wire mapping are proven by the Vitest unit suite
// (panel-signout.test.ts, signout-everywhere-composable.test.ts) with the door
// faked; those can't post to a live IDSS control plane here. This spec exercises
// the identity-screen row itself: it renders with the specified copy, carries no
// count, and drives the button. The take-back door POST is intercepted and
// answered 204 so the done state is demonstrable without a live control plane.

const SETTINGS_URL = '/#/dashboard/settings';

async function enterCommunity(page: Page) {
  await page
    .getByRole('button', { name: /enter community/i })
    .click({ timeout: 15_000 })
    .catch(() => {});
}

test.describe('sign out of the control panel everywhere (#665)', () => {
  test('the identity screen shows the take-back row with no count, and it can be run', async ({
    adminPage,
    snap,
  }) => {
    test.setTimeout(180_000);

    await loginAs(adminPage);

    // Answer the take-back door 204 if the wallet reaches it, so the done state
    // is demonstrable without a live IDSS control plane.
    await adminPage.route('**/authz/panel/signout-everywhere', (route) =>
      route.fulfill({ status: 204, body: '' }),
    );

    await enterCommunity(adminPage);
    await adminPage.goto(SETTINGS_URL);

    // The steward's identity screen carries the row.
    const section = adminPage.locator('[data-test="signout-everywhere-section"]');
    await expect(section).toBeVisible({ timeout: 20_000 });
    await section.scrollIntoViewIfNeeded();

    // The copy is as specified, and there is NO session list, device name or count.
    await expect(section).toContainText('Sign out of the control panel everywhere');
    await expect(section).toContainText("Locks steward actions on every computer you've unlocked");
    await expect(section).toContainText('You stay a steward');
    await expect(section).not.toContainText(/\d+\s+(session|device|tab|computer)s?/i);
    await expect(section).not.toContainText(/twelve words/i);

    await snap(adminPage, 'signout-everywhere-row');

    // Run the take-back.
    await section.locator('[data-test="signout-everywhere-btn"]').click();

    // The done state states the outcome — with NO count — and reassures the
    // steward is unchanged.
    const done = section.locator('[data-test="signout-everywhere-done"]');
    await expect(done).toBeVisible({ timeout: 15_000 });
    await expect(section).toContainText('Signed out of the control panel everywhere.');
    await expect(section).toContainText("You're still a steward. Your app is unchanged.");
    await expect(section).not.toContainText(/\d+\s+(session|device|tab|computer)s?/i);

    await snap(adminPage, 'signout-everywhere-done');
  });
});
