import { test, expect } from './fixtures';

/**
 * #669 — administrator 2/2: upgrading someone to founding member runs the IDSS
 * promotion rail, not a role-history grant (idss#1948, ADR 0286 d.13).
 *
 * The behaviour that changes is IDSS-backend-only: on an IDSS community the
 * in-app role editor withholds "Founding Member" as an assignable role-history
 * value (it is the signer set, conferred by the promotion rail), while a
 * Coa-hosted community keeps its own role model unchanged (AC7).
 *
 * The e2e harness runs a Coa backend, so this spec verifies the AC7 side that IS
 * reproducible here — the Invite Member editor still offers Founding Member — and
 * screenshots the affected surface. The IDSS side (Founding Member withheld) and
 * the promotion-rail behaviour (AC1/AC5/AC6) are covered by Vitest at the
 * admin-actions / role-editor seam (issue-669-*.test.ts), which can drive an IDSS
 * descriptor the Coa harness cannot.
 */

test.describe('#669 role editor — Founding Member on a Coa community (AC7)', () => {
  test('the Invite Member editor still offers Founding Member', async ({ adminPage, snap }) => {
    await adminPage.goto('/#/dashboard');

    const inviteBtn = adminPage.locator('.invite-btn');
    await inviteBtn.waitFor({ state: 'visible' });
    await inviteBtn.click();

    // The steward's Initial Role picker lists Founding Member on a Coa backend —
    // the app's own role model is unchanged.
    const roleSelect = adminPage.locator('select').filter({ has: adminPage.locator('option[value="Founding Member"]') });
    await expect(roleSelect).toBeVisible();
    await expect(roleSelect.locator('option[value="Founding Member"]')).toHaveCount(1);
    await expect(roleSelect.locator('option[value="Community Steward"]')).toHaveCount(1);

    await snap(adminPage, 'invite-role-picker-coa');
  });
});
