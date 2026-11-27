import { test, expect, Page } from './fixtures';

/**
 * Issue #740 — the wallet tagged a credential "Issued" (with a "To:" line)
 * whenever its recipient was someone other than me, without ever checking that
 * I was the issuer. A Founding Member credential issued *to* another member
 * ("To: Ben") that surfaced in the wallet was therefore mislabelled as issued
 * by me.
 *
 * The fix: "Issued" (and the "To:" recipient line) appear only when I am the
 * credential's issuer; everything else is "Received".
 *
 * As in credential-card-parity.spec.ts, credentials are seeded through the
 * app's own wallet store module. The issuer AID is pinned to the signed-in
 * member's own AID for the "issued by me" case so the tag depends on the
 * issuer, not on who the recipient is.
 */

const BEN = 'EBEN0000000000000000000000000000000000000000';
const OTHER_ISSUER = 'EOTHERISSUER0000000000000000000000000000000';

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

/**
 * Seed two credentials via the app's own store module:
 *  - one issued BY the signed-in member to Ben  → must read "Issued" / "To:"
 *  - one issued by someone ELSE to Ben           → must read "Received" (#740)
 */
async function seedCredentials(page: Page): Promise<void> {
  await page.evaluate(
    async ({ ben, otherIssuer }) => {
      const walletMod = await import('/src/stores/wallet.ts');
      const identityMod = await import('/src/stores/identity.ts');
      const myAid =
        identityMod.useIdentityStore().currentAID?.prefix ||
        identityMod.useIdentityStore().aidPrefix ||
        'EMYAID0000000000000000000000000000000000000';

      const base = {
        schemaSaid: 'EMEMBERSHIPSCHEMA000000000000000000000000000',
        schemaTitle: 'Founding Member',
        schemaDescription: 'Founding membership credential.',
        communityName: 'Te Rūnanga o Example',
        role: 'Member',
        permissions: [] as string[],
        joinedAt: '2026-09-01T00:00:00Z',
        issuedAt: '2026-09-20T00:00:00Z',
        status: '0',
        claim: '',
        endorsementType: '',
        eventName: '',
        eventType: '',
        committee: '',
        display: undefined,
      };

      const creds = [
        {
          ...base,
          said: 'ECREDISSUEDBYME00000000000000000000000000000',
          // I am the issuer → "Issued" + "To: Ben".
          issuerAid: myAid,
          issueeAid: ben,
        },
        {
          ...base,
          said: 'ECREDISSUEDBYOTHER000000000000000000000000000',
          // Someone else issued this to Ben → "Received", never "Issued" (#740).
          issuerAid: otherIssuer,
          issueeAid: ben,
        },
      ];

      const store = walletMod.useWalletStore();
      store.credentialsLoading = false;
      store.credentialsError = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      store.credentials = creds as any;
    },
    { ben: BEN, otherIssuer: OTHER_ISSUER },
  );
}

test.describe('wallet "Issued" tag reflects the issuer, not the recipient (#740)', () => {
  test('only a credential I issued is tagged "Issued" with a "To:" line', async ({
    memberPage,
    snap,
  }) => {
    await openWallet(memberPage);
    await seedCredentials(memberPage);

    const cards = memberPage.locator('.wallet-cred-card');
    await expect(cards).toHaveCount(2);

    const mine = cards.nth(0);
    const other = cards.nth(1);

    // The credential I issued: "Issued" tag + a "To:" recipient line.
    await expect(mine.locator('.cred-tag')).toHaveText('Issued');
    await expect(mine.locator('.cred-recipient')).toContainText('To:');

    // The credential someone else issued to Ben: "Received", no "To:" line.
    await expect(other.locator('.cred-tag')).toHaveText('Received');
    await expect(other.locator('.cred-recipient')).toHaveCount(0);

    await snap(memberPage, 'issued-tag-reflects-issuer');
  });
});
