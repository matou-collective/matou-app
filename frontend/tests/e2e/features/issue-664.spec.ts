import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * #664 — panel unlock 2/3: the unlock-only card, for a panel that is signed in
 * but locked (idss#1929 stories 13–16, ADR 0282 d.3, wireframe PU-A4).
 *
 * A locked-but-signed-in control panel shows an *unlock code*
 * (`matou://unlock?…`), not a sign-in code. Scanning it opens a card that carries
 * the unlock and ONLY the unlock: no "what will be shown" region, no credential
 * presented, no session minted, and the primary button reads **Unlock**, not
 * Approve. On Unlock the wallet seals the steward's passcode to the FRESH
 * per-page key the code carried and posts it once — a box the door relays but
 * cannot open. *Not now* seals and posts nothing. An expired code refuses cleanly
 * rather than sealing to a dead challenge. No countdown, and the session is never
 * framed as at risk.
 *
 * Drives the wallet's card over the web build; the panel's relay is faked by
 * route interception (the matou-app precedent, mirroring #531/#663). The sealing
 * key is a real Ed25519 verkey qb64, so the details fingerprint is genuine.
 */

const PANEL = 'https://admin.example.nz';
const RELAY = 'https://id.example.nz/login/app/unlock';
// A real Ed25519 verkey qb64 — the FRESH sealing key the panel tab would mint per
// unlock and echo on `ek=`. `Encrypter` converts it to X25519 and seals to it.
const FRESH_KEY = 'DBZ1SAiVRxNccKMVT_2AaRp5Lb4Xlwg391IspBl0BRog';
// A second, different real verkey — a later unlock mints a NEW key, so its
// fingerprint differs from the first by construction (ADR 0282 d.3).
const FRESH_KEY_2 = 'DDtwGNGNnKEGux8L0ldwnV57wYdpbwHpIqefUQf0Urno';

/** Navigate a page to the unlock-only card with a `matou://unlock` code. */
async function openUnlock(
  page: Page,
  challenge: string,
  opts: { ek?: string; exp?: number; t?: string } = {},
): Promise<void> {
  const params: Record<string, string> = {
    panel: PANEL,
    present: RELAY,
    u: challenge,
    ek: opts.ek ?? FRESH_KEY,
    name: 'Te Rūnanga o Example',
    t: opts.t ?? '14:06',
  };
  if (opts.exp !== undefined) params.exp = String(opts.exp);
  const q = new URLSearchParams(params);
  await page.goto(`/unlock?${q.toString()}`);
}

test.describe('#664 panel unlock — the unlock-only card', () => {
  test('an unlock code renders the unlock-only card with Unlock as the primary act', async ({ adminPage, snap }) => {
    await openUnlock(adminPage, 'u_render');

    await expect(adminPage.locator('[data-field="ask"]')).toContainText('Unlock steward actions on');
    // WHERE and the ALREADY SIGNED IN note, straight from the wireframe copy.
    await expect(adminPage.locator('[data-field="panel-site"]')).toContainText("Te Rūnanga o Example's control panel");
    await expect(adminPage.locator('[data-field="panel-site"]')).toContainText('admin.example.nz');
    await expect(adminPage.locator('[data-field="session-note"]')).toContainText('You signed in on this computer at 14:06');
    await expect(adminPage.locator('[data-field="session-note"]')).toContainText('This only unlocks steward actions');
    await expect(adminPage.locator('[data-field="unlock-guard"]')).toContainText('approve people, issue and revoke credentials');

    // The primary act reads Unlock, not Approve.
    await expect(adminPage.locator('[data-action="approve-unlock"]')).toHaveText('Unlock');
    await expect(adminPage.locator('[data-action="approve"]')).toHaveCount(0);

    // No "what will be shown" region, no credential, no countdown, no at-risk copy.
    await expect(adminPage.locator('[data-field="credential-to-show"]')).toHaveCount(0);
    await expect(adminPage.locator('text=What will be shown')).toHaveCount(0);
    await expect(adminPage.locator('text=/countdown|expires in|seconds left/i')).toHaveCount(0);
    await expect(adminPage.locator('text=/at risk|may be compromised|someone else/i')).toHaveCount(0);

    await snap(adminPage, 'unlock-only-card');
  });

  test('details show the fresh sealing key fingerprint, which differs from another unlock', async ({ adminPage }) => {
    await openUnlock(adminPage, 'u_fp1', { ek: FRESH_KEY });
    await adminPage.locator('[data-action="details"] summary').click();
    const first = await adminPage.locator('[data-field="sealing-key-fingerprint"]').innerText();
    expect(first).toMatch(/[0-9a-f]{4}·[0-9a-f]{4}/);
    expect(first).toContain('a fresh key');

    // A later unlock mints a NEW key — its fingerprint is a different value.
    await openUnlock(adminPage, 'u_fp2', { ek: FRESH_KEY_2 });
    await adminPage.locator('[data-action="details"] summary').click();
    const second = await adminPage.locator('[data-field="sealing-key-fingerprint"]').innerText();
    expect(second).toMatch(/[0-9a-f]{4}·[0-9a-f]{4}/);
    expect(second).not.toBe(first);
  });

  test('Unlock seals the passcode to the fresh key and posts it once — no presentation', async ({ adminPage, snap }) => {
    let postedBody: Record<string, unknown> | null = null;
    let postCount = 0;
    await adminPage.route(RELAY, async (route) => {
      postCount += 1;
      postedBody = route.request().postDataJSON() as Record<string, unknown>;
      // The unlock route's success is `answered`, never `verified` (idss#1959,
      // reconciled in #678) — an unlock verifies nothing.
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'answered' }) });
    });

    await openUnlock(adminPage, 'u_seal');
    await adminPage.locator('[data-action="approve-unlock"]').click();

    await expect(adminPage.locator('[data-status="done"]')).toContainText('Unlocked.');
    expect(postCount).toBe(1);
    // The sealed passcode rode the ONE unlock request as a CESR qb64 cipher (1AAH…).
    const body = postedBody as Record<string, unknown> | null;
    expect(body).not.toBeNull();
    expect(String(body!.sealed_passcode)).toMatch(/^1AAH/);
    expect(body!.challenge_id).toBe('u_seal');
    // No presentation and no signature — the passcode and only the passcode. The
    // aid DOES ride (ADR 0282 d.6, #678): the panel matches the opened agent to it.
    expect(body).not.toHaveProperty('presentation');
    expect(body).not.toHaveProperty('response');
    expect(String(body!.aid)).not.toBe('');
    await snap(adminPage, 'unlocked');
  });

  test('Not now seals and posts nothing', async ({ adminPage }) => {
    let posted = false;
    await adminPage.route(RELAY, async (route) => {
      posted = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'verified' }) });
    });

    await openUnlock(adminPage, 'u_notnow');
    await adminPage.locator('[data-action="not-now"]').click();

    // The card leaves without ever touching the relay.
    expect(posted).toBe(false);
  });

  test('an expired unlock code refuses cleanly rather than sealing to a dead challenge', async ({ adminPage, snap }) => {
    let posted = false;
    await adminPage.route(RELAY, async (route) => {
      posted = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'verified' }) });
    });

    // An exp already in the past → the card refuses at read time, no Unlock button.
    await openUnlock(adminPage, 'u_expired', { exp: Math.floor(Date.now() / 1000) - 60 });

    await expect(adminPage.locator('[data-status="expired"]')).toContainText('unlock code has expired');
    await expect(adminPage.locator('[data-action="approve-unlock"]')).toHaveCount(0);
    expect(posted).toBe(false);
    await snap(adminPage, 'unlock-expired');
  });
});
