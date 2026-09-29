import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * #688 — the wallet reads what the code offers, and a locked panel unlocks
 * through the sign-in door (idss ADR 0282 as amended 2026-09-29, obligations
 * 2a–2c; wireframes PU-A2u, PU-A4, PU-A4d, PU-A4n).
 *
 * A sign-in code says what it offers in a field of its own: nothing (a service
 * sign-in), `offer=seat-unlock` (a control-panel sign-in), or `offer=unlock` (a
 * locked panel unlocking through this same door). The wallet reads that field —
 * never a sealing key (`ek=` is retired), the display name in `svc`, or `cred`.
 * The panel's own unlock code, `matou://unlock`, and its card are gone.
 *
 * WHAT THIS SPEC CAN PROVE. The test community is a Mātou-backend one: its
 * founder holds a Membership with role `Founding Member` and its member one with
 * role `Member` (see issue-683.spec.ts). Nobody holds an `operator` Membership,
 * so NO test wallet is a steward. With real wallets in the real app this proves
 * the halves that need no steward:
 *
 *  - a code that says it is an unlock, opened by an identity that is not a
 *    steward, shows PU-A4n and posts nothing;
 *  - an ordinary service sign-in shows no unlock line, whatever else the code
 *    carries — a stray `ek=` and the control panel's display name included;
 *  - the app has no unlock route.
 *
 * The steward's halves — the unlock line on by default, PU-A4 with no switch,
 * Unlock posting `armed: true`, PU-A4d — are proven at the unit seam, where the
 * wallet's held set can be stated (tests/scripts/signin-composable.test.ts,
 * signin-approve-card.test.ts, signin-link.test.ts).
 *
 * The route is a HASH route: the code's params ride `/#/signin?…`.
 */

const DOOR = 'https://door.test';
const PRESENT = `${DOOR}/login/app/present`;
const HANDOVER = /\/login\/app\/handover\//;

/** Open a sign-in code in the wallet, with whatever extra params the case needs.
 *  The schemas are left off, so any schema the wallet holds is an asked one. */
async function openCode(page: Page, challenge: string, extra: Record<string, string> = {}): Promise<void> {
  const params: Record<string, string> = {
    door: DOOR,
    present: PRESENT,
    c: challenge,
    name: 'Te Rūnanga o Example',
    svc: 'Files',
    ...extra,
  };
  await page.goto(`/#/signin?${new URLSearchParams(params).toString()}`);
}

/** Record everything the wallet sends the door — presentations and handover
 *  traffic alike. */
async function watchDoor(page: Page): Promise<{ requests: string[] }> {
  const seen = { requests: [] as string[] };
  await page.route(PRESENT, async (route) => {
    seen.requests.push(route.request().url());
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'verified' }) });
  });
  await page.route(HANDOVER, async (route) => {
    seen.requests.push(route.request().url());
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  return seen;
}

/** Wait for the approve card, trusting the faked sign-in site first if the
 *  wallet has not met it (WS-A1). */
async function reachCard(page: Page): Promise<void> {
  const trust = page.locator('[data-action="trust"]');
  const ask = page.locator('[data-field="ask"]');
  await expect(trust.or(ask).first()).toBeVisible();
  if (await trust.isVisible()) await trust.click();
  await expect(ask).toBeVisible();
}

const UNLOCK = { svc: 'the control panel', cred: 'administrator', offer: 'unlock' };

test.describe('#688 a locked panel unlocks through the sign-in door', () => {
  for (const who of ['member', 'founder'] as const) {
    test(`an unlock code opened by a ${who} who is not a steward shows PU-A4n and posts nothing`, async ({
      memberPage,
      adminPage,
      snap,
    }) => {
      const page = who === 'member' ? memberPage : adminPage;
      const door = await watchDoor(page);

      await openCode(page, `c_688_${who}_unlock`, UNLOCK);

      const face = page.locator('[data-field="unlock-card"][data-status="not-a-steward"]');
      await expect(face).toBeVisible();
      await expect(face.locator('[data-field="heading"]')).toHaveText("This identity can't unlock steward actions");
      await expect(face.locator('[data-field="not-a-steward-body"]')).toContainText(
        "this identity isn't one of them",
      );
      await expect(face.locator('[data-field="not-a-steward-body"]')).toContainText(
        "You're still signed in to the control panel",
      );
      await expect(face.locator('[data-field="nothing-shown"]')).toHaveText('Nothing was sent.');

      // Nothing to press but Close: no Unlock, no Approve, no switch, no card.
      await expect(page.locator('[data-action="approve-unlock"]')).toHaveCount(0);
      await expect(page.locator('[data-action="approve"]')).toHaveCount(0);
      await expect(page.locator('[data-action="toggle-unlock-steward-actions"]')).toHaveCount(0);
      await expect(page.locator('[data-field="credential-to-show"]')).toHaveCount(0);
      await expect(page.locator('[data-action="close"]')).toBeVisible();
      await snap(page, `${who}-not-a-steward`);

      await page.locator('[data-action="close"]').click();
      expect(door.requests).toEqual([]);
    });
  }

  test('an ordinary service sign-in shows no unlock line, whatever else the code carries', async ({
    memberPage,
    snap,
  }) => {
    const door = await watchDoor(memberPage);
    // Everything the old wallet keyed off, and no offer field.
    await openCode(memberPage, 'c_688_service', {
      svc: 'the control panel',
      ek: 'DBZ1SAiVRxNccKMVT_2AaRp5Lb4Xlwg391IspBl0BRog',
    });
    await reachCard(memberPage);

    await expect(memberPage.locator('[data-field="ask"]')).toContainText('Sign in to');
    await expect(memberPage.locator('[data-field="unlock-steward-actions-line"]')).toHaveCount(0);
    await expect(memberPage.locator('[data-field="unlock-card"]')).toHaveCount(0);
    await memberPage.locator('[data-action="details"] summary').click();
    await expect(memberPage.locator('[data-field="sealing-key-fingerprint"]')).toHaveCount(0);
    await snap(memberPage, 'service-no-unlock-line');

    await memberPage.locator('[data-action="approve"]').click();
    await expect(memberPage.locator('[data-status="done"]')).toContainText('Signed in.');
    expect(door.requests).toEqual([PRESENT]);
  });

  test('the app has no unlock route — the retired unlock code opens no card', async ({ memberPage, snap }) => {
    const q = new URLSearchParams({
      panel: 'https://admin.example.nz',
      present: 'https://id.example.nz/login/app/unlock',
      u: 'u_688_retired',
      ek: 'DBZ1SAiVRxNccKMVT_2AaRp5Lb4Xlwg391IspBl0BRog',
      name: 'Te Rūnanga o Example',
    });
    await memberPage.goto(`/#/unlock?${q.toString()}`);

    await expect(memberPage.locator('[data-field="unlock-card"]')).toHaveCount(0);
    await expect(memberPage.locator('[data-action="approve-unlock"]')).toHaveCount(0);
    await expect(memberPage.locator('[data-field="ask"]')).toHaveCount(0);
    await snap(memberPage, 'no-unlock-route');
  });
});
