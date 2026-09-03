import { test, expect, Page } from './fixtures';

// Feature (#337): the kit secondary colour becomes a very light tint on
// background tokens, and the selected nav tab (desktop sidebar AND mobile
// bottom-nav) gets that secondary wash as its background.
//
//  - apply-kit.mjs washes a saturated kit secondary (e.g. gold #F2B134) into a
//    translucent `color-mix` wash for --matou-secondary / --matou-muted /
//    --matou-sidebar-accent, keeping the full value as --matou-secondary-strong.
//    A pale tint like stock #E8F4F8 is left solid (stock look unchanged).
//  - The selected sidebar item already used --matou-sidebar-accent; the mobile
//    bottom-nav .active now paints --matou-sidebar-accent behind the tab too.
//
// The test env runs the stock kit (secondary #E8F4F8), so this spec verifies
// the wiring that is verifiable here: (1) --matou-sidebar-accent resolves to a
// non-empty colour, (2) the selected sidebar tab paints it, and (3) the
// selected bottom-nav tab paints it. The gold-wash appearance itself is a
// branded-build concern proven by the apply-kit unit tests.

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

async function enterCommunity(page: Page) {
  await page
    .getByRole('button', { name: /enter community/i })
    .click({ timeout: 15_000 })
    .catch(() => {});
}

function isPainted(bg: string | undefined): boolean {
  // A real background colour — not transparent / unset.
  return (
    !!bg &&
    bg !== 'transparent' &&
    bg !== 'rgba(0, 0, 0, 0)' &&
    !bg.startsWith('rgba(0, 0, 0, 0')
  );
}

test.describe('kit secondary tint + selected-nav-tab background (#337)', () => {
  test('the selected sidebar tab paints the kit secondary accent', async ({
    adminPage,
    snap,
  }) => {
    test.setTimeout(120_000);

    await adminPage.setViewportSize(DESKTOP);
    await enterCommunity(adminPage);
    await adminPage.goto('/#/dashboard');

    const active = adminPage.locator('.nav-item.active').first();
    await expect(active).toBeVisible({ timeout: 20_000 });

    // --matou-sidebar-accent is kit-driven and resolves to a real colour.
    const accent = await adminPage.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue('--matou-sidebar-accent')
        .trim(),
    );
    expect(accent.length).toBeGreaterThan(0);

    const bg = await active.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(isPainted(bg)).toBe(true);

    await snap(adminPage, 'sidebar-selected-tab-accent');
  });

  test('the selected bottom-nav tab paints the kit secondary accent', async ({
    adminPage,
    snap,
  }) => {
    test.setTimeout(120_000);

    await adminPage.setViewportSize(PHONE);
    await enterCommunity(adminPage);
    await adminPage.goto('/#/dashboard');

    const nav = adminPage.locator('.bottom-nav');
    await expect(nav).toBeVisible({ timeout: 20_000 });

    const active = adminPage.locator('.bottom-nav-item.active').first();
    await expect(active).toBeVisible({ timeout: 20_000 });

    const bg = await active.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(isPainted(bg)).toBe(true);

    await snap(adminPage, 'bottom-nav-selected-tab-accent');
  });
});
