import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * #683 — the wallet presents the credential the door asks for (`cred=`), shows
 * it as its card with Approve at the card's foot, and says when the member
 * holds none (idss ADR 0289; Ben, 2026-09-28).
 *
 * The control panel's door names the Administrator credential by slug
 * (`cred=administrator`). The wallet presents, in order: the held Administrator;
 * failing that, a Membership whose role is `operator`; failing that, nothing —
 * and it shows the no-credential screen. An ask with no `cred` is answered as it
 * always was.
 *
 * WHAT THIS SPEC CAN PROVE. The test community is a Mātou-backend one: its
 * founder holds a Membership with role `Founding Member` and its member one with
 * role `Member` (useOrgSetup / the registration flow). Nobody holds an
 * Administrator credential or an `operator` Membership, and the test backend
 * issues neither. So, with real wallets in the real app, this proves:
 *
 *  - a service sign-in draws the held Membership as its card, Approve at the
 *    card's foot, and presents it (the unchanged path, and the card itself);
 *  - at the control panel's door, a Membership whose role is not `operator` is
 *    NOT presented: the no-credential screen shows and nothing is posted.
 *
 * Presenting Administrator, the operator fallback, and the handover arming on
 * them are proven at the unit seam, where the wallet's held set can be stated
 * (tests/scripts/signin-credential.test.ts, signin-composable.test.ts,
 * signin-approve-card.test.ts).
 *
 * The route is a HASH route: the code's params ride `/#/signin?…`. A plain
 * `/signin?…` loads the app at its root and lands on the splash.
 */

const DOOR = 'https://door.test';
const PRESENT = `${DOOR}/login/app/present`;
const NO_CREDENTIAL = 'You do not have the required credential to sign into this service';

/** Open a sign-in code in the wallet. `panel` makes it the control panel's ask:
 *  it names Administrator and says it offers a seat unlock (#688 — no code
 *  carries a sealing key). The schemas are left off, so any schema the wallet
 *  holds is an asked one. */
async function openCode(page: Page, challenge: string, opts: { panel?: boolean } = {}): Promise<void> {
  const params: Record<string, string> = {
    door: DOOR,
    present: PRESENT,
    c: challenge,
    name: 'Te Rūnanga o Example',
    svc: opts.panel ? 'the control panel' : 'Files',
  };
  if (opts.panel) {
    params.cred = 'administrator';
    params.offer = 'seat-unlock';
  }
  await page.goto(`/#/signin?${new URLSearchParams(params).toString()}`);
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

/** Record every presentation posted to the door, answering each VERIFIED. */
async function watchDoor(page: Page): Promise<{ bodies: Record<string, unknown>[] }> {
  const seen = { bodies: [] as Record<string, unknown>[] };
  await page.route(PRESENT, async (route) => {
    seen.bodies.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'verified' }) });
  });
  return seen;
}

/** The credential card on the approve screen. */
function credentialCard(page: Page) {
  return page.locator('[data-field="credential-to-show"] .wallet-cred-card');
}

type Snap = (page: Page, label: string) => Promise<void>;

/**
 * One wallet, three sign-ins: a service (the control — this wallet holds a
 * Membership), the control panel (that Membership must not be presented), and a
 * service again (Approve presents it, and it is the only presentation made).
 */
async function notPresentedAtThePanel(page: Page, who: 'member' | 'founder', snap: Snap): Promise<void> {
  const door = await watchDoor(page);

  // 1. The control: this wallet is connected and HOLDS a Membership. A
  //    service sign-in draws it as its card, with Approve at the card's foot.
  await openCode(page, `c_683_${who}_service`);
  await reachCard(page);
  const card = credentialCard(page);
  await expect(card).toBeVisible();
  await expect(page.locator('[data-field="credential-to-show"]')).toHaveAttribute('data-kind', 'membership');
  await expect(card.locator('.cred-name')).not.toBeEmpty();
  await expect(card.locator('.cred-chip')).not.toBeEmpty();
  await expect(page.locator('[data-action="approve"]')).toHaveCount(1);
  await expect(card.locator('.cred-foot [data-action="approve"]')).toBeVisible();
  // The rest of the screen is what it was.
  await expect(page.locator('[data-field="service"]')).toHaveText('Files');
  await expect(page.locator('[data-field="site"]')).toContainText('door.test');
  await expect(page.locator('[data-action="details"]')).toBeVisible();
  await expect(page.locator('[data-field="unlock-steward-actions-line"]')).toHaveCount(0);
  // The credential the card is for, read from the details disclosure.
  const heldSaid = (await page.locator('[data-field="credential-said"]').textContent())?.trim() ?? '';
  expect(heldSaid).not.toBe('');
  await snap(page, `${who}-approve-membership-card`);

  // 2. The same wallet at the control panel's door. It holds that
  //    Membership — and must not present it: the door asks for
  //    Administrator, and this Membership is not an operator's.
  await openCode(page, `c_683_${who}_panel`, { panel: true });
  const screen = page.locator('[data-face="no-credential"]');
  await expect(screen).toBeVisible();
  await expect(screen.locator('[data-field="heading"]')).toHaveText(NO_CREDENTIAL);
  await expect(screen.locator('[data-field="asked"]')).toHaveText(
    'The control panel asks for the Administrator credential.',
  );
  await expect(screen.locator('[data-field="issuer"]')).toHaveText(
    'A steward of Te Rūnanga o Example can issue it to you.',
  );
  await expect(screen.locator('[data-field="nothing-shown"]')).toBeVisible();
  // A screen of its own: no approve card, no Approve, no unlock line.
  await expect(page.locator('[data-action="approve"]')).toHaveCount(0);
  await expect(page.locator('[data-field="credential-to-show"]')).toHaveCount(0);
  await expect(page.locator('[data-field="unlock-steward-actions-line"]')).toHaveCount(0);
  await snap(page, `${who}-no-credential-at-the-control-panel`);

  // 3. Back at a service's door, Approve presents the Membership — and that
  //    is the ONLY presentation this wallet made: nothing was posted for the
  //    control panel's ask.
  await openCode(page, `c_683_${who}_service_again`);
  await reachCard(page);
  await credentialCard(page).locator('[data-action="approve"]').click();
  await expect(page.locator('[data-status="done"]')).toContainText('Signed in.');

  expect(door.bodies).toHaveLength(1);
  const body = door.bodies[0]!;
  expect(body.challenge_id).toBe(`c_683_${who}_service_again`);
  expect(String(body.presentation)).toContain(heldSaid);
  expect(body).not.toHaveProperty('armed');
  expect(body).not.toHaveProperty('sealed_passcode');
  await snap(page, `${who}-signed-in`);
}

test.describe('#683 the wallet presents the credential the door asks for', () => {
  test("a member's Membership is shown for a service, and not presented at the control panel", async ({
    memberPage,
    snap,
  }) => {
    await notPresentedAtThePanel(memberPage, 'member', snap);
  });

  test("a founder's Membership that is not an operator's is not presented at the control panel either", async ({
    adminPage,
    snap,
  }) => {
    await notPresentedAtThePanel(adminPage, 'founder', snap);
  });
});
