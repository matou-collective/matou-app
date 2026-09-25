import { test, expect, Page } from './fixtures';

/**
 * Issue #622 — the wallet's Credentials tab draws each credential like the IDSS
 * control panel's credential card (mark tile top-left, status pill top-right,
 * bold name, a Received/Issued tag, description, date footer; a `display`
 * credential paints the whole card with its background and contrast ink). In a
 * Coa build the Cards/Graph toggle and the relationship graph are hidden.
 *
 * The Coa-vs-Mātou gate is a build-time constant (KIT.slug, baked at build), so
 * the no-toggle Coa case cannot be exercised in this stock-Mātou e2e harness —
 * it is covered by tests/scripts/issue-622-wallet-card.test.ts. What this spec
 * demonstrates is the card shape itself (section 2), which applies to every
 * build, plus that stock Mātou still offers both the toggle and the graph.
 *
 * As in issue-597.spec.ts, a styled credential only exists once an IDSS
 * community issues one, so we seed the wallet store's already-mapped
 * credentials directly through the app's own store module.
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
      // Painted: whole card takes this background with contrast ink.
      display: { name: 'Finance komiti', icon: 'landmark', background: '#0a5c6b' },
    },
    {
      ...base,
      said: 'ECREDPLAIN0000000000000000000000000000000000',
      schemaTitle: 'Mātou Membership',
      // No display → the same card shape, unpainted, with the seal/legacy mark.
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

test.describe('#622 wallet credential cards like the IDSS control panel', () => {
  test('painted + unpainted cards, and stock Mātou keeps the toggle + graph', async ({
    memberPage,
    snap,
  }) => {
    await openWallet(memberPage);
    await seedCredentials(memberPage, credFixtures());

    const cards = memberPage.locator('.wallet-cred-card');
    await expect(cards).toHaveCount(2);

    // Card shape: mark tile, status pill, bold name and a Received/Issued tag.
    const painted = cards.filter({ hasText: 'Finance komiti' });
    await expect(painted.locator('.cred-tile .cred-mark')).toBeVisible();
    await expect(painted.locator('.cred-pill')).toBeVisible();
    await expect(painted.locator('.cred-name')).toHaveText('Finance komiti');
    await expect(painted.locator('.cred-tag')).toBeVisible();

    // The painted card carries the display background inline and is .painted.
    await expect(painted).toHaveClass(/painted/);
    await expect(painted).toHaveAttribute('style', /background/);

    // The plain credential is the same card shape, unpainted.
    const plain = cards.filter({ hasText: 'Mātou Membership' });
    await expect(plain).not.toHaveClass(/painted/);
    await expect(plain.locator('.cred-pill')).toBeVisible();

    await snap(memberPage, 'wallet-credential-cards');

    // Stock Mātou still offers the Cards/Graph toggle and the graph view.
    const graphBtn = memberPage.getByRole('button', { name: /graph/i });
    await expect(graphBtn).toBeVisible();
    await graphBtn.click();
    await expect(memberPage.locator('.graph-view')).toBeVisible();
    await snap(memberPage, 'wallet-graph-still-available-on-matou');
  });
});
