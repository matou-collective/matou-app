import { test, expect, Page } from './fixtures';

/**
 * Feature (#121): the pending-approval ("Your application is under review")
 * screen laid its three requirement cards (Endorsement / Confirmation /
 * Attendance) in a grid hard-coded to `repeat(3, 1fr)` with no responsive
 * breakpoint. At phone width (~412px css) the three cards can't fit, so the
 * row overflowed to the right, the third card was clipped, and the page
 * became wider than the viewport.
 *
 * The fix switches `.requirements-grid` to
 * `grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr))` so the cards
 * wrap to fewer columns at phone width (no horizontal overflow, all three
 * visible) while still sitting three-across on desktop.
 *
 * The pending-approval screen is an onboarding-only screen, not reachable from
 * a logged-in dashboard session. Rather than run a full fresh registration
 * (forbidden by the fixture contract, and KERIA-heavy), we render it directly:
 * navigate the fixture page to the onboarding route and drive the onboarding
 * Pinia store to the 'pending-approval' screen. The requirement cards render
 * from local state, so no live approval is needed. Needs live phone-device
 * verification for the real registration flow.
 */

const PHONE = { width: 412, height: 915 }; // S23 css px, matches the walkthrough
const DESKTOP = { width: 1280, height: 900 };

// Render the pending-approval screen by navigating to onboarding and forcing
// the onboarding store's current screen. Waits until the requirement cards
// mount so callers can measure a settled layout.
async function showPendingApproval(page: Page) {
  await page.goto('/#/');
  await page.waitForLoadState('domcontentloaded');

  await page.waitForFunction(() => {
    const el = document.querySelector('#q-app') as (HTMLElement & { __vue_app__?: any }) | null;
    const pinia = el?.__vue_app__?.config?.globalProperties?.$pinia;
    const store = pinia?._s?.get('onboarding');
    if (!store) return false;
    store.navigateTo('pending-approval');
    return true;
  }, { timeout: 30_000 });

  await expect(page.getByText(/your application is under review/i)).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator('.requirement-card')).toHaveCount(3);
}

// No horizontal overflow: the page must never be wider than the viewport.
async function overflowPx(page: Page): Promise<number> {
  await page.waitForTimeout(300); // let the grid reflow after a resize
  return page.evaluate(() => {
    const d = document.documentElement;
    return d.scrollWidth - d.clientWidth;
  });
}

test.describe('pending-approval requirement cards fit phone width (#121)', () => {
  test('cards wrap at 412px with no horizontal overflow, three-across on desktop', async ({
    memberPage,
    snap,
  }) => {
    test.setTimeout(120_000);

    // --- Phone width: no overflow, all three cards visible -------------------
    await memberPage.setViewportSize(PHONE);
    await showPendingApproval(memberPage);

    const cards = memberPage.locator('.requirement-card');
    for (let i = 0; i < 3; i++) {
      await expect(cards.nth(i)).toBeVisible();
    }

    expect(await overflowPx(memberPage), 'no horizontal page overflow at 412px').toBeLessThanOrEqual(1);

    // Every card fits inside the viewport (nothing clipped off the right edge).
    for (let i = 0; i < 3; i++) {
      const box = await cards.nth(i).boundingBox();
      expect(box, `card ${i} has a box`).not.toBeNull();
      if (box) {
        expect(box.x + box.width, `card ${i} fits within ${PHONE.width}px`).toBeLessThanOrEqual(
          PHONE.width + 1,
        );
      }
    }
    await snap(memberPage, 'phone-412-cards-wrapped');

    // --- Desktop width: the three cards stay across one row ------------------
    await memberPage.setViewportSize(DESKTOP);
    expect(await overflowPx(memberPage), 'no horizontal overflow at desktop').toBeLessThanOrEqual(1);

    const tops: number[] = [];
    for (let i = 0; i < 3; i++) {
      const box = await cards.nth(i).boundingBox();
      if (box) tops.push(box.y);
    }
    expect(tops.length).toBe(3);
    // All three share (approximately) the same top → one row.
    const maxTopDelta = Math.max(...tops) - Math.min(...tops);
    expect(maxTopDelta, 'three cards render on a single row on desktop').toBeLessThanOrEqual(2);
    await snap(memberPage, 'desktop-cards-one-row');
  });
});
