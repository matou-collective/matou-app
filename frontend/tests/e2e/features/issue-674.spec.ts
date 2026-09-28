import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * #674 — panel unlock 3/3: the wallet ARMS at approve and seals when the panel
 * asks (ADR 0282 d.2/d.6 + its armed-consent amendment, idss#1957).
 *
 * #663 sealed the steward's passcode ONCE during approve, to the verkey that
 * rode the sign-in code (`ek=`). But that key belongs to the bridge's door page
 * at `id.<apex>`, which the OIDC hop tears down; the control panel at
 * `admin.<apex>` never minted it and cannot open the box. So a control-panel
 * sign-in approved with the unlock line ON now ARMS the wallet for that one
 * challenge and seals NOTHING at approve — the present request carries no
 * `sealed_passcode`. The box the panel can open is minted only when the panel
 * later asks with the verkey it actually holds (that request transport is
 * idss#1957, out of scope here and not exercised by this spec).
 *
 * Ben ruled 2026-09-28 the mechanism stays sign-in-armed — one tap, no second
 * scan — so the approve card and its unlock line are visually unchanged from
 * #663; what changes is only that the passcode no longer rides the present
 * request. Drives the wallet's card over the web build with the sign-in site
 * faked by route interception (the #663/#664 precedent); the present POST is
 * intercepted so the wallet's body can be asserted without a live bridge.
 * adminPage is the community's steward (a Membership credential with role
 * operator); memberPage is a plain member.
 */

const DOOR = 'https://door.test';
const PRESENT = `${DOOR}/login/app/present`;
// A real Ed25519 verkey qb64 — the throwaway sealing key the panel tab would
// mint and echo on `ek=` at sign-in. Under #674 the wallet no longer seals to
// it at approve; it is only the machine-readable signal that this is a
// control-panel sign-in offering an unlock.
const SEALING_KEY = 'DBZ1SAiVRxNccKMVT_2AaRp5Lb4Xlwg391IspBl0BRog';

/**
 * Navigate a page to the approve card. When `panel` is set the code carries
 * `ek=` (a control-panel sign-in offering a passcode handover); otherwise it is
 * an ordinary service sign-in. The schema is left off so the sole held
 * credential is chosen.
 */
async function openCard(page: Page, challenge: string, opts: { panel?: boolean } = {}): Promise<void> {
  const params: Record<string, string> = {
    door: DOOR,
    present: PRESENT,
    c: challenge,
    name: 'Te Rūnanga o Example',
    svc: opts.panel ? 'the control panel' : 'Files',
  };
  if (opts.panel) params.ek = SEALING_KEY;
  const q = new URLSearchParams(params);
  await page.goto(`/signin?${q.toString()}`);
  await expect(page.locator('[data-field="ask"]')).toBeVisible();
}

test.describe('#674 panel unlock — the wallet arms at approve, seals when the panel asks', () => {
  test('Approve with the line on completes and posts no sealed_passcode (armed, not sealed)', async ({
    adminPage,
    snap,
  }) => {
    let postedBody: Record<string, unknown> | null = null;
    await adminPage.route(PRESENT, async (route) => {
      postedBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'verified' }) });
    });

    await openCard(adminPage, 'c_panel_arm', { panel: true });
    // The unlock line is on by default (unchanged from #663).
    await expect(adminPage.locator('[data-action="toggle-unlock"]')).toBeChecked();
    await expect(adminPage.locator('[data-action="approve"]')).toBeEnabled();
    await adminPage.locator('[data-action="approve"]').click();

    await expect(adminPage.locator('[data-status="done"]')).toContainText('Signed in.');
    // The wallet armed for the panel's later request rather than sealing here:
    // the present request carries NO sealed_passcode, and the passcode is never
    // on screen.
    expect(postedBody).not.toBeNull();
    expect(postedBody as Record<string, unknown>).not.toHaveProperty('sealed_passcode');
    await snap(adminPage, 'approve-armed-no-seal');
  });

  test('Approve with the line off also posts no sealed_passcode (nothing armed)', async ({ adminPage, snap }) => {
    let postedBody: Record<string, unknown> | null = null;
    await adminPage.route(PRESENT, async (route) => {
      postedBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'verified' }) });
    });

    await openCard(adminPage, 'c_panel_off', { panel: true });
    await adminPage.locator('[data-action="toggle-unlock"]').uncheck();
    await adminPage.locator('[data-action="approve"]').click();

    await expect(adminPage.locator('[data-status="done"]')).toContainText('Signed in.');
    expect(postedBody).not.toBeNull();
    expect(postedBody as Record<string, unknown>).not.toHaveProperty('sealed_passcode');
    await snap(adminPage, 'approve-line-off-no-seal');
  });

  test('an ordinary service sign-in still posts no sealed_passcode and shows no unlock line', async ({
    adminPage,
    snap,
  }) => {
    let postedBody: Record<string, unknown> | null = null;
    await adminPage.route(PRESENT, async (route) => {
      postedBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'verified' }) });
    });

    await openCard(adminPage, 'c_service', {});
    await expect(adminPage.locator('[data-field="unlock-line"]')).toHaveCount(0);
    await adminPage.locator('[data-action="approve"]').click();

    await expect(adminPage.locator('[data-status="done"]')).toContainText('Signed in.');
    expect(postedBody as Record<string, unknown>).not.toHaveProperty('sealed_passcode');
    await snap(adminPage, 'ordinary-sign-in');
  });
});
