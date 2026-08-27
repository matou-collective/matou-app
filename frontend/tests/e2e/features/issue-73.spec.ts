import { test, expect, Page } from './fixtures';
import { loginAs, jsonSessionHeaders } from '../utils/signed-auth';

// Feature (#73): relax non-dialog fixed min-widths at phone widths so pages
// don't overflow horizontally. Acceptance: at 390×844 each page satisfies
// `document.documentElement.scrollWidth === window.innerWidth` (no horizontal
// scroll). Desktop layout is unchanged — the relaxations live only inside
// `@media (max-width: 767px)`.

const API = 'http://localhost:9080/api/v1';
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };

async function adminAid(): Promise<string> {
  const res = await fetch(`${API}/identity`);
  const body = await res.json();
  if (!body?.aid) throw new Error(`admin backend has no identity: ${JSON.stringify(body)}`);
  return body.aid as string;
}

async function api(aid: string, method: string, route: string, body?: unknown) {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: jsonSessionHeaders(aid),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${route} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : undefined;
}

// The overflow check for the acceptance criterion. A 1px rounding tolerance
// avoids sub-pixel flake; a leaked fixed min-width blows past by 100px+.
async function expectNoHorizontalOverflow(page: Page, label: string) {
  await page.waitForTimeout(300); // let layout settle after the resize
  const overflow = await page.evaluate(() => {
    const d = document.documentElement;
    return d.scrollWidth - window.innerWidth;
  });
  expect(overflow, `${label}: horizontal overflow of ${overflow}px at 390px`).toBeLessThanOrEqual(1);
}

test.describe('no horizontal overflow at phone width (#73)', () => {
  test('dashboard, contributions, projects, project detail and account settings fit 390px', async ({
    adminPage,
    snap,
  }) => {
    test.setTimeout(300_000);
    const aid = await adminAid();
    await loginAs(adminPage); // signed-auth session so API calls act as the admin

    // Seed a project so the Projects list and a project-detail page have real
    // content to lay out (the banner-actions + compact contribution cards are
    // among the relaxed min-width sites).
    const runTag = Date.now().toString(36);
    const projectTitle = `Overflow Check ${runTag}`;
    await api(aid, 'POST', '/projects', {
      title: projectTitle,
      description: 'Seeded by issue-73 feature spec to render the project detail layout.',
      created_by: aid,
    });

    // Start at desktop so the sidebar (hidden ≤767px) is available to navigate.
    await adminPage.setViewportSize(DESKTOP);
    const enterBtn = adminPage.getByRole('button', { name: /enter community/i });
    await enterBtn.click({ timeout: 15_000 }).catch(() => {});

    // Dashboard.
    await adminPage.getByRole('button', { name: 'Dashboard' }).click();
    await adminPage.waitForTimeout(500);
    await adminPage.setViewportSize(PHONE);
    await expectNoHorizontalOverflow(adminPage, 'dashboard');
    await snap(adminPage, 'dashboard-390');

    // Contributions.
    await adminPage.setViewportSize(DESKTOP);
    await adminPage.getByRole('button', { name: 'Contributions' }).click();
    await adminPage.waitForTimeout(500);
    await adminPage.setViewportSize(PHONE);
    await expectNoHorizontalOverflow(adminPage, 'contributions');
    await snap(adminPage, 'contributions-390');

    // Projects list.
    await adminPage.setViewportSize(DESKTOP);
    await adminPage.getByRole('button', { name: 'Projects' }).click();
    await expect(adminPage.getByText(projectTitle).first()).toBeVisible({
      timeout: 30_000,
    });
    await adminPage.setViewportSize(PHONE);
    await expectNoHorizontalOverflow(adminPage, 'projects');
    await snap(adminPage, 'projects-390');

    // Project detail (banner actions + compact contribution cards).
    await adminPage.setViewportSize(DESKTOP);
    await adminPage.getByText(projectTitle).first().click();
    await adminPage.waitForTimeout(800);
    await adminPage.setViewportSize(PHONE);
    await expectNoHorizontalOverflow(adminPage, 'project-detail');
    await snap(adminPage, 'project-detail-390');

    // Account settings (social-link label min-width).
    await adminPage.setViewportSize(DESKTOP);
    await adminPage.locator('.user-profile').click();
    await adminPage.waitForTimeout(500);
    await adminPage.setViewportSize(PHONE);
    await expectNoHorizontalOverflow(adminPage, 'account-settings');
    await snap(adminPage, 'account-settings-390');
  });
});
