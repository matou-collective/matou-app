import { test, expect } from './fixtures';

// Feature (#469, slice S2 — linked-device sign-in, frontend half):
//   - POST /api/v1/identity/set can now 503 with
//     `{"error":"private space not reachable","retryable":true}` while a
//     linked device's private/community/read-only/admin space isn't reachable
//     yet (data still syncing on the backend).
//   - GET /api/v1/spaces/user tags each adopted space with
//     `spaceAccess: "ok" | "pending"` — "pending" means the space was adopted
//     but its read key isn't available from ACL yet.
//   - Neither is a hard failure: WelcomeOverlayScreen.vue now shows a
//     "Waiting for your data to sync…" row with a Retry button instead of
//     failing the check or letting the user through to a dashboard that
//     can't read its own data (see runRecoveryChecks/runReturningChecks +
//     the `waitingForSync` state).
//
// Reaching that screen needs a real, previously-recovered identity: the
// waiting state only fires from WelcomeOverlayScreen's post-recovery checks
// (isRecoveryFlow), which run after RecoveryScreen's `identityStore.connect()`
// — a live signify-ts session against a real KERIA agent that already holds
// the AID for the entered mnemonic. `freshPage` (this fixture file's only
// entry point, per its own header: "Feature specs never register/login
// manually") has no such session, and this spec is restricted to importing
// from `./fixtures` only, so it cannot reach into test-accounts.json (the
// mnemonic org-setup/registration leave behind for `adminPage`/`memberPage`)
// or KERIClient the way tests/e2e/e2e-account-recovery.spec.ts does.
//
// So this spec drives the UI as far as freshPage reliably allows — splash →
// "Recover identity" → the 12-word RecoveryScreen — and pins the network
// contract (the exact 503 body and the exact spaceAccess:"pending" shape)
// with page.route so a future live-infra spec (recovery/returning path,
// e.g. extending e2e-account-recovery.spec.ts or a dedicated
// `recoveryPage` fixture backed by test-accounts.json) can drop these same
// route handlers in front of a real recovered session and capture the
// 'waiting-for-sync' / 'synced' screenshots this issue calls for.
//
// NEEDS LIVE VERIFICATION: everything from "fill in a real recovered
// mnemonic and click Recover Identity" onward — that requires live KERI test
// infrastructure plus a pre-registered account's mnemonic, neither available
// to a fixtures-only freshPage spec.
test.describe('issue-469 linked-device sign-in waiting-for-sync contract', () => {
  test('backend 503 retryable + spaceAccess:pending payload shapes are wired up to the recovery flow entry point', async ({
    freshPage,
    snap,
  }) => {
    const page = freshPage;

    // Arm both route mocks up front so they're in place for whatever the
    // app calls once a session exists — the same shapes a live-infra spec
    // would use to force WelcomeOverlayScreen into the waiting state.
    let identitySetCalls = 0;
    await page.route('**/api/v1/identity/set', async (route) => {
      identitySetCalls++;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'private space not reachable', retryable: true }),
      });
    });

    let spacesUserCalls = 0;
    await page.route('**/api/v1/spaces/user**', async (route) => {
      spacesUserCalls++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          privateSpace: {
            spaceId: 'space-private-1',
            spaceName: 'Private',
            createdAt: new Date().toISOString(),
            keysAvailable: false,
            spaceAccess: 'pending',
          },
        }),
      });
    });

    // Splash → "Already have an account? Recover identity"
    await expect(page.getByRole('button', { name: /join now/i })).toBeVisible({
      timeout: 30_000,
    });
    await page.getByText(/recover identity/i).click();

    // RecoveryScreen: the 12-word mnemonic entry — this is the furthest a
    // freshPage-only spec can reliably reach without a live KERIA session.
    await expect(
      page.getByText(/enter your 12-word recovery phrase/i),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#word-0')).toBeVisible();
    await expect(page.locator('#word-11')).toBeVisible();
    await expect(
      page.getByRole('button', { name: /recover identity/i }),
    ).toBeVisible();

    await snap(page, 'recovery-screen-mocks-armed');

    // The route mocks above are ready but unexercised — identityStore.connect()
    // (called from RecoveryScreen.handleRecover, before either mocked
    // endpoint is ever reached) needs a live KERIA agent that already holds
    // an AID for the entered mnemonic, which this spec cannot provide. So we
    // stop here rather than fabricate a "waiting-for-sync" / "synced" screen
    // this run never actually produced.
    expect(identitySetCalls).toBe(0);
    expect(spacesUserCalls).toBe(0);
  });
});
