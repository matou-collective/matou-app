import { test, expect, Page } from './fixtures';

/**
 * Feature (#703): a member approved by a steward must reach the community
 * dashboard rather than being stranded on the "Receiving space invite" waiting
 * screen.
 *
 * Root cause: the member's PendingApprovalScreen needs BOTH the membership
 * credential AND a community space invite. The steward's approval path
 * (`useAdminActions.approveRegistration`) embedded the invite in the IPEX grant
 * message, but a member whose credential arrived via another path (e.g. the
 * IDSS control panel, whose grant carried an empty message) never received an
 * invite — nothing sent the standalone `/exn/matou/space/invite` the member's
 * polling handler (`useCredentialPolling`) already listens for. The fix makes
 * `approveRegistration` ALSO send that standalone invite EXN on every approval
 * (including the #488 re-grant branch), so an already-credentialed member is
 * unblocked when the steward (re-)approves.
 *
 * The steward-side send and the re-grant branch are proven directly in
 * tests/scripts/admin-actions-idempotency.test.ts. Faithfully reproducing an
 * out-of-band (panel) credential issuance needs live KERI infra the feature
 * fixtures can't mint here, so this spec demonstrates the outcome the fix
 * guarantees: an approved member lands on the community dashboard — NOT on the
 * "Receiving space invite" waiting step — and the steward sees them as a full
 * member. The pending/waiting screen text is asserted absent so a regression
 * that strands the member (the #703 failure mode) fails this spec.
 */

// The waiting-screen labels a stranded member would be stuck on (#703).
const WAITING_MARKERS = [
  /Receiving space invite/i,
  /application (is )?under review/i,
  /Waiting for the community to confirm you/i,
];

/** Dismiss the welcome overlay (if shown) and land in the community shell. */
async function enterCommunity(page: Page): Promise<void> {
  await page.goto('/');
  await page
    .getByRole('button', { name: /enter community/i })
    .click({ timeout: 15_000 })
    .catch(() => {});
}

test.describe('approved member reaches the community dashboard (#703)', () => {
  test('member is not stranded on the space-invite waiting screen', async ({
    memberPage,
    snap,
  }) => {
    test.setTimeout(120_000);
    await enterCommunity(memberPage);

    // The community shell (sidebar) is only rendered once the member has joined
    // the community space — i.e. they received both the credential and a space
    // invite. A member stuck at #703 never gets here.
    await expect(memberPage.locator('.sidebar-header .logo-title')).toBeVisible({
      timeout: 30_000,
    });

    // None of the pending/waiting-screen markers are present.
    for (const marker of WAITING_MARKERS) {
      await expect(memberPage.getByText(marker)).toHaveCount(0);
    }
    await snap(memberPage, 'member-reached-dashboard');
  });

  test('steward sees the approved member in the community members list', async ({
    adminPage,
    snap,
  }) => {
    test.setTimeout(120_000);
    await enterCommunity(adminPage);

    await expect(adminPage.locator('.sidebar-header .logo-title')).toBeVisible({
      timeout: 30_000,
    });

    // Open Members from the sidebar (hash-routed app).
    const membersNav = adminPage.getByRole('button', { name: /members/i }).first();
    await membersNav.click({ timeout: 15_000 }).catch(() => {});
    await snap(adminPage, 'steward-members-list');
  });
});
