import { test, expect, Page } from './fixtures';

/**
 * Feature (#642): the FULL app draws its colour from the kit — no Mātou teal or
 * navy anywhere in a community build. Every brand colour flows through the
 * --matou-* tokens (apply-kit fills primary/secondary/accent from the kit;
 * design-tokens.scss derives charts, avatars, sidebar, dark surfaces, borders,
 * washes and gradients with color-mix over them), and user-facing copy comes from
 * KIT.brand.*.
 *
 * The token/copy wiring is proven exhaustively by the repo-wide unit guards
 * (tests/scripts/kit-colour-leaks.test.ts, kit-copy-leaks.test.ts). This e2e
 * walks the acceptance screens in BOTH themes so the reviewer can eyeball, on the
 * screenshots, that the palette renders correctly across the app. Run against a
 * clearly-non-teal kit (a red / yellow / purple primary·secondary·accent) it
 * shows the kit colour everywhere; against stock it shows the unchanged Mātou
 * look.
 */

async function enterCommunity(page: Page) {
  await page
    .getByRole('button', { name: /enter community/i })
    .click({ timeout: 15_000 })
    .catch(() => {});
}

async function forceTheme(page: Page, choice: 'dark' | 'light') {
  await page.addInitScript((c) => {
    try {
      localStorage.setItem('matou:theme', c);
    } catch {
      /* ignore */
    }
  }, choice);
}

// The acceptance screens reachable from a logged-in session, by route.
const SCREENS: { path: string; label: string }[] = [
  { path: '/dashboard', label: 'dashboard' },
  { path: '/dashboard/chat', label: 'chat' },
  { path: '/dashboard/activity', label: 'notices' },
  { path: '/dashboard/projects', label: 'projects' },
  { path: '/dashboard/contributions', label: 'contributions' },
  { path: '/dashboard/proposals', label: 'proposals' },
  { path: '/dashboard/wallet', label: 'wallet' },
  { path: '/dashboard/community-settings', label: 'community-settings' },
  { path: '/dashboard/settings', label: 'account-settings' },
];

for (const theme of ['light', 'dark'] as const) {
  test(`#642 every screen renders the kit palette (${theme})`, async ({ adminPage, snap }) => {
    test.setTimeout(300_000);
    await forceTheme(adminPage, theme);

    for (const { path, label } of SCREENS) {
      await adminPage.goto(path);
      await enterCommunity(adminPage);
      // Let the route settle; a feature disabled by the kit simply redirects to
      // the dashboard, which still exercises the palette.
      await adminPage.waitForTimeout(1500);
      await snap(adminPage, `${label}-${theme}`);
    }

    // Wallet credential detail — open the first credential card if one exists.
    await adminPage.goto('/dashboard/wallet');
    await enterCommunity(adminPage);
    const firstCard = adminPage.locator('.credential-card, .cred-card, [data-credential]').first();
    if (await firstCard.count()) {
      await firstCard.click({ timeout: 5_000 }).catch(() => {});
      await adminPage.waitForTimeout(1000);
      await snap(adminPage, `wallet-detail-${theme}`);
    }

    // In dark mode, the design tokens key off the .dark class.
    if (theme === 'dark') {
      await expect
        .poll(async () =>
          adminPage.evaluate(() => document.documentElement.classList.contains('dark')),
        )
        .toBe(true);
    }
  });
}

test('#642 the splash screen renders the kit brand (light + dark)', async ({ freshPage, snap }) => {
  test.setTimeout(120_000);
  for (const theme of ['light', 'dark'] as const) {
    await forceTheme(freshPage, theme);
    await freshPage.goto('/');
    await freshPage.waitForTimeout(1500);
    await snap(freshPage, `splash-${theme}`);
  }
});
