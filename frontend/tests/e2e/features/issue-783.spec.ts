import { test, expect, Page } from './fixtures';

/**
 * Feature (#783): the Coa app gains i18n — vue-i18n wired through a boot file,
 * per-area catalogues (en authoritative; es/nl/fr/pt-BR machine drafts), a
 * header language picker, and the org-setup screen migrated as the pilot area.
 *
 * This drives the pilot end-to-end: the setup screen lives at /#/setup under
 * the onboarding layout (which hosts the language picker), so it is reachable
 * on a fresh, unauthenticated session without running the KERIA-heavy org
 * creation. We render it, confirm it reads in English, switch the picker to
 * Español, and confirm the same screen now reads in Spanish — while English is
 * unchanged from today.
 *
 * The full app's other areas are migrated by the per-area follow-up tickets
 * this epic files; only the setup pilot is asserted here.
 */

// The setup screen's English strings (en is authoritative, unchanged).
const EN_TITLE = /Set up/i;
const EN_NAME_LABEL = 'Admin Display Name';
// Spanish machine-draft equivalents.
const ES_TITLE = /Configurar/i;
const ES_NAME_LABEL = 'Nombre para mostrar del administrador';

async function openSetup(page: Page) {
  await page.goto('/#/setup');
  await page.waitForLoadState('domcontentloaded');
  // The admin-name label anchors the form (it renders from the setup catalogue).
  await expect(page.getByText(EN_NAME_LABEL)).toBeVisible({ timeout: 30_000 });
}

async function pickLanguage(page: Page, nativeName: string) {
  await page.locator('.language-picker__trigger').click();
  await page
    .locator('.language-picker__option', { hasText: nativeName })
    .click();
}

test.describe('i18n foundation + setup pilot (#783)', () => {
  test('setup screen reads in English, then Spanish via the header picker', async ({
    freshPage,
    snap,
  }) => {
    const page = freshPage;
    await openSetup(page);

    // English (authoritative) — the picker is present in the header.
    await expect(page.locator('h1')).toContainText(EN_TITLE);
    await expect(page.locator('.language-picker__trigger')).toBeVisible();
    await snap(page, 'setup-en');

    // Switch to Spanish.
    await pickLanguage(page, 'Español');
    await expect(page.locator('h1')).toContainText(ES_TITLE);
    await expect(page.getByText(ES_NAME_LABEL)).toBeVisible();
    await snap(page, 'setup-es');

    // Back to English: the same screen is unchanged from today.
    await pickLanguage(page, 'English');
    await expect(page.locator('h1')).toContainText(EN_TITLE);
    await expect(page.getByText(EN_NAME_LABEL)).toBeVisible();
  });
});
