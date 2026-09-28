import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * #678 — panel unlock: reconcile the wallet and the door on the unlock wire.
 *
 * #664 shipped the unlock-only card against the wire it ruled for itself; idss#1959
 * later landed the door's half against a slightly different contract, and the two
 * disagreed on two fields. A steward whose panel reloaded would scan the unlock
 * code, tap **Unlock**, and — although the sealed box DID reach the door and WAS
 * relayed — the card showed them a refusal, then the panel failed the box closed
 * as an agent mismatch. Both halves shipped green.
 *
 * This spec proves the reconciled wire over the web build, with the panel's relay
 * faked by route interception (the #664 precedent):
 *   1. The door answers the unlock route's OWN success — `{"status":"answered"}` —
 *      and the card lands on the done face, not a refusal.
 *   2. The posted box carries the wallet's own `aid` alongside the challenge and
 *      the sealed passcode, so the panel can match the opened agent to it (d.6).
 *   3. A stray `{"status":"verified"}` — which the unlock route never sends — is
 *      NOT mistaken for success; it fails closed to a refusal.
 */

const PANEL = 'https://admin.example.nz';
const RELAY = 'https://id.example.nz/login/app/unlock';
// A real Ed25519 verkey qb64 — the FRESH sealing key the panel tab mints per
// unlock and echoes on `ek=`; `Encrypter` seals the passcode to it.
const FRESH_KEY = 'DBZ1SAiVRxNccKMVT_2AaRp5Lb4Xlwg391IspBl0BRog';

/** Navigate a page to the unlock-only card with a `matou://unlock` code. */
async function openUnlock(page: Page, challenge: string): Promise<void> {
  const q = new URLSearchParams({
    panel: PANEL,
    present: RELAY,
    u: challenge,
    ek: FRESH_KEY,
    name: 'Te Rūnanga o Example',
    t: '14:06',
  });
  await page.goto(`/unlock?${q.toString()}`);
}

test.describe('#678 panel unlock — the wallet and the door agree on the wire', () => {
  test('a door that answers `answered` lands the unlock on the done face, not a refusal', async ({
    adminPage,
    snap,
  }) => {
    await adminPage.route(RELAY, async (route) => {
      // The unlock route's success verdict — idss#1959. Before #678 the wallet
      // read only `verified` as success, so this answered box showed a refusal.
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'answered' }) });
    });

    await openUnlock(adminPage, 'u_answered');
    await adminPage.locator('[data-action="approve-unlock"]').click();

    await expect(adminPage.locator('[data-status="done"]')).toContainText('Unlocked.');
    await expect(adminPage.locator('[data-status="refused"]')).toHaveCount(0);
    await snap(adminPage, 'unlock-answered-done');
  });

  test('the posted box carries the wallet aid alongside the challenge and the sealed passcode', async ({
    adminPage,
  }) => {
    let postedBody: Record<string, unknown> | null = null;
    await adminPage.route(RELAY, async (route) => {
      postedBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'answered' }) });
    });

    await openUnlock(adminPage, 'u_aid');
    await adminPage.locator('[data-action="approve-unlock"]').click();
    await expect(adminPage.locator('[data-status="done"]')).toContainText('Unlocked.');

    const body = postedBody as Record<string, unknown> | null;
    expect(body).not.toBeNull();
    expect(body!.challenge_id).toBe('u_aid');
    // The steward's own AID rides the box — the identity the panel matches the
    // opened agent to (ADR 0282 d.6). An empty aid fails every fresh unlock closed.
    expect(typeof body!.aid).toBe('string');
    expect(String(body!.aid)).not.toBe('');
    // Still a sealed cipher and only that — no presentation, no signature.
    expect(String(body!.sealed_passcode)).toMatch(/^1AAH/);
    expect(body).not.toHaveProperty('presentation');
    expect(body).not.toHaveProperty('response');
  });

  test('a stray `verified` is not mistaken for the unlock success — it fails closed', async ({ adminPage, snap }) => {
    await adminPage.route(RELAY, async (route) => {
      // The unlock route never answers `verified`; an unlock verifies nothing. If
      // one ever appeared it must fail closed, never be read as a done unlock.
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'verified' }) });
    });

    await openUnlock(adminPage, 'u_stray');
    await adminPage.locator('[data-action="approve-unlock"]').click();

    await expect(adminPage.locator('[data-status="refused"]')).toBeVisible();
    await expect(adminPage.locator('[data-status="done"]')).toHaveCount(0);
    await snap(adminPage, 'unlock-stray-verified-refused');
  });
});
