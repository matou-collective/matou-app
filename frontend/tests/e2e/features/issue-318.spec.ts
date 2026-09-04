import { test, expect, Page } from './fixtures';

// Feature (#318): Community Settings area.
//   - A sidebar "Community Settings" gear appears only for holders of
//     open_community_settings (founder by default), directly above "Report an
//     issue"; it opens a page hosting the Community permission table + org
//     details.
//   - Page access is enforced server-side: GET /community-settings/access 403s
//     for a caller lacking open_community_settings, so the page can't be reached
//     by URL alone.
//   - save_org_config now requires manage_community_settings (founder-only), not
//     manage_members — POST /org/config 403s for a plain member. The precise
//     "manage_members holder (operations steward) still 403s" case is proven by
//     the backend Go tests (TestOrgConfig_RequiresAdminScopeOnceConfigured,
//     TestSaveOrgConfigRequiresManageCommunitySettings) — a real ops-steward
//     credential can't be minted in the feature e2e harness.

const API = 'http://localhost:9080/api/v1';

// Any non-empty AID that is not the org admin resolves to the baseline
// `member` role, so it lacks open_community_settings / manage_community_settings.
const MEMBER_AID = 'EplainMemberForIssue318Test000000000000000';

async function adminAid(): Promise<string> {
  const res = await fetch(`${API}/identity`);
  const body = await res.json();
  if (!body?.aid) throw new Error(`admin backend has no identity: ${JSON.stringify(body)}`);
  return body.aid as string;
}

async function status(aid: string, method: string, route: string, body?: unknown): Promise<number> {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-User-AID': aid },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.status;
}

// Log in leaves the app on the "Enter Community" welcome screen or already on
// the dashboard; get onto the dashboard either way.
async function enterDashboard(page: Page): Promise<void> {
  const enter = page.getByRole('button', { name: /enter community/i });
  if (await enter.isVisible().catch(() => false)) {
    await enter.click();
  }
  await expect(page.locator('.sidebar-nav')).toBeVisible({ timeout: 30_000 });
}

test.describe('Community Settings area (#318)', () => {
  test('founder sees the gear and opens the Community Settings page', async ({ adminPage, snap }) => {
    test.setTimeout(120_000);
    await enterDashboard(adminPage);

    const gear = adminPage.locator('.community-settings-btn');
    await expect(gear).toBeVisible({ timeout: 30_000 });
    await snap(adminPage, 'founder-sidebar-gear');

    await gear.click();
    await expect(adminPage.getByRole('heading', { name: 'Community Settings' })).toBeVisible();

    // The Community permission table: one row per community role, the four
    // Community-group capability columns incl. "Manage roles".
    const table = adminPage.locator('.community-permissions-table');
    await expect(table).toBeVisible();
    const headers = await table.locator('thead th').allTextContents();
    for (const col of ['Open settings', 'Manage settings', 'Manage members', 'Manage roles']) {
      expect(headers.some((h) => h.trim().startsWith(col)), `column ${col}`).toBe(true);
    }
    await expect(table.locator('tbody tr', { hasText: 'Founding Member' })).toBeVisible();
    await snap(adminPage, 'community-settings-page');

    // Org details section is present and editable for the founder.
    await expect(adminPage.getByRole('heading', { name: 'Org details' })).toBeVisible();
    await expect(adminPage.getByLabel('Community name')).toBeVisible();
    await snap(adminPage, 'org-details-section');
  });

  test('a plain member does not see the Community Settings gear', async ({ memberPage, snap }) => {
    test.setTimeout(120_000);
    // The member may land on the dashboard or an onboarding step; either way the
    // gear must be absent.
    await memberPage.waitForTimeout(2_000);
    await expect(memberPage.locator('.community-settings-btn')).toHaveCount(0);
    await snap(memberPage, 'member-no-gear');
  });

  test('page-access and org-config are enforced server-side by capability', async ({ adminPage }) => {
    // adminPage is only here to guarantee the admin backend is up.
    await enterDashboard(adminPage);
    const admin = await adminAid();

    // Page-access gate: founder 200, plain member 403.
    expect(await status(admin, 'GET', '/community-settings/access')).toBe(200);
    expect(await status(MEMBER_AID, 'GET', '/community-settings/access')).toBe(403);

    // save_org_config: a plain member is refused (manage_community_settings
    // required). The founder is accepted.
    const current = await fetch(`${API}/org/config`).then((r) => r.json());
    expect(await status(MEMBER_AID, 'POST', '/org/config', current)).toBe(403);
    expect(await status(admin, 'POST', '/org/config', current)).toBe(200);
  });
});
