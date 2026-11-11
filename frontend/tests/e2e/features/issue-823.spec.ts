import { test, expect, Page } from './fixtures';
import { loginAs, jsonSessionHeaders } from '../utils/signed-auth';

// Bug (#823): the "Not yet in a milestone" holding area (#777) flickered on
// hover and its tinted background looked mis-layered behind the contribution
// cards. The compact cards carry a translucent status wash; composited over the
// section's tinted background inside the scrolling plan, Chromium left
// partial-repaint ghosts that shimmered as a card's hover box-shadow
// transitioned. The fix isolates the holding area onto its own compositing
// layer so the tint sits stably behind the cards and repaints cleanly on hover.
//
// This spec seeds a plan with several unassigned contributions (so the holding
// area has real content), then hovers a card and snapshots the before/after so
// a reviewer can confirm the background stays put and does not flicker.

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

async function seedPlan(aid: string, projectTitle: string, taskTitles: string[]): Promise<void> {
  const proj = await api(aid, 'POST', '/projects', {
    title: projectTitle,
    description: 'Seeded by issue-823 feature spec.',
    created_by: aid,
  });
  await api(aid, 'POST', '/implementation-plans', {
    project_id: proj.id,
    total_budget: '100',
    project_lead: aid,
    project_steward_id: aid,
  });

  // Several contributions with NO milestone — they land in the holding area.
  for (const title of taskTitles) {
    await api(aid, 'POST', '/contributions', {
      project_id: proj.id,
      title,
      description: 'Not placed in a milestone yet.',
      contribution_type: 'task',
      priority: 'medium',
      created_by: aid,
      objectives: ['wait to be placed'],
      deliverables: ['a deliverable'],
      acceptance_criteria: ['shows in the holding area'],
    });
  }
}

async function openProject(page: Page, projectTitle: string) {
  await page.getByRole('button', { name: /enter community/i }).click({ timeout: 15_000 }).catch(() => {});
  await page.getByRole('button', { name: 'Projects' }).click();
  const projectCard = page.locator('.project-card', { hasText: projectTitle }).first();
  await expect(projectCard).toBeVisible({ timeout: 30_000 });
  await projectCard.click();
  await expect(page).toHaveURL(/\/dashboard\/projects\//, { timeout: 15_000 });
}

test.describe('holding-area background is stable on hover (#823)', () => {
  test('hovering a holding-area card keeps the tinted background behind it, no flicker', async ({ adminPage, snap }) => {
    test.setTimeout(300_000);
    const aid = await adminAid();
    await loginAs(adminPage);

    const runTag = Date.now().toString(36);
    const projectTitle = `Flicker Holding Area ${runTag}`;
    const taskTitles = [
      `First unplaced task ${runTag}`,
      `Second unplaced task ${runTag}`,
      `Third unplaced task ${runTag}`,
    ];
    await seedPlan(aid, projectTitle, taskTitles);

    await openProject(adminPage, projectTitle);

    const holding = adminPage.locator('.unassigned-section');
    await expect(holding).toBeVisible({ timeout: 30_000 });
    await expect(holding.locator('.unassigned-title')).toHaveText(/not yet in a milestone/i);

    const cards = holding.locator('.contribution-compact');
    await expect(cards.first()).toBeVisible();
    await expect(cards).toHaveCount(taskTitles.length);

    // Resting state: tint sits behind the cards.
    await snap(adminPage, 'holding-area-rest');

    // Hover a card — the background must stay put and not flicker.
    await cards.nth(1).hover();
    await expect(cards.nth(1)).toBeVisible();
    await snap(adminPage, 'holding-area-hovered');

    // Move off to confirm the resting state returns cleanly.
    await holding.locator('.unassigned-title').hover();
    await snap(adminPage, 'holding-area-after-hover');
  });
});
