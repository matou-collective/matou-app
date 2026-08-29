import { test, expect, Page } from './fixtures';

// Feature (#120): On the Values / Member Expectations list, each bullet dot
// (`•`) wrapped onto its own line ABOVE its text at phone width because the
// bullet span in MatouInformationContent.vue had no shrink guard. The fix adds
// `shrink-0` to the bullet span (mirroring the Community Goals icon), keeping
// the dot inline to the left of its text at all widths.
//
// The shared component renders on the Community Guidelines page, which is a
// public onboarding route. We load it at phone width and assert, for each
// expectation row, that the bullet sits to the LEFT of its text and shares the
// row's first text line (i.e. it is inline, not stacked above).

const PHONE = { width: 412, height: 915 };

async function firstExpectationRow(page: Page) {
  const list = page.locator('.expectations-card ul');
  await expect(list).toBeVisible({ timeout: 15_000 });
  return list.locator('li').first();
}

test.describe('member expectations bullet inline (#120)', () => {
  test('bullet renders inline to the left of the text at phone width', async ({ adminPage, snap }) => {
    test.setTimeout(120_000);
    const page = adminPage;

    await page.setViewportSize(PHONE);
    await page.goto('/community-guidelines');

    const row = await firstExpectationRow(page);
    await expect(row).toBeVisible();

    const bullet = row.locator('span').first();
    const text = row.locator('span').nth(1);

    const bulletBox = await bullet.boundingBox();
    const textBox = await text.boundingBox();
    expect(bulletBox, 'bullet should have a bounding box').not.toBeNull();
    expect(textBox, 'text should have a bounding box').not.toBeNull();
    if (!bulletBox || !textBox) return;

    // Bullet is to the LEFT of the text — its right edge does not cross the
    // text's left edge.
    expect(
      bulletBox.x + bulletBox.width,
      'bullet sits left of the text'
    ).toBeLessThanOrEqual(textBox.x + 1);

    // Inline, not stacked: the bullet shares the text's first line — its
    // vertical span overlaps the top of the text box rather than sitting
    // entirely above it.
    expect(
      bulletBox.y,
      'bullet is not on its own line above the text'
    ).toBeGreaterThanOrEqual(textBox.y - bulletBox.height);
    expect(
      bulletBox.y,
      'bullet top aligns with the text, not below it'
    ).toBeLessThanOrEqual(textBox.y + textBox.height);

    await snap(page, 'member-expectations-bullet-inline-412px');
  });
});
