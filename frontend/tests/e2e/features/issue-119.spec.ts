import { test, expect, Page } from './fixtures';

// Feature (#119): apply safe-area insets so page content clears the Android
// status bar (top) and the Samsung/gesture navigation bar (bottom) on
// edge-to-edge Capacitor builds.
//
//  - OnboardingHeader adds a top inset (`.pt-safe-area`) so headers clear the
//    status bar; onboarding footers and scroll containers add a bottom inset
//    (`.pb-safe-area`) so CTAs/captions clear the navigation bar.
//  - DashboardLayout's mobile `.main-content` gets a top inset and keeps its
//    existing bottom inset on the tab bar.
//
// The true device insets (`env(safe-area-inset-*)`) are reported by the OS and
// are 0 in desktop Chromium, so this spec verifies the two verifiable, real
// pieces: (1) the mobile dashboard tab bar stays pinned to the bottom with
// content reserving its height (no regression), and (2) the shared
// `.pt-safe-area` / `.pb-safe-area` helpers resolve to the base onboarding
// padding at mobile width — on a device the status/nav-bar inset is added on
// top. Full status/nav-bar clearance needs a physical device (the issue notes
// it is not visible on the emulator).

const PHONE = { width: 390, height: 844 };
const BOTTOM_NAV_HEIGHT = 64; // $bottom-nav-height in DashboardLayout.vue

async function enterCommunity(page: Page) {
  await page
    .getByRole('button', { name: /enter community/i })
    .click({ timeout: 15_000 })
    .catch(() => {});
}

test.describe('mobile safe-area insets (#119)', () => {
  test('bottom tab bar stays pinned to the bottom and content reserves its height', async ({
    adminPage,
    snap,
  }) => {
    test.setTimeout(120_000);

    await adminPage.setViewportSize(PHONE);
    await enterCommunity(adminPage);
    await adminPage.goto('/#/dashboard');

    const nav = adminPage.locator('.bottom-nav');
    await expect(nav).toBeVisible({ timeout: 20_000 });

    // The tab bar is fixed to the very bottom edge of the viewport (above which,
    // on a device, the navigation-bar inset is reserved by its padding-bottom).
    const box = await nav.boundingBox();
    expect(box, 'bottom nav should have a bounding box').not.toBeNull();
    if (box) {
      expect(Math.round(box.y + box.height)).toBeLessThanOrEqual(PHONE.height + 1);
      expect(box.y + box.height).toBeGreaterThanOrEqual(PHONE.height - 2);
    }

    // Page content reserves at least the tab-bar height so nothing hides behind
    // it — the existing bottom-inset pattern this issue extends.
    const padBottom = await adminPage
      .locator('.main-content')
      .evaluate((el) => getComputedStyle(el).paddingBottom);
    expect(parseFloat(padBottom)).toBeGreaterThanOrEqual(BOTTOM_NAV_HEIGHT);

    await snap(adminPage, 'dashboard-mobile-bottom-nav');
    await snap(adminPage, 'dashboard-mobile-top');
  });

  test('safe-area padding helpers apply the base onboarding padding at mobile width', async ({
    adminPage,
  }) => {
    test.setTimeout(120_000);

    await adminPage.setViewportSize(PHONE);
    await enterCommunity(adminPage);

    // Probe the shared `.pt-safe-area` / `.pb-safe-area` helpers (app.scss) that
    // the onboarding header, footers and scroll containers use. env(safe-area-*)
    // resolves to 0 in desktop Chromium, so these fall back to the base p-6
    // padding (24px); on a device the status/nav-bar inset is added on top.
    const pads = await adminPage.evaluate(() => {
      const measure = (cls: string, side: 'paddingTop' | 'paddingBottom') => {
        const d = document.createElement('div');
        d.className = cls;
        document.body.appendChild(d);
        const value = getComputedStyle(d)[side];
        d.remove();
        return value;
      };
      return {
        top: measure('pt-safe-area', 'paddingTop'),
        bottom: measure('pb-safe-area', 'paddingBottom'),
      };
    });

    // 1.5rem === 24px at the default root font size.
    expect(parseFloat(pads.top)).toBeGreaterThanOrEqual(24);
    expect(parseFloat(pads.bottom)).toBeGreaterThanOrEqual(24);
  });
});
