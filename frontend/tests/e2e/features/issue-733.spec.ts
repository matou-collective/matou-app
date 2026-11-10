import { test, expect } from './fixtures';

// Feature (#733): the milestone card formats Budget/Actual amounts as New
// Zealand dollars (NZD). Previously the Intl.NumberFormat used 'USD', so a
// milestone budget of 7,845 rendered as a USD-formatted amount — wrong for the
// Mātou community, whose projects budget in NZD.
//
// Seeding: drive the backend API directly (as the admin) to create a project
// with an implementation plan and one milestone carrying a budget_allocation,
// then view the project detail and assert the milestone budget pill shows NZD.

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
    headers: { 'Content-Type': 'application/json', 'X-User-AID': aid },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${route} → ${res.status}: ${text}`);
  return text ? JSON.parse(text) : undefined;
}

const BUDGET = 7845;

async function seedProjectWithBudgetedMilestone(
  aid: string,
  projectTitle: string,
): Promise<void> {
  const proj = await api(aid, 'POST', '/projects', {
    title: projectTitle,
    description: 'Seeded by issue-733 feature spec.',
    created_by: aid,
  });
  const plan = await api(aid, 'POST', '/implementation-plans', {
    project_id: proj.id,
    total_budget: '7845',
    project_lead: aid,
    project_steward_id: aid,
  });
  await api(aid, 'POST', `/implementation-plans/${plan.id}/milestones`, {
    title: 'Weaving the panels',
    duration: '2 weeks',
    budget_allocation: BUDGET,
  });
}

test.describe('milestone budget renders as NZD, not USD (#733)', () => {
  test('milestone budget pill shows a New Zealand dollar amount', async ({ adminPage, snap }) => {
    test.setTimeout(300_000);
    const aid = await adminAid();

    const runTag = Date.now().toString(36);
    const projectTitle = `Harakeke Project ${runTag}`;
    await seedProjectWithBudgetedMilestone(aid, projectTitle);

    // Past the welcome splash (if showing) and into Projects.
    const enterBtn = adminPage.getByRole('button', { name: /enter community/i });
    await enterBtn.click({ timeout: 15_000 }).catch(() => {});
    await adminPage.getByRole('button', { name: 'Projects' }).click();

    // Open the seeded project — its implementation plan renders the milestone card.
    const projectCard = adminPage.locator('.project-card', { hasText: projectTitle }).first();
    await expect(projectCard).toBeVisible({ timeout: 30_000 });
    await projectCard.click();

    const budgetPill = adminPage.locator('.budget-pill', { hasText: 'Budget:' }).first();
    await expect(budgetPill).toBeVisible({ timeout: 30_000 });

    // The amount is formatted as NZD. Compute the expected NZD and USD strings
    // in the page's own Intl engine (matching what the component produces): the
    // two differ (NZD disambiguates its dollar sign, e.g. "NZ$7,845"), so the
    // NZD rendering appearing in the pill — distinct from the old USD one —
    // proves the currency is now NZD.
    const { nzd, usd } = await adminPage.evaluate((n) => {
      const fmt = (currency: string) =>
        new Intl.NumberFormat(undefined, {
          style: 'currency',
          currency,
          maximumFractionDigits: 0,
        }).format(n);
      return { nzd: fmt('NZD'), usd: fmt('USD') };
    }, BUDGET);
    expect(nzd).not.toBe(usd); // guard: the engine distinguishes the two currencies

    await expect(budgetPill).toContainText(nzd);
    await snap(adminPage, 'milestone-budget-nzd');
  });
});
