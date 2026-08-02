import { test, expect } from './fixtures';

test.describe('features harness smoke', () => {
  test('admin and member fixtures produce logged-in sessions', async ({
    adminPage,
    memberPage,
    snap,
  }) => {
    await adminPage.goto('/');
    await expect(adminPage.locator('body')).toBeVisible();
    await snap(adminPage, 'admin-home');

    await memberPage.goto('/');
    await expect(memberPage.locator('body')).toBeVisible();
    await snap(memberPage, 'member-home');
  });
});
