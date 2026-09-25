import { test, expect, Page } from './fixtures';

/**
 * Community app adopts the shared IDSS kit token vocabulary + fonts (#657,
 * IDSS DDR 0281). `kit:apply` now emits the `--oc-*` names (`--oc-accent`,
 * `--oc-secondary`, `--oc-text-on-accent`, `--oc-background`, the `--oc-status-*`
 * set) plus the kit fonts (`--oc-font-serif` = Merriweather, `--oc-font-sans` =
 * Roboto Mono) as the one brand source; the legacy `--matou-*` tokens are kept
 * only as aliases onto them, and headings/UI wear the kit fonts (Roboto replaced).
 *
 * This spec pins that contract at runtime — the `--oc-*` tokens resolve, the
 * `--matou-*` aliases point at them, and the rendered families are the kit's —
 * and carries screenshots of the dashboard and the wallet cards into the PR for
 * the side-by-side comparison with the matching IDSS surface.
 */

async function openDashboard(page: Page): Promise<void> {
  await page.goto('/');
  await page
    .getByRole('button', { name: /enter community/i })
    .click({ timeout: 15_000 })
    .catch(() => {});
  await page.goto('/#/dashboard');
  await expect(page.locator('body')).toBeVisible({ timeout: 30_000 });
}

async function openWallet(page: Page): Promise<void> {
  await page.goto('/#/dashboard/wallet');
  await expect(page.locator('.credentials-tab')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.loading-state')).toHaveCount(0, { timeout: 30_000 });
}

async function seedCredential(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const mod = await import('/src/stores/wallet.ts');
    const store = mod.useWalletStore();
    store.credentialsLoading = false;
    store.credentialsError = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store.credentials = [
      {
        said: 'ECRED657000000000000000000000000000000000000',
        schemaSaid: 'ESOMEIDSSSCHEMASAID000000000000000000000000',
        schemaTitle: 'Committee Membership',
        schemaDescription: 'An IDSS-issued community credential.',
        issuerAid: 'EISSUERORGAID0000000000000000000000000000000',
        issueeAid: 'EMEMBERAID000000000000000000000000000000000',
        communityName: 'Te Rūnanga o Example',
        role: 'Member',
        permissions: [],
        committee: 'finance-komiti',
        joinedAt: '2026-09-01T00:00:00Z',
        issuedAt: '2026-09-20T00:00:00Z',
        status: '0',
        claim: '',
        endorsementType: '',
        eventName: '',
        eventType: '',
        display: { name: 'Finance komiti', icon: 'landmark', background: '#0a5c6b' },
      },
    ] as any;
  });
}

test.describe('shared kit tokens + fonts (#657, DDR 0281)', () => {
  test('the --oc-* vocabulary resolves, --matou-* alias onto it, and the kit fonts render', async ({
    memberPage,
    snap,
  }) => {
    await openDashboard(memberPage);

    // --- The shared --oc-* brand vocabulary is defined on :root. ---
    const tokens = await memberPage.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      const read = (n: string) => cs.getPropertyValue(n).trim();
      return {
        accent: read('--oc-accent'),
        secondary: read('--oc-secondary'),
        textOnAccent: read('--oc-text-on-accent'),
        background: read('--oc-background'),
        statusDanger: read('--oc-status-danger'),
        fontSerif: read('--oc-font-serif'),
        fontSans: read('--oc-font-sans'),
        matouPrimary: read('--matou-primary'),
      };
    });
    expect(tokens.accent).toBeTruthy();
    expect(tokens.secondary).toBeTruthy();
    expect(tokens.textOnAccent).toBeTruthy();
    expect(tokens.background).toBeTruthy();
    expect(tokens.statusDanger).toBeTruthy();
    expect(tokens.fontSerif.toLowerCase()).toContain('merriweather');
    expect(tokens.fontSans.toLowerCase()).toContain('roboto mono');
    // --matou-primary is now an alias onto --oc-accent, resolving to the same colour.
    expect(tokens.matouPrimary).toBe(tokens.accent);

    // --- Headings wear Merriweather; the UI/body wears Roboto Mono (Roboto gone). ---
    const bodyFamily = await memberPage.evaluate(
      () => getComputedStyle(document.body).fontFamily.toLowerCase(),
    );
    expect(bodyFamily).toContain('roboto mono');
    expect(bodyFamily).not.toMatch(/(^|[^-])\broboto\b(?!\smono)/); // plain Roboto replaced

    await snap(memberPage, 'dashboard-kit-fonts');

    // --- The wallet cards render in the kit type system. ---
    await openWallet(memberPage);
    await seedCredential(memberPage);
    const card = memberPage.locator('.wallet-cred-card').first();
    await expect(card).toBeVisible();
    const cardFamily = await card.evaluate((el) =>
      getComputedStyle(el).fontFamily.toLowerCase(),
    );
    expect(cardFamily).toContain('roboto mono');
    await snap(memberPage, 'wallet-cards-kit-fonts');
  });
});
