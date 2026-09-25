import { test, expect } from './fixtures';

// Feature (#645): IDSS recovery must read the community's three any-sync space
// IDs from the descriptor's `anysync` block (not from the derived OrgConfig,
// which never carries them on IDSS) and pass them to set-identity/join, so a
// fresh recovery clears the welcome overlay's "Community space access" check and
// opens the dashboard with NO restart.
//
// The `adminPage` fixture logs in by driving the real recovery flow
// (`loginWithMnemonic`): splash → "Recover identity" → 12 words → the welcome
// overlay's recovery checks (identity → backend identity → community space →
// membership credential) → "Enter Community" → dashboard. This spec asserts that
// refactored recovery path lands the recovered member in the community dashboard
// — the user-facing surface #645 fixes — and snaps it for review.
//
// NOTE: this harness runs a coa-shared backend (org config carries the space
// IDs), so it exercises the recovery path's non-IDSS branch and guards it
// against regression. The IDSS-specific branch (reading the descriptor's
// `anysync` spaces, and the "still being set up by its stewards" founding-
// ceremony message) is covered by the Vitest unit tests
// (tests/scripts/configured-spaces.test.ts, welcome-overlay-idss-spaces.test.ts)
// and needs live verification on an IDSS gateway (whakatohea-demo).

test.describe('IDSS recovery reaches the community dashboard (#645)', () => {
  test('a recovered member clears the welcome checks and opens the dashboard', async ({
    adminPage,
    snap,
  }) => {
    test.setTimeout(120_000);

    // The adminPage fixture has already completed recovery and reached the
    // dashboard. Confirm community access was granted (the check #645 fixes) by
    // asserting we are on a dashboard route, not bounced back to onboarding.
    await adminPage.goto('/#/dashboard');
    await expect(adminPage).toHaveURL(/#\/dashboard/, { timeout: 30_000 });

    // The dashboard shell renders only once the router guard's community-access
    // verification passes — proof the recovery path joined the community space.
    const shell = adminPage.locator('.main-content, .dashboard-layout, main').first();
    await expect(shell).toBeVisible({ timeout: 30_000 });

    await snap(adminPage, 'recovered-member-in-community-dashboard');
  });
});
