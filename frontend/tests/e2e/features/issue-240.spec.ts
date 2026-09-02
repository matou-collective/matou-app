import { test, expect } from './fixtures';

// Issue #240 — colours and chrome come from the kit. For the default kit
// (slug "matou") the sidebar still shows the "Matou" wordmark and logo, and
// the brand teal is unchanged. These snaps are what the reviewer eyeballs to
// confirm the default kit looks identical after the kit rewiring.
test.describe('kit chrome — sidebar branding', () => {
  test('sidebar shows the kit logo and name', async ({ adminPage, snap }) => {
    await adminPage.goto('/');
    // A fresh navigation lands on the welcome overlay — dismiss it like every
    // other feature spec (issue-16 pattern) before asserting the sidebar.
    await adminPage
      .getByRole('button', { name: /enter community/i })
      .click({ timeout: 15_000 })
      .catch(() => {});

    const title = adminPage.locator('.sidebar-header .logo-title');
    await expect(title).toBeVisible();
    await expect(title).toHaveText('Matou');

    // Logo image sourced from the kit (src/assets/kit/logo.png).
    await expect(adminPage.locator('.sidebar-header .logo-icon')).toBeVisible();

    await snap(adminPage, 'sidebar-brand-admin');
  });

  test('member session sees the same branded sidebar', async ({ memberPage, snap }) => {
    await memberPage.goto('/');
    await memberPage
      .getByRole('button', { name: /enter community/i })
      .click({ timeout: 15_000 })
      .catch(() => {});
    await expect(memberPage.locator('.sidebar-header .logo-title')).toHaveText('Matou');
    await snap(memberPage, 'sidebar-brand-member');
  });
});
