import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * #663 — panel unlock 1/3: the approve card's steward-unlock line, and the
 * passcode sealed to the control-panel tab's key (idss#1929 stories 1/2/3/8,
 * ADR 0282 d.1/d.2/d.6, wireframe PU-A2u).
 *
 * A steward signing in to a community's CONTROL PANEL through the app door sees
 * one extra region under the headline: "Also unlock steward actions on this
 * computer until you sign out", on by default. On Approve with it on, the wallet
 * does the ordinary presentation AND seals the steward's passcode to the panel
 * tab's sealing key (which rode `ek=` on the code) — a libsodium sealed box the
 * door relays but cannot open, carried as `sealed_passcode` on the ONE present
 * request. Switched off gives an ordinary locked-seat panel session and the
 * guard sentence says so. The line appears ONLY for a control-panel sign-in
 * (the code carried `ek=`) whose presented credential makes the holder a
 * steward — every other approve card is untouched, and the passcode never
 * appears on screen.
 *
 * Drives the wallet's card over the web build with the sign-in site faked by
 * route interception (the matou-app precedent, mirroring #531/#574). The panel
 * tab's sealing key is a real Ed25519 verkey qb64; the present POST is
 * intercepted so the sealed_passcode the wallet posts can be asserted without a
 * live bridge. adminPage is the community's steward (a Membership credential
 * with role operator); memberPage is a plain member.
 */

const DOOR = 'https://door.test';
const PRESENT = `${DOOR}/login/app/present`;
// A real Ed25519 verkey qb64 — the throwaway sealing key the panel tab would
// mint and echo on `ek=`. `Encrypter` converts it to X25519 and seals to it.
const SEALING_KEY = 'DBZ1SAiVRxNccKMVT_2AaRp5Lb4Xlwg391IspBl0BRog';

/**
 * Navigate a page to the approve card. When `panel` is set the code carries
 * `ek=` (a control-panel sign-in offering a passcode handover); otherwise it is
 * an ordinary service sign-in. The schema is left off so the sole held
 * credential is chosen (as #531 does).
 */
async function openCard(page: Page, challenge: string, opts: { panel?: boolean; service?: string } = {}): Promise<void> {
  const params: Record<string, string> = {
    door: DOOR,
    present: PRESENT,
    c: challenge,
    name: 'Te Rūnanga o Example',
    svc: opts.service ?? (opts.panel ? 'the control panel' : 'Files'),
  };
  if (opts.panel) params.ek = SEALING_KEY;
  const q = new URLSearchParams(params);
  await page.goto(`/signin?${q.toString()}`);
  await expect(page.locator('[data-field="ask"]')).toBeVisible();
}

test.describe('#663 panel unlock — the steward-unlock line', () => {
  test('a steward control-panel sign-in shows the on-by-default unlock line', async ({ adminPage, snap }) => {
    await openCard(adminPage, 'c_panel_on', { panel: true });

    const line = adminPage.locator('[data-field="unlock-line"]');
    await expect(line).toBeVisible();
    await expect(line).toContainText('Also unlock steward actions on this computer until you sign out');
    // On by default: the on-copy shows, the toggle is checked, no second confirm.
    const on = adminPage.locator('[data-status="unlock-on"]');
    await expect(on).toBeVisible();
    await expect(on).toContainText('approve people, issue and revoke credentials');
    await expect(on).toContainText('without typing your twelve words');
    await expect(adminPage.locator('[data-action="toggle-unlock"]')).toBeChecked();

    // The sealing-key fingerprint is in details, never on the face.
    await expect(adminPage.locator('[data-field="unlock-line"] [data-field="sealing-key-fingerprint"]')).toHaveCount(0);
    await adminPage.locator('[data-action="details"] summary').click();
    await expect(adminPage.locator('[data-field="sealing-key-fingerprint"]')).not.toHaveText('');

    await snap(adminPage, 'unlock-line-on');
  });

  test('switching the line off shows the locked-seat guard sentence before Approve', async ({ adminPage, snap }) => {
    await openCard(adminPage, 'c_panel_off', { panel: true });
    await adminPage.locator('[data-action="toggle-unlock"]').uncheck();

    const off = adminPage.locator('[data-status="unlock-off"]');
    await expect(off).toBeVisible();
    await expect(off).toContainText("this computer won't be able to approve people or issue credentials");
    await expect(off).toContainText('unlock it later from the Members tab');
    await expect(adminPage.locator('[data-status="unlock-on"]')).toHaveCount(0);
    await snap(adminPage, 'unlock-line-off');
  });

  test('Approve with the line on arms the wallet and posts no sealed_passcode (superseded by #674)', async ({ adminPage, snap }) => {
    // #663 sealed the passcode onto this present request. #674 supersedes that:
    // the sign-in code's `ek=` belongs to the bridge's door page the OIDC hop
    // tears down, so the wallet now ARMS for the panel's later request and seals
    // nothing here — the present request carries no sealed_passcode. See
    // tests/e2e/features/issue-674.spec.ts for the arming behavior in full.
    let postedBody: Record<string, unknown> | null = null;
    await adminPage.route(PRESENT, async (route) => {
      postedBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'verified' }) });
    });

    await openCard(adminPage, 'c_panel_seal', { panel: true });
    await expect(adminPage.locator('[data-action="approve"]')).toBeEnabled();
    await adminPage.locator('[data-action="approve"]').click();

    await expect(adminPage.locator('[data-status="done"]')).toContainText('Signed in.');
    expect(postedBody).not.toBeNull();
    expect(postedBody as Record<string, unknown>).not.toHaveProperty('sealed_passcode');
    await snap(adminPage, 'approve-armed');
  });

  test('Approve with the line off posts no sealed_passcode (ordinary locked seat)', async ({ adminPage }) => {
    let postedBody: Record<string, unknown> | null = null;
    await adminPage.route(PRESENT, async (route) => {
      postedBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'verified' }) });
    });

    await openCard(adminPage, 'c_panel_noseal', { panel: true });
    await adminPage.locator('[data-action="toggle-unlock"]').uncheck();
    await adminPage.locator('[data-action="approve"]').click();

    await expect(adminPage.locator('[data-status="done"]')).toContainText('Signed in.');
    expect(postedBody).not.toBeNull();
    expect(postedBody as Record<string, unknown>).not.toHaveProperty('sealed_passcode');
  });

  test('an ordinary service sign-in shows no unlock line for the same steward', async ({ adminPage, snap }) => {
    await openCard(adminPage, 'c_service', {});
    await expect(adminPage.locator('[data-field="ask"]')).toBeVisible();
    await expect(adminPage.locator('[data-field="unlock-line"]')).toHaveCount(0);
    await snap(adminPage, 'ordinary-no-line');
  });

  test('a non-steward member on a control-panel sign-in sees no unlock line', async ({ memberPage, snap }) => {
    await openCard(memberPage, 'c_panel_member', { panel: true });
    await expect(memberPage.locator('[data-field="ask"]')).toBeVisible();
    await expect(memberPage.locator('[data-field="unlock-line"]')).toHaveCount(0);
    await snap(memberPage, 'non-steward-no-line');
  });
});
