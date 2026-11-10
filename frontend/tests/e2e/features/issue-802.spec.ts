import { test, expect, Page } from './fixtures';
import { loginAs, jsonSessionHeaders } from '../utils/signed-auth';

// Feature (#802): a project stays `created` until its implementation plan is
// signed off, and sign-off is restricted to steward/admin roles. A project lead
// (or any member without sign-off permission) previously saw a `created` badge
// with no explanation of why the project wasn't active or who could activate it.
//
// The fix renders an explanatory hint beside the status badge, shown precisely
// when the project is `created` AND the viewer cannot sign off the plan. It
// names the roles that can activate the project (Project Steward / Operations
// Steward / Founding Member) so the viewer knows who to ask, and it never
// appears for a user who already has the "Sign Off Plan" control.
//
// Seeding goes through the backend API as the admin (an Operations Steward /
// Founding Member who CAN sign off); the project is deliberately left with an
// unsigned plan so its status stays `created`.

const API = 'http://localhost:9080/api/v1';

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

// A project with no signed-off plan — its status stays `created`.
async function seedCreatedProject(aid: string, title: string): Promise<void> {
  await api(aid, 'POST', '/projects', {
    title,
    description: 'Seeded by issue-802 feature spec.',
    created_by: aid,
  });
}

async function openProject(page: Page, projectTitle: string) {
  await page.getByRole('button', { name: /enter community/i }).click({ timeout: 15_000 }).catch(() => {});
  await page.getByRole('button', { name: 'Projects' }).click();
  const projectCard = page.locator('.project-card', { hasText: projectTitle }).first();
  await expect(projectCard).toBeVisible({ timeout: 30_000 });
  await projectCard.click();
  await expect(page).toHaveURL(/\/dashboard\/projects\//, { timeout: 15_000 });
  await expect(page.locator('.project-status-badge')).toContainText(/created/i);
}

test.describe('created-status hint explains how a project becomes active (#802)', () => {
  test('a member who cannot sign off sees the hint; the admin who can does not', async ({ adminPage, memberPage, snap }) => {
    test.setTimeout(300_000);
    const aid = await adminAid();
    await loginAs(adminPage);

    const runTag = Date.now().toString(36);
    const projectTitle = `Awaiting Sign-Off ${runTag}`;
    await seedCreatedProject(aid, projectTitle);

    // A member (no sign-off permission) gets the explanatory hint, naming the
    // roles that can activate the project.
    await openProject(memberPage, projectTitle);
    const hint = memberPage.locator('[data-testid="created-status-hint"]');
    await expect(hint).toBeVisible();
    await expect(hint).toContainText('Project Steward');
    await expect(hint).toContainText('Operations Steward');
    await expect(hint).toContainText('Founding Member');
    await snap(memberPage, 'created-status-hint-for-member');

    // The admin (who can sign off and already sees the "Sign Off Plan" control)
    // gets no redundant hint.
    await openProject(adminPage, projectTitle);
    await expect(adminPage.locator('[data-testid="created-status-hint"]')).toHaveCount(0);
    await snap(adminPage, 'no-hint-for-signer');
  });
});
