import { test, expect } from './fixtures';

// #369 — in the onboarding profile step the participation-interest checkboxes
// were rendered ~20px below their single-line labels because the checkbox
// carried a fixed two-line top margin (mt-5). Kit-driven interest options have
// no description, so every row is single-line; the fix centres the checkbox
// against its label (items-center, no mt-5). This walks the register flow to
// the profile form and captures the aligned interest rows.
test.describe('issue-369 interest checkboxes align with their labels', () => {
  test('profile-form interest checkboxes sit centred on their labels', async ({ freshPage, snap }) => {
    const page = freshPage;
    await page.goto('/');

    // Splash → register
    await expect(page.getByRole('button', { name: /join now/i })).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole('button', { name: /join now/i }).click();

    // Kit welcome → walk the info pages to the form.
    await expect(page.getByRole('heading', { name: /join mātou/i })).toBeVisible({
      timeout: 10_000,
    });
    await page.getByRole('button', { name: /^continue$/i }).click();
    await page.getByRole('button', { name: /^continue$/i }).click(); // About Matou
    await page.getByRole('button', { name: /^continue$/i }).click(); // Community Goals
    await page.getByRole('button', { name: /continue to registration/i }).click(); // Member Expectations

    // Profile form
    await expect(page.getByRole('heading', { name: /create your profile/i })).toBeVisible({
      timeout: 10_000,
    });

    // The participation-interest section renders its kit-driven options.
    const interestLabel = page.getByText('Research and Knowledge', { exact: true });
    await expect(interestLabel).toBeVisible();
    await interestLabel.scrollIntoViewIfNeeded();

    // The checkbox must be vertically centred against its single-line label:
    // its centre should sit within the label text's vertical span, not below.
    const row = interestLabel.locator('xpath=ancestor::label[1]');
    const checkbox = row.getByRole('checkbox');
    const boxBox = await checkbox.boundingBox();
    const textBox = await interestLabel.boundingBox();
    expect(boxBox).not.toBeNull();
    expect(textBox).not.toBeNull();
    const boxCentre = boxBox!.y + boxBox!.height / 2;
    // Centre falls within the label's own vertical extent (with a small margin).
    expect(boxCentre).toBeGreaterThanOrEqual(textBox!.y - 4);
    expect(boxCentre).toBeLessThanOrEqual(textBox!.y + textBox!.height + 4);

    await snap(page, 'interest-checkboxes-aligned');
  });
});
