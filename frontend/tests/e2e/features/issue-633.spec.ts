import { test, expect, Page } from './fixtures';

/**
 * Issue #633 — the wallet's credential cards are redrawn to the IDSS control
 * panel's card anatomy (square mark tile, square white uppercase-monospace
 * status chip, bold monospace name, outlined uppercase-monospace tag, muted
 * monospace body lines, a dark square OPEN button). A `display.background`
 * credential paints the whole card with contrast ink; one without renders the
 * same shape unpainted.
 *
 * The exhaustive element-by-element pinning (plus the panel design-source
 * pointer for keeping the two in sync) lives in credential-card-parity.spec.ts.
 * This spec demonstrates the redraw in the live wallet and carries the
 * Mattermost screenshots.
 *
 * A styled credential only exists once an IDSS community issues one, so — as in
 * issue-597/issue-622 — we seed the wallet store directly through the app's own
 * store module.
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
      display: { name: 'Finance komiti', icon: 'landmark', background: '#0a5c6b' },
    },
    {
      ...base,
      said: 'ECREDPLAIN0000000000000000000000000000000000',
      schemaTitle: 'Mātou Membership',
      display: undefined,
    },
  ];
}

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

test.describe('#633 wallet credential cards redrawn to the panel anatomy', () => {
  test('painted + unpainted cards read as the panel card, OPEN opens the dialog', async ({
    memberPage,
    snap,
  }) => {
    await openWallet(memberPage);
    await seedCredentials(memberPage, credFixtures());

    const cards = memberPage.locator('.wallet-cred-card');
    await expect(cards).toHaveCount(2);

    const painted = cards.filter({ hasText: 'Finance komiti' });
    await expect(painted).toHaveClass(/painted/);
    await expect(painted.locator('.cred-tile .cred-mark')).toBeVisible();
    await expect(painted.locator('.cred-chip')).toBeVisible();
    await expect(painted.locator('.cred-tag')).toBeVisible();
    await expect(painted.locator('.cred-open')).toHaveText('OPEN');

    const plain = cards.filter({ hasText: 'Mātou Membership' });
    await expect(plain).not.toHaveClass(/painted/);
    await expect(plain.locator('.cred-open')).toHaveText('OPEN');

    // Wallet Credentials tab — the shot to place next to the control panel's
    // Members → Credentials for the same community.
    await snap(memberPage, 'wallet-credentials-panel-anatomy');

    await painted.locator('.cred-open').click();
    await expect(memberPage.locator('.credential-dialog')).toBeVisible();
    await snap(memberPage, 'credential-detail-open');
  });
});
