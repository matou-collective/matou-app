import { test, expect, Page } from './fixtures';

/**
 * Issue #383 — "Member role does not appear in the UI after membership
 * credential issuance".
 *
 * The role shown in the member UI is read solely from CommunityProfile.role
 * (read-only space); the member list comes from SharedProfile. After a fresh
 * registration → approval → issuance, the approval flow's profile writes went
 * through the create-profile handler, which emitted no SSE refresh signal, and
 * approveRegistration never reloaded the profile stores itself — so a missed
 * broadcast left the just-approved member's role badge hidden until a manual
 * page reload.
 *
 * The fix: the create-profile handler now broadcasts a client-recognised
 * `profile:updated` event, and approveRegistration explicitly reloads both
 * community-profile stores on success. This spec verifies the observable
 * outcome: the approved member's role badge reads "Member" in the admin's
 * member list and in the profile modal, with NO intervening page.reload().
 *
 * Note: the feature fixtures hand back an already-approved member session, so
 * this asserts the role-display convergence the fix guarantees rather than
 * driving a brand-new registration (which the fixtures forbid). The regression
 * for the refresh-on-approval path itself lives in the Vitest unit test
 * tests/scripts/admin-approval-refresh.test.ts.
 */

// loginWithMnemonic parks the app on the "Enter Community" welcome screen (or,
// on a warm session, straight on the dashboard). The router is in hash mode,
// so a plain `/dashboard` path boots the app at `/` and never leaves that
// gate — click through it, then use the hash route, as the other feature
// specs do.
async function enterDashboard(page: Page): Promise<void> {
  const enter = page.getByRole('button', { name: /enter community/i });
  if (await enter.isVisible().catch(() => false)) {
    await enter.click();
  }
  await page.goto('/#/dashboard');
  await expect(page.locator('.members-card')).toBeVisible({ timeout: 30_000 });
}

test.describe('issue #383 — member role visible after approval', () => {
  test('the approved member shows a "Member" role badge without a reload', async ({
    adminPage,
    snap,
  }) => {
    test.setTimeout(120_000);
    await enterDashboard(adminPage);

    // The members card renders a ProfileCard per member; the role badge is
    // `.card-role` and reads from CommunityProfile.role. The seeded member's
    // role is exactly "Member" (the admin's own is "Founding Member").
    const memberRoleBadge = adminPage
      .locator('.members-card .card-role')
      .filter({ hasText: /^Member$/ })
      .first();
    await expect(memberRoleBadge).toBeVisible({ timeout: 30_000 });
    await snap(adminPage, 'member-role-badge-in-list');

    // Open the member's profile modal and confirm the role is shown there too.
    const memberCard = adminPage
      .locator('.members-card .profile-card')
      .filter({ has: adminPage.locator('.card-role', { hasText: /^Member$/ }) })
      .first();
    await memberCard.click();

    // The modal's role badge is driven by the same CommunityProfile.role.
    // Scope to the modal so the list badge behind it can't satisfy the check.
    const modal = adminPage.locator('.modal-content');
    await expect(modal).toBeVisible({ timeout: 15_000 });
    await expect(modal.getByText('Member', { exact: true }).first()).toBeVisible({
      timeout: 15_000,
    });
    await snap(adminPage, 'member-role-badge-in-modal');
  });
});
