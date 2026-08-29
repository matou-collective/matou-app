import { test, expect, Page } from './fixtures';

// Feature (#126): while the soft keyboard is open the mobile bottom tab bar is
// hidden so it doesn't float above the keyboard and eat vertical space. The
// DashboardLayout listens for the Capacitor `keyboardWillShow`/`keyboardWillHide`
// window events (and, on-device, a visualViewport height shrink); toggling the
// `keyboard-open` class hides `.bottom-nav` and collapses its reserved content
// padding. We can't summon a real soft keyboard in a desktop browser, so we
// drive the deterministic Capacitor window events the layout subscribes to.

const PHONE = { width: 390, height: 844 };

/** Emulate the Capacitor Keyboard plugin firing its window events. */
async function fireKeyboard(page: Page, event: 'keyboardWillShow' | 'keyboardWillHide') {
  await page.evaluate((name) => {
    window.dispatchEvent(new Event(name));
  }, event);
  await page.waitForTimeout(150); // let the reactive class toggle + CSS settle
}

test.describe('mobile bottom tab bar hides with the keyboard (#126)', () => {
  test('bottom nav hides on keyboardWillShow and returns on keyboardWillHide', async ({
    adminPage,
    snap,
  }) => {
    const page = adminPage;
    await page.setViewportSize(PHONE);
    await page.goto('/');

    const bottomNav = page.locator('.bottom-nav');
    // At phone width the bottom tab bar is the only navigation — visible at rest.
    await expect(bottomNav).toBeVisible();
    await snap(page, 'keyboard-closed-nav-visible');

    // Soft keyboard opens (chat composer, forms) → tab bar hides.
    await fireKeyboard(page, 'keyboardWillShow');
    await expect(bottomNav).toBeHidden();
    // Reserved tab-bar padding is collapsed while hidden so the space is usable.
    const mainPadding = await page
      .locator('.main-content')
      .evaluate((el) => getComputedStyle(el).paddingBottom);
    expect(mainPadding).toBe('0px');
    await snap(page, 'keyboard-open-nav-hidden');

    // Keyboard closes → tab bar returns.
    await fireKeyboard(page, 'keyboardWillHide');
    await expect(bottomNav).toBeVisible();
    await snap(page, 'keyboard-closed-nav-restored');
  });
});
