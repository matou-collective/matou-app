import { test, expect, Page } from './fixtures';

/**
 * PR #650 — the wallet's credential cards sit in a ROW at the IDSS control
 * panel card's size (~220px columns, one row height), not a full-width list.
 * #622/#633 redrew the card but left CredentialsTab's grid at one full-width
 * column. An IDSS credential also carries the panel's "services know it as
 * <slug>" line and its own description.
 *
 * The exhaustive element-by-element pinning lives in
 * credential-card-parity.spec.ts. This spec demonstrates the row in the live
 * wallet and carries the Mattermost screenshots.
 *
 * A styled credential only exists once an IDSS community issues one, so — as in
 * issue-597/issue-622/issue-633 — we seed the wallet store directly through the
 * app's own store module.
 */

function credFixtures() {
  const base = {
    schemaSaid: 'ESOMEIDSSSCHEMASAID000000000000000000000000',
    schemaDescription: '',
    issuerAid: 'EISSUERORGAID0000000000000000000000000000000',
    issueeAid: 'EMEMBERAID000000000000000000000000000000000',
    communityName: 'Te Rūnanga o Example',
    role: 'member',
    permissions: [] as string[],
    joinedAt: '2026-09-01T00:00:00Z',
    issuedAt: '2026-09-20T00:00:00Z',
    status: '0',
    claim: '',
    endorsementType: '',
    eventName: '',
    eventType: '',
    committee: '',
  };
  return [
    {
      ...base,
      said: 'ECREDMEMBERSHIP0000000000000000000000000000',
      schemaTitle: 'Membership',
      schemaDescription: 'Belonging to this community — the credential every member holds.',
      committee: 'membership',
      display: { name: 'Membership', background: '#f2eee3' },
    },
    {
      ...base,
      said: 'ECREDADMINISTRATOR000000000000000000000000000',
      schemaTitle: 'Administrator',
      schemaDescription: 'Community administrators with access to admin services',
      committee: 'administrator',
      display: { name: 'Administrator', icon: 'handshake', background: '#b9d3c6' },
    },
    {
      ...base,
      said: 'ECREDLEGACY0000000000000000000000000000000000',
      schemaTitle: 'Mātou Membership',
      role: 'Member',
      // Old-style credential: no a.display, keeps its legacy lines.
      display: undefined,
    },
  ];
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

/** Seed the wallet store with fixtures via the app's own store module. */
async function seedCredentials(page: Page, creds: unknown[]): Promise<void> {
  await page.evaluate(async (list) => {
    const mod = await import('/src/stores/wallet.ts');
    const store = mod.useWalletStore();
    store.credentialsLoading = false;
    store.credentialsError = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.credentials = list as any;
  }, creds);
}

test.describe('PR #650 — wallet credentials in a row at the panel card size', () => {
  test('cards sit side by side at ~220px, one height, with the panel content', async ({
    memberPage,
    snap,
  }) => {
    await memberPage.setViewportSize({ width: 1280, height: 900 });
    await openWallet(memberPage);
    await seedCredentials(memberPage, credFixtures());

    const cards = memberPage.locator('.wallet-cred-card');
    await expect(cards).toHaveCount(3);

    const boxes = await cards.evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return { y: r.y, width: r.width, height: r.height };
      }),
    );
    for (const b of boxes) expect(b.width).toBeLessThanOrEqual(221); // panel width, not full
    expect(new Set(boxes.map((b) => Math.round(b.y))).size).toBe(1); // one row
    expect(new Set(boxes.map((b) => Math.round(b.height))).size).toBe(1); // one height

    const admin = cards.filter({ hasText: 'Administrator' });
    await expect(admin.locator('.cred-prod')).toContainText('services know it as');
    await expect(admin.locator('.cred-prod code')).toHaveText('administrator');
    await expect(admin).toContainText('Community administrators with access to admin services');

    // The legacy credential keeps its old lines — no "services know it as".
    const legacy = cards.filter({ hasText: 'Mātou Membership' });
    await expect(legacy.locator('.cred-prod')).toHaveCount(0);

    await snap(memberPage, 'wallet-credentials-row');
  });
});
