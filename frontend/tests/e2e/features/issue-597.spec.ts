import { test, expect, Page } from './fixtures';
import { createHash } from 'crypto';

/**
 * Issue #597 — the wallet renders IDSS credentials by their `a.display` look
 * (name, Lucide icon, colour, verified image), while credentials WITHOUT a
 * `display` block render exactly as before.
 *
 * A styled credential only exists once an IDSS community issues one (idss#1758),
 * which the feature fixtures can't mint here. So this spec drives the real
 * wallet UI and seeds the wallet store's already-mapped credentials directly —
 * the same `/src/stores/*` dev-module seam e2e-credential-chain.spec.ts uses —
 * to exercise the four rendering paths the acceptance lists:
 *   1. display {icon + colour}  → a Lucide glyph on the community colour
 *   2. display {image + digest} → the verified image (sha256 matches)
 *   3. display {image + WRONG digest} → falls back to the IDSS seal
 *   4. no display               → the legacy Mātou membership look, unchanged
 *
 * The parse → sha256-verify → contrast-ink logic itself is unit-tested in
 * tests/scripts/credential-appearance.test.ts.
 */

// A 1×1 PNG, served for the verified-image mark. Its sha256 is the digest we
// seed on that credential, so the in-browser verify passes and the <img> shows.
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(PNG_B64, 'base64');
const PNG_DIGEST = createHash('sha256').update(PNG_BYTES).digest('hex');

const GOOD_IMG_URL = 'https://cdn.test/badge-verified.png';
const BAD_IMG_URL = 'https://cdn.test/badge-tampered.png';

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
      said: 'ECREDICON00000000000000000000000000000000000',
      schemaTitle: 'Committee Membership',
      committee: 'finance-komiti',
      display: { name: 'Finance komiti', icon: 'landmark', background: '#0a5c6b' },
    },
    {
      ...base,
      said: 'ECREDIMG0000000000000000000000000000000000000',
      schemaTitle: 'Verified Badge',
      display: {
        name: 'Verified Badge',
        background: '#f4c542',
        image: { url: GOOD_IMG_URL, digest: PNG_DIGEST },
      },
    },
    {
      ...base,
      said: 'ECREDBAD0000000000000000000000000000000000000',
      schemaTitle: 'Tampered Badge',
      display: {
        name: 'Tampered Badge',
        image: { url: BAD_IMG_URL, digest: 'f'.repeat(64) },
      },
    },
    {
      ...base,
      said: 'ECREDLEGACY000000000000000000000000000000000',
      schemaTitle: 'Mātou Membership',
      display: undefined,
    },
  ];
}

/** Dismiss the welcome overlay (issue-16 pattern) then land on the wallet. */
async function openWallet(page: Page): Promise<void> {
  await page.goto('/');
  await page
    .getByRole('button', { name: /enter community/i })
    .click({ timeout: 15_000 })
    .catch(() => {});
  await page.goto('/#/wallet');
  await expect(page.locator('.credentials-tab')).toBeVisible({ timeout: 30_000 });
  // Let the store's initial refresh settle before we seed over it.
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

test.describe('#597 wallet renders IDSS a.display credentials', () => {
  test('styled cards + detail dialog render by their display look', async ({ memberPage, snap }) => {
    // Serve the verified image (matching digest) and the tampered one.
    await memberPage.route(GOOD_IMG_URL, (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: PNG_BYTES }),
    );
    await memberPage.route(BAD_IMG_URL, (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: PNG_BYTES }),
    );

    await openWallet(memberPage);
    await seedCredentials(memberPage, credFixtures());

    const cards = memberPage.locator('.credential-card');
    await expect(cards).toHaveCount(4);

    // Titles come from display.name (or the title-cased committee).
    await expect(memberPage.locator('.card-title', { hasText: 'Finance komiti' })).toBeVisible();
    await expect(memberPage.locator('.card-title', { hasText: 'Verified Badge' })).toBeVisible();
    await expect(memberPage.locator('.card-title', { hasText: 'Tampered Badge' })).toBeVisible();
    await expect(memberPage.locator('.card-title', { hasText: 'Mātou Membership' })).toBeVisible();

    // The icon card paints its community background on the mark.
    const iconMark = cards.filter({ hasText: 'Finance komiti' }).locator('.cred-mark');
    await expect(iconMark).toHaveClass(/has-bg/);
    // The verified-image card shows an <img> mark.
    await expect(
      cards.filter({ hasText: 'Verified Badge' }).locator('.cred-mark img.mark-image'),
    ).toBeVisible();
    // The tampered card falls back to the seal (no <img>).
    await expect(
      cards.filter({ hasText: 'Tampered Badge' }).locator('.cred-mark img.mark-image'),
    ).toHaveCount(0);

    await snap(memberPage, 'credential-cards-by-display');

    // Open the styled committee credential's detail dialog.
    await cards.filter({ hasText: 'Finance komiti' }).click();
    await expect(memberPage.locator('.credential-dialog')).toBeVisible();
    await expect(memberPage.locator('.cred-title')).toHaveText('Finance komiti');
    await expect(memberPage.locator('.credential-dialog .cred-mark')).toHaveClass(/has-bg/);
    await snap(memberPage, 'credential-detail-by-display');
  });
});
