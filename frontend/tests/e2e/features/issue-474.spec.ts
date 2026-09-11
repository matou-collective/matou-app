import { test, expect, Page } from './fixtures';

// Feature (#474, slice S7 of linked-device sign-in #466): Account Settings
// grows a "Devices" card that a signed-in member uses to
//   - "Link another device" — opens the same onboarding pairing screen as a
//     maximized dialog (the desktop/browser shows the QR + approves; a phone
//     scans). The screen is the already-shipped LinkDeviceQrScreen (#472) /
//     LinkDeviceScanScreen (#473);
//   - read the accepted-limitation copy (signing out is a local wipe, not a
//     revocation — a device that still has the recovery phrase keeps the
//     identity);
//   - "Sign out of this device", whose confirmation carries the spec §3.3 copy
//     "To use a different identity on this device, sign out first. Your
//     identity stays on your other devices."
//
// Refuse-to-overwrite end to end (spec §3.3) is already wired in the link
// screens: they never call identity/set when the backend holds an identity,
// and a 409 identity-present / a `conflict` outcome renders "These devices
// hold different identities … sign out first". This spec drives the desktop QR
// screen and forces the `conflict` outcome through a mocked pairing-status
// response so the refusal copy is shown on a real signed-in session, without
// standing up a second backend.
//
// NEEDS LIVE VERIFICATION: the full two-backend handshake (a second backend
// holding a *different* identity, neither backend's identity.json changing on
// a conflict, and a steward linking a fresh client resolving to their personal
// AID via `matou_admin_aid`) needs two live backends + the config-server
// mailbox — that is S9's two-client e2e on BackendManager, not reproducible
// from a fixtures-only, single-session spec.

const SETTINGS_URL = '/#/dashboard/settings';

// loginWithMnemonic parks the app on the "Enter Community" welcome gate (or,
// on a warm session, straight on the dashboard). Click through it if shown,
// then use the hash route. (Same shape as issue-402.spec.ts.)
async function passWelcomeGate(page: Page): Promise<void> {
  const enter = page.getByRole('button', { name: /enter community/i });
  await Promise.race([
    enter.waitFor({ state: 'visible', timeout: 20_000 }),
    page.locator('.sidebar-header').waitFor({ state: 'visible', timeout: 20_000 }),
  ]).catch(() => {});
  if (await enter.isVisible().catch(() => false)) {
    await enter.click();
    await expect(enter).toBeHidden({ timeout: 30_000 });
  }
}

async function openDevicesCard(page: Page): Promise<void> {
  await passWelcomeGate(page);
  await page.goto(SETTINGS_URL);
  await expect(page.locator('[data-test="devices-section"]')).toBeVisible({ timeout: 30_000 });
}

test.describe('Account Settings "Link another device" + refuse-to-overwrite (#474)', () => {
  test('Devices card shows Link another device, the QR screen, the conflict refusal, and the sign-out copy', async ({
    adminPage,
    snap,
  }) => {
    test.setTimeout(120_000);
    const page = adminPage;

    await openDevicesCard(page);

    // The card carries the accepted-limitation copy: signing out is a local
    // wipe, not a revocation.
    const devices = page.locator('[data-test="devices-section"]');
    await expect(devices).toContainText(/does not\s+revoke it/i);
    await expect(devices).toContainText(/still has your recovery phrase keeps the identity/i);
    await snap(page, 'devices-card');

    // Mock the pairing backend so the QR renders deterministically on a
    // signed-in session without a reachable config-server mailbox. createSession
    // hands back a valid-looking QR payload; the status poll keeps the session
    // in its freshly-created state so the screen stays on the QR.
    const FUTURE = new Date(Date.now() + 5 * 60_000).toISOString();
    await page.route('**/api/v1/pairing/sessions', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          sessionId: 'sess-474',
          qrPayload:
            'matou://pair?v=1&id=abcd1234abcd1234&pk=' +
            'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&s=efgh5678efgh5678&cs=http://localhost:4443',
          expiresAt: FUTURE,
        }),
      });
    });

    // Refuse-to-overwrite is only meaningful if the screen never tries to
    // *take* the other device's identity: record every identity/set the page
    // makes from here on and assert it stayed empty. Without this the spec
    // would pass against a screen that overwrote the identity and merely
    // printed the refusal copy afterwards.
    // Pass the request through rather than aborting it: the point is to
    // observe, not to change what the app would otherwise do.
    const identitySets: string[] = [];
    await page.route('**/api/v1/identity/set', async (route) => {
      identitySets.push(route.request().method());
      await route.continue();
    });

    // First: keep the session "created" so the QR image is shown.
    let forceConflict = false;
    await page.route('**/api/v1/pairing/sessions/sess-474', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          forceConflict
            ? { state: 'hello-received', outcome: 'conflict', code: '', peerDeviceName: 'My phone', error: '' }
            : { state: 'created', outcome: '', code: '', peerDeviceName: '', error: '' },
        ),
      });
    });

    // Open the link dialog → the desktop QR screen.
    await page.locator('[data-test="link-device-btn"]').click();
    await expect(page.getByText(/scan this with the matou app on your phone/i)).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator('[data-testid="pairing-qr"]')).toBeVisible({ timeout: 15_000 });
    await snap(page, 'link-device-qr');

    // Now force the conflict outcome and let the next poll land: the screen
    // refuses to overwrite and shows the "different identities … sign out
    // first" copy (spec §3.3).
    forceConflict = true;
    await expect(page.getByText(/these devices hold different identities/i)).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/sign out first/i)).toBeVisible();
    await snap(page, 'refuse-to-overwrite-conflict');

    // The refusal must be a refusal: nothing was written to this backend.
    expect(identitySets, 'the conflicting link must never call identity/set').toEqual([]);

    // Close the link dialog via the onboarding header's back button. Scope it
    // to the dialog: the settings header has its own (unnamed) back button
    // behind the overlay, and an unscoped, un-awaited click on a selector that
    // matches nothing hangs until the whole test times out — there is no
    // per-action timeout in playwright.config.ts.
    const linkDialog = page.locator('.link-device-host');
    await linkDialog.getByRole('button', { name: /back/i }).click();
    await expect(linkDialog).toBeHidden({ timeout: 10_000 });

    // Sign-out confirmation carries the spec §3.3 copy. Do NOT confirm — that
    // would wipe the shared fixture session.
    await expect(page.locator('[data-test="signout-btn"]')).toBeVisible();
    await page.locator('[data-test="signout-btn"]').click();
    await expect(
      page.getByText(
        /to use a different identity on this device, sign out first\. your identity stays on your other devices\./i,
      ),
    ).toBeVisible({ timeout: 10_000 });
    // Signing out wipes this device's only copy of the phrase and there is no
    // "show my recovery phrase" screen, so the confirmation has to say so.
    await expect(page.getByText(/recovery phrase written down first/i)).toBeVisible();
    await snap(page, 'sign-out-confirmation');
  });
});
