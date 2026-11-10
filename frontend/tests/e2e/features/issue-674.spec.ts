import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * #674 — panel unlock 3/3: the wallet ARMS at approve and seals when the panel
 * asks (ADR 0282 d.2/d.6 + its armed-consent amendment, idss #1961/#1967,
 * option B).
 *
 * #663 sealed the steward's passcode ONCE during approve, to a verkey that rode
 * the sign-in code. But that key belonged to the bridge's door page at
 * `id.<apex>`, which the OIDC hop tears down; the control panel at
 * `admin.<apex>` never minted it and cannot open the box — and since #688 no
 * code carries a sealing key at all. So a control-panel sign-in approved with
 * the unlock line ON ARMS the wallet for that one
 * challenge and seals NOTHING at approve — the present request carries no
 * `sealed_passcode`, only `armed: true` so the door mints the handover
 * capability. The box the panel can open is minted only when the panel later
 * asks: after the sign-in verifies the wallet reads the verkey the panel bound
 * off the door's handover route and seals the passcode to THAT verkey, posting
 * the ciphertext once (the wire is idss #1961's `sign_in_armed_handover`).
 *
 * Ben ruled 2026-09-28 the mechanism stays sign-in-armed — one tap, no second
 * scan — so the approve card and its unlock line are visually unchanged from
 * #663; what changes is only the wire. Drives the wallet's card over the web
 * build with the sign-in site faked by route interception (the #663/#664
 * precedent); the present POST and the handover routes are intercepted so the
 * wallet's traffic can be asserted without a live bridge. adminPage is the
 * community's steward (a Membership credential with role operator); memberPage
 * is a plain member.
 */

const DOOR = 'https://door.test';
const PRESENT = `${DOOR}/login/app/present`;
// The door's wallet-facing handover routes (siblings of the present route).
const HANDOVER_KEY = /\/login\/app\/handover\/key/;
const HANDOVER_SEAL = /\/login\/app\/handover\/seal$/;
// A real Ed25519 verkey qb64 — the key the panel tab mints AFTER it lands and
// binds at the door; the wallet reads it off the handover key route. It rides
// no sign-in code (#688).
const SEALING_KEY = 'DBZ1SAiVRxNccKMVT_2AaRp5Lb4Xlwg391IspBl0BRog';

/**
 * Navigate a page to the approve card. When `panel` is set the code says it
 * offers a seat unlock (`offer=seat-unlock`, a control-panel sign-in); otherwise
 * it is an ordinary service sign-in. The schema is left off so the sole held
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
  if (opts.panel) params.offer = 'seat-unlock';
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
    await expect(adminPage.locator('[data-action="toggle-unlock-steward-actions"]')).toBeChecked();
    await expect(adminPage.locator('[data-action="approve"]')).toBeEnabled();
    await adminPage.locator('[data-action="approve"]').click();

    await expect(adminPage.locator('[data-status="done"]')).toContainText('Signed in.');
    // The handover is still to come, so the armed sign-in says to keep the app
    // open, and its face does not close itself (#688).
    await expect(adminPage.locator('[data-field="done-body"]')).toContainText(
      'keep this app open until Members appears',
    );
    // The wallet armed for the panel's later request rather than sealing here:
    // the present request carries NO sealed_passcode, only `armed: true` so the
    // door mints the handover capability, and the passcode is never on screen.
    expect(postedBody).not.toBeNull();
    expect(postedBody as Record<string, unknown>).not.toHaveProperty('sealed_passcode');
    expect((postedBody as Record<string, unknown>).armed).toBe(true);
    await snap(adminPage, 'approve-armed-no-seal');
  });

  test('after approve the wallet reads the panel verkey and posts the sealed box (option B answering half)', async ({
    adminPage,
    snap,
  }) => {
    // The verkey the panel binds to the door AFTER it lands (it rode no code).
    // A known-good Ed25519 verkey qb64 so signify's Encrypter seals to it; in
    // production the panel mints a fresh one in its tab post-landing.
    const PANEL_BOUND_KEY = SEALING_KEY;
    await adminPage.route(PRESENT, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'verified' }),
      });
    });
    // The wallet polls this route; the panel has bound its verkey, so answer it.
    await adminPage.route(HANDOVER_KEY, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ sealing_key: PANEL_BOUND_KEY }),
      });
    });
    let sealedBox: Record<string, unknown> | null = null;
    await adminPage.route(HANDOVER_SEAL, async (route) => {
      sealedBox = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'answered' }),
      });
    });

    await openCard(adminPage, 'c_panel_answer', { panel: true });
    await adminPage.locator('[data-action="approve"]').click();
    await expect(adminPage.locator('[data-status="done"]')).toContainText('Signed in.');

    // In the background the wallet answered the panel's request: it sealed the
    // steward's passcode to the verkey the panel bound and posted the ciphertext
    // once. The passcode leaves ONLY as the sealed cipher.
    await expect.poll(() => sealedBox).not.toBeNull();
    const box = sealedBox as unknown as Record<string, unknown>;
    expect(box.challenge_id).toBe('c_panel_answer');
    expect(typeof box.aid).toBe('string');
    expect(typeof box.sealed_passcode).toBe('string');
    expect((box.sealed_passcode as string).length).toBeGreaterThan(0);
    await snap(adminPage, 'answered-panel-request');
  });

  test('Approve with the line off also posts no sealed_passcode (nothing armed)', async ({ adminPage, snap }) => {
    let postedBody: Record<string, unknown> | null = null;
    await adminPage.route(PRESENT, async (route) => {
      postedBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'verified' }) });
    });

    await openCard(adminPage, 'c_panel_off', { panel: true });
    await adminPage.locator('[data-action="toggle-unlock-steward-actions"]').uncheck();
    await adminPage.locator('[data-action="approve"]').click();

    await expect(adminPage.locator('[data-status="done"]')).toContainText('Signed in.');
    expect(postedBody).not.toBeNull();
    expect(postedBody as Record<string, unknown>).not.toHaveProperty('sealed_passcode');
    // Nothing armed → no `armed` signal, so the door mints no capability.
    expect(postedBody as Record<string, unknown>).not.toHaveProperty('armed');
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
    await expect(adminPage.locator('[data-field="unlock-steward-actions-line"]')).toHaveCount(0);
    await adminPage.locator('[data-action="approve"]').click();

    await expect(adminPage.locator('[data-status="done"]')).toContainText('Signed in.');
    expect(postedBody as Record<string, unknown>).not.toHaveProperty('sealed_passcode');
    expect(postedBody as Record<string, unknown>).not.toHaveProperty('armed');
    await snap(adminPage, 'ordinary-sign-in');
  });
});
