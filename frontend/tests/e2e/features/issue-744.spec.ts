import { test, expect, Page } from './fixtures';

/**
 * Issue #744 — a member who holds an Operations Steward credential was still
 * told "insufficient permissions" on steward actions (delete project, edit
 * milestones, add a project lead/steward).
 *
 * Root cause: the backend resolves a caller's RBAC roles from its local
 * credential cache (CredentialRoleLookup, #739). That cache is filled only from
 * credentials the frontend syncs or from the community credential tree — which
 * a member cannot read while their any-sync ACL lacks the read key. A received
 * steward credential that shows in the wallet (read straight from KERIA) never
 * reached the cache, so role resolution stayed on [member].
 *
 * Fix: whenever the wallet loads its credentials it pushes the member's own
 * role credentials to the backend's `POST /api/v1/sync/credentials`, so a held
 * role credential upgrades the effective role even when the trees won't sync.
 *
 * This spec proves the mechanism the fix adds: opening the wallet pushes the
 * member's held role credential (here their registration membership) to the
 * backend sync endpoint. (The e2e member holds only their registration
 * credential; the sync itself is what was missing for a later-received steward
 * credential — see the Vitest reproduction in
 * tests/scripts/issue-744-role-sync.test.ts.)
 */

interface SyncBody {
  userAid: string;
  credentials: Array<{ said: string; recipient: string; data?: { role?: string } }>;
}

/** Dismiss the welcome overlay then land on the wallet (issue-597 pattern). */
async function openWallet(page: Page): Promise<void> {
  await page.goto('/');
  await page
    .getByRole('button', { name: /enter community/i })
    .click({ timeout: 15_000 })
    .catch(() => {});
  await page.goto('/#/dashboard/wallet');
  await expect(page.locator('.credentials-tab')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.loading-state')).toHaveCount(0, { timeout: 30_000 });
}

test.describe('wallet syncs held role credentials to the backend RBAC cache (#744)', () => {
  test('opening the wallet pushes the member\'s role credential to /sync/credentials', async ({
    memberPage,
    snap,
  }) => {
    // Catch the sync POST the wallet's loadCredentials() fires. Attach before
    // navigating so we never miss it.
    const syncReq = memberPage.waitForRequest(
      (req) => req.method() === 'POST' && req.url().includes('/api/v1/sync/credentials'),
      { timeout: 30_000 },
    );

    await openWallet(memberPage);

    const req = await syncReq;
    const body = req.postDataJSON() as SyncBody;

    // The member's own AID drives the sync, and every synced credential is a
    // self-held role credential (the gap #739's lookup depended on being filled).
    expect(body.userAid).toBeTruthy();
    expect(body.credentials.length).toBeGreaterThan(0);
    for (const cred of body.credentials) {
      expect(cred.recipient).toBe(body.userAid);
      expect(cred.data?.role).toBeTruthy();
    }

    await snap(memberPage, 'role-credential-synced-to-backend');
  });
});
