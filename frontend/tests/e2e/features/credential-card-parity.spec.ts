import { test, expect, Page } from './fixtures';

/**
 * Credential-card parity (issue #633, follow-up to #622) — the wallet's
 * credential card is drawn to the IDSS control panel's card anatomy so the two
 * read as the same card. This spec pins that anatomy by STRUCTURE (tile / chip /
 * name / tag / body / OPEN) for a painted and an unpainted credential, and
 * carries a screenshot of the pair into the PR for the side-by-side comparison
 * with the panel's Members → Credentials.
 *
 * The design source is named in WalletCredentialCard.vue's header comment; when
 * the IDSS panel card changes, this spec is its named counterpart to re-pin.
 *
 * A styled credential only exists once an IDSS community issues one, so — as in
 * issue-597/issue-622 — we seed the wallet store's already-mapped credentials
 * directly through the app's own store module.
 */

function credFixtures() {
  const base = {
    schemaSaid: 'ESOMEIDSSSCHEMASAID000000000000000000000000',
    schemaDescription: 'An IDSS-issued community credential.',
    issuerAid: 'EISSUERORGAID0000000000000000000000000000000',
    issueeAid: 'EMEMBERAID000000000000000000000000000000000',
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
  };
  return [
    {
      ...base,
      said: 'ECREDPAINTED00000000000000000000000000000000',
      schemaTitle: 'Committee Membership',
      committee: 'finance-komiti',
      // Painted: the whole card takes this background with contrast ink.
      display: { name: 'Finance komiti', icon: 'landmark', background: '#0a5c6b' },
    },
    {
      ...base,
      said: 'ECREDPLAIN0000000000000000000000000000000000',
      schemaTitle: 'Mātou Membership',
      // No display → the same card anatomy, unpainted, with the seal/legacy mark.
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

test.describe('credential-card parity with the IDSS control panel (#633)', () => {
  test('pins the panel card anatomy for a painted and an unpainted card', async ({
    memberPage,
    snap,
  }) => {
    await openWallet(memberPage);
    await seedCredentials(memberPage, credFixtures());

    const cards = memberPage.locator('.wallet-cred-card');
    await expect(cards).toHaveCount(2);

    // --- Painted card: every element of the panel anatomy is present. ---
    const painted = cards.filter({ hasText: 'Finance komiti' });
    await expect(painted).toHaveClass(/painted/);
    await expect(painted).toHaveAttribute('style', /background/); // whole card painted
    await expect(painted.locator('.cred-tile .cred-mark')).toBeVisible(); // square mark tile
    await expect(painted.locator('.cred-chip')).toBeVisible(); // status chip
    await expect(painted.locator('.cred-name')).toHaveText('Finance komiti'); // monospace name
    await expect(painted.locator('.cred-tag')).toBeVisible(); // outlined tag
    await expect(painted.locator('.cred-line').first()).toBeVisible(); // muted body line
    await expect(painted.locator('.cred-open')).toHaveText('OPEN'); // OPEN button

    // --- Unpainted card: the same anatomy, no paint. ---
    const plain = cards.filter({ hasText: 'Mātou Membership' });
    await expect(plain).not.toHaveClass(/painted/);
    await expect(plain.locator('.cred-tile .cred-mark')).toBeVisible();
    await expect(plain.locator('.cred-chip')).toBeVisible();
    await expect(plain.locator('.cred-name')).toHaveText('Mātou Membership');
    await expect(plain.locator('.cred-tag')).toBeVisible();
    await expect(plain.locator('.cred-open')).toHaveText('OPEN');

    // The pair — for the side-by-side with the panel's Members → Credentials.
    await snap(memberPage, 'credential-card-parity');

    // OPEN opens the detail dialog (the card's only click affordance now).
    await plain.locator('.cred-open').click();
    await expect(memberPage.locator('.credential-dialog')).toBeVisible();
    await snap(memberPage, 'credential-card-parity-open-dialog');
  });
});
