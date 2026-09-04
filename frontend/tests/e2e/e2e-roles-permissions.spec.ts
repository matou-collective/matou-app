import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { setupTestConfig } from './utils/mock-config';
import { requireAllTestServices } from './utils/keri-testnet';
import { BackendManager } from './utils/backend-manager';
import {
  TIMEOUT,
  setupPageLogging,
  setupBackendRouting,
  loginWithMnemonic,
  loadAccounts,
  TestAccounts,
} from './utils/test-helpers';

/**
 * E2E: Admin-managed RBAC (Roles & Permissions page)
 *
 * Covers the in-app role-policy management shipped by the admin-managed-rbac
 * branch:
 *   1. Admin sees the Roles nav entry and the default policy matrix.
 *   2. Admin adds a custom role, toggles a capability, saves → policy v1.
 *   3. The Change Role modal lists the new custom role for assignment.
 *   4. Backend gate: a plain member is refused PUT /role-policy (403) and a
 *      stale-version admin write gets 409; when a registered member account
 *      exists, its dashboard shows no Roles nav entry.
 *
 * Bootstraps via org-setup only. The registration-member project (a real
 * KERI-registered member) currently fails on main in this harness — the
 * spawned member backend runs with MATOU_REQUIRE_SIGNED_AUTH and rejects
 * identity/set with 401 right after minting a session — so when no member
 * account is persisted, a member profile is seeded through the admin
 * init-member API instead (enough to drive the Change Role modal).
 *
 * Screenshots land in tests/e2e/results/snaps/roles-permissions/ and are
 * attached to the Playwright report.
 *
 * Run: npx playwright test --project=roles-permissions
 */

const API = 'http://localhost:9080/api/v1';
const SNAP_DIR = path.join(__dirname, 'results', 'snaps', 'roles-permissions');
const CUSTOM_ROLE_NAME = 'Kaitiaki';
const CUSTOM_ROLE_ID = 'kaitiaki';
const SEEDED_MEMBER_AID = 'ESeededMemberForRolePolicyE2E00000000000000';
const SEEDED_MEMBER_NAME = 'Seeded Member';

let snapCount = 0;
async function snap(page: Page, label: string): Promise<void> {
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  snapCount++;
  const name = `${String(snapCount).padStart(2, '0')}-${label.replace(/[^a-z0-9-]/gi, '_')}.png`;
  const file = path.join(SNAP_DIR, name);
  await page.screenshot({ path: file, fullPage: true });
  await test.info().attach(name, { path: file, contentType: 'image/png' });
}

// A full reload goes through session restore (KERIA reconnect) and lands on
// the "Enter Community" welcome screen; click through to the dashboard.
async function reloadIntoDashboard(page: Page): Promise<void> {
  await page.reload();
  const enter = page.getByRole('button', { name: /enter community/i });
  await expect(enter).toBeVisible({ timeout: TIMEOUT.aidCreation });
  await enter.click();
  await expect(page.locator('.nav-item', { hasText: 'Home' })).toBeVisible({ timeout: TIMEOUT.aidCreation });
}

async function apiJson(aid: string, method: string, route: string, body?: unknown) {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-User-AID': aid },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test.describe.serial('Roles & Permissions (admin-managed RBAC)', () => {
  let accounts: TestAccounts;
  let adminAid: string;
  let adminPage: Page;
  const backends = new BackendManager();

  test.beforeAll(async ({ browser }) => {
    await requireAllTestServices();
    accounts = loadAccounts();
    if (!accounts.admin?.mnemonic) {
      throw new Error('No admin in test-accounts.json — run --project=roles-permissions so org-setup bootstraps first.');
    }
    // org-setup persists the admin mnemonic but not the AID; the backend's
    // /health reports the org admin AID.
    const health = await (await fetch('http://localhost:9080/health')).json();
    adminAid = accounts.admin.aid || (health.admin as string);
    if (!adminAid) throw new Error('could not determine admin AID from test-accounts.json or /health');
    const ctx = await browser.newContext();
    await setupTestConfig(ctx);
    adminPage = await ctx.newPage();
    setupPageLogging(adminPage, 'Admin');
    await loginWithMnemonic(adminPage, accounts.admin.mnemonic);
  });

  test.afterAll(async () => {
    await backends.stopAll();
    await adminPage?.context().close();
  });

  test('admin sees the Roles nav entry and the default policy matrix', async () => {
    test.setTimeout(TIMEOUT.long);

    const rolesNav = adminPage.locator('.nav-item', { hasText: 'Roles' });
    await expect(rolesNav).toBeVisible({ timeout: TIMEOUT.medium });
    await snap(adminPage, 'admin-dashboard-with-roles-nav');

    await rolesNav.click();
    await expect(adminPage.getByRole('heading', { name: 'Roles & Permissions' })).toBeVisible();
    await expect(adminPage.getByText(/built-in default policy/i)).toBeVisible();

    // The Projects & Contributions (#314, 11 capabilities), Proposals (#315, 2)
    // and Chat (#316, 3) feature tables have peeled their columns out of the
    // generic community/project matrices, so those two carry the Role column +
    // the remaining 6 capabilities (22 total − 11 − 2 − 3). A per-feature table
    // owns each group as its slice lands; the generic tables shrink accordingly.
    const community = adminPage.locator('.roles-matrix.community-roles');
    const project = adminPage.locator('.roles-matrix.project-roles');
    const projects = adminPage.locator('.roles-matrix.projects-roles');
    await expect(adminPage.getByRole('heading', { name: 'Community roles' })).toBeVisible();
    await expect(adminPage.getByRole('heading', { name: 'Project roles' })).toBeVisible();
    await expect(
      adminPage.getByRole('heading', { name: 'Projects & Contributions' }),
    ).toBeVisible();

    // Community table: member, operations/community steward, founding member (4).
    await expect(community.locator('tbody tr')).toHaveCount(4);
    await expect(community.locator('thead th')).toHaveCount(7);
    await expect(community.getByText('Founding Member')).toBeVisible();
    await expect(community.getByText('Manage roles')).toBeVisible();
    // Chat capabilities are no longer columns here — they live in the Chat table.
    await expect(community.getByText('Send messages')).toHaveCount(0);
    await snap(adminPage, 'community-roles-default-policy');

    // Project table: contributor, project_lead, project_steward (3). The
    // contributor row lives here only (issue #165 ruling), not in community.
    await expect(project.locator('tbody tr')).toHaveCount(3);
    await expect(project.locator('thead th')).toHaveCount(7);
    await expect(project.getByText('Contributor')).toBeVisible();
    await expect(community.getByText('Contributor')).toHaveCount(0);
    await snap(adminPage, 'project-roles-default-policy-with-contributor');

    // Projects & Contributions table: 11 project columns + Role, rows for both
    // scopes (it is the only table with project-scoped rows).
    await expect(projects.locator('thead th')).toHaveCount(12);
    await expect(projects.locator('tbody tr', { hasText: 'Contributor' })).toBeVisible();
    await expect(projects.locator('tbody tr', { hasText: 'Founding Member' })).toBeVisible();
    await snap(adminPage, 'projects-contributions-table-default-policy');

    // A community-only capability toggle (Manage roles) is disabled on a
    // project role — defense-in-depth for the 400 the backend returns.
    const projSteward = project.locator('tbody tr', { hasText: 'Project Steward' });
    const projHeaders = await project.locator('thead th').allTextContents();
    const manageRolesCol = projHeaders.findIndex((h) => h.trim().startsWith('Manage roles'));
    expect(manageRolesCol).toBeGreaterThan(0);
    await expect(
      projSteward.locator('td').nth(manageRolesCol).locator('.q-toggle'),
    ).toHaveAttribute('aria-disabled', 'true');
    await snap(adminPage, 'project-role-community-only-toggle-disabled');

    // Backend agrees: GET reports the default policy and the admin's caps.
    const { status, body } = await apiJson(adminAid, 'GET', '/role-policy');
    expect(status).toBe(200);
    expect(body.source).toBe('default');
    expect(body.policy.version).toBe(0);
    expect(body.callerCapabilities).toContain('manage_roles');
  });

  test('admin adds a custom role, grants it a capability, and saves', async () => {
    test.setTimeout(TIMEOUT.long);

    await adminPage.locator('.community-section').getByRole('button', { name: 'New role' }).click();
    const dialog = adminPage.getByRole('dialog');
    await expect(dialog.getByText('New community role')).toBeVisible();
    await dialog.getByLabel('Role name').fill(CUSTOM_ROLE_NAME);
    // Copy permissions from Community Steward so the role starts non-empty.
    await dialog.getByLabel('Copy permissions from (optional)').click();
    await adminPage.getByRole('option', { name: 'Community Steward' }).click();
    await snap(adminPage, 'new-community-role-dialog');
    await dialog.getByRole('button', { name: 'Add role' }).click();

    const matrix = adminPage.locator('.roles-matrix.community-roles');
    const customRow = matrix.locator('tbody tr', { hasText: CUSTOM_ROLE_NAME });
    await expect(customRow).toBeVisible();
    await expect(customRow.getByText('custom')).toBeVisible();

    // Grant the custom role "Reward" — a Projects & Contributions capability, so
    // it is now toggled in that feature table (#314). The community-scoped custom
    // role appears there as a community row, where Reward is enabled.
    const projects = adminPage.locator('.roles-matrix.projects-roles');
    const projCustomRow = projects.locator('tbody tr', { hasText: CUSTOM_ROLE_NAME });
    await expect(projCustomRow).toBeVisible();
    const headers = await projects.locator('thead th').allTextContents();
    const rewardCol = headers.findIndex((h) => h.trim().startsWith('Reward'));
    expect(rewardCol).toBeGreaterThan(0);
    const rewardToggle = projCustomRow.locator('td').nth(rewardCol).locator('.q-toggle');
    await expect(rewardToggle).toHaveAttribute('aria-checked', 'false');
    await rewardToggle.click();
    await expect(rewardToggle).toHaveAttribute('aria-checked', 'true');
    await snap(adminPage, 'custom-role-added-reward-granted-unsaved');

    await adminPage.getByRole('button', { name: 'Save changes' }).click();
    await expect(adminPage.getByText('Role policy saved')).toBeVisible({ timeout: TIMEOUT.medium });
    await expect(adminPage.getByText(/built-in default policy/i)).toHaveCount(0);
    await expect(adminPage.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    await snap(adminPage, 'policy-saved-v1');

    // Persisted: version bumped, custom role present with the extra grant.
    const { status, body } = await apiJson(adminAid, 'GET', '/role-policy');
    expect(status).toBe(200);
    expect(body.source).toBe('synced');
    expect(body.policy.version).toBe(1);
    const custom = body.policy.roles.find((r: { id: string }) => r.id === CUSTOM_ROLE_ID);
    expect(custom).toMatchObject({ displayName: CUSTOM_ROLE_NAME, builtin: false });
    expect(body.policy.grants[CUSTOM_ROLE_ID]).toEqual(
      expect.arrayContaining(['contribute', 'manage_governance', 'reward']),
    );
  });

  test('the project table offers its own New-role dialog', async () => {
    test.setTimeout(TIMEOUT.long);
    // Open the project section's New role dialog and snap it (cancel without
    // saving — the persisted policy is asserted by the reload test next).
    await adminPage.locator('.project-section').getByRole('button', { name: 'New role' }).click();
    const dialog = adminPage.getByRole('dialog');
    await expect(dialog.getByText('New project role')).toBeVisible();
    await dialog.getByLabel('Role name').fill('Kaimahi');
    await snap(adminPage, 'new-project-role-dialog');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });

  test('survives reload and the Change Role modal offers the custom role', async () => {
    test.setTimeout(TIMEOUT.orgSetup);

    // Re-enter the Roles page after a reload so the store re-fetches the
    // persisted policy from the backend.
    await reloadIntoDashboard(adminPage);
    const rolesNav = adminPage.locator('.nav-item', { hasText: 'Roles' });
    await expect(rolesNav).toBeVisible({ timeout: TIMEOUT.aidCreation });
    await rolesNav.click();
    await expect(adminPage.getByRole('heading', { name: 'Roles & Permissions' })).toBeVisible({
      timeout: TIMEOUT.medium,
    });
    await expect(adminPage.locator('.roles-matrix tbody tr', { hasText: CUSTOM_ROLE_NAME })).toBeVisible();
    await snap(adminPage, 'roles-page-after-reload');

    // Change Role modal: open a member's profile from the dashboard. Use the
    // registered member when one exists, otherwise seed one via init-member.
    let memberName = accounts.member?.name;
    if (!memberName) {
      const seeded = await apiJson(adminAid, 'POST', '/profiles/init-member', {
        memberAid: SEEDED_MEMBER_AID,
        credentialSaid: 'ESeededCredentialSaidForRolePolicyE2E0000000',
        role: 'Member',
        status: 'approved',
        displayName: SEEDED_MEMBER_NAME,
      });
      expect(seeded.status, `init-member: ${JSON.stringify(seeded.body)}`).toBe(200);
      memberName = SEEDED_MEMBER_NAME;
    }
    // Reload so the dashboard's member list picks up the (possibly just
    // seeded) profile from the backend.
    await reloadIntoDashboard(adminPage);
    const memberCard = adminPage.locator('.members-list').getByText(memberName, { exact: false }).first();
    await expect(memberCard).toBeVisible({ timeout: TIMEOUT.medium });
    await memberCard.click();

    // Role badge inside the profile modal is clickable for admins.
    const roleBadge = adminPage.locator('span.rounded-full.cursor-pointer').first();
    await expect(roleBadge).toBeVisible({ timeout: TIMEOUT.medium });
    await roleBadge.click();

    await expect(adminPage.getByText(/select a new role for/i)).toBeVisible();
    await expect(adminPage.locator('label', { hasText: CUSTOM_ROLE_ID })).toBeVisible();
    await expect(adminPage.locator('label', { hasText: 'Founding Member' })).toBeVisible();
    await snap(adminPage, 'change-role-modal-lists-custom-role');
    await adminPage.keyboard.press('Escape');
  });

  test('plain member is refused policy writes and sees no Roles nav', async ({ browser }) => {
    test.setTimeout(TIMEOUT.orgSetup);

    // API gate, independent of UI: a non-privileged AID cannot PUT.
    const memberAid = accounts.member?.aid || 'EnonPrivilegedMemberForRolePolicyTest00000000';
    const current = await apiJson(adminAid, 'GET', '/role-policy');
    const denied = await apiJson(memberAid, 'PUT', '/role-policy', {
      version: current.body.policy.version,
      roles: current.body.policy.roles,
      grants: current.body.policy.grants,
    });
    expect(denied.status).toBe(403);
    // Stale-version writes from the admin are rejected too (optimistic lock).
    const stale = await apiJson(adminAid, 'PUT', '/role-policy', {
      version: 0,
      roles: current.body.policy.roles,
      grants: current.body.policy.grants,
    });
    expect(stale.status).toBe(409);

    if (!accounts.member?.mnemonic) {
      test.info().annotations.push({
        type: 'skipped-step',
        description: 'no registered member account (registration-member is red on main here) — member UI check skipped',
      });
      return;
    }
    const memberBackend = await backends.start('rbac-member');
    const ctx = await browser.newContext();
    await setupTestConfig(ctx);
    await setupBackendRouting(ctx, memberBackend.port);
    const memberPage = await ctx.newPage();
    setupPageLogging(memberPage, 'Member');
    await loginWithMnemonic(memberPage, accounts.member.mnemonic);

    await expect(memberPage.locator('.nav-item', { hasText: 'Home' })).toBeVisible({ timeout: TIMEOUT.medium });
    await expect(memberPage.locator('.nav-item', { hasText: 'Roles' })).toHaveCount(0);
    await snap(memberPage, 'member-dashboard-no-roles-nav');
    await ctx.close();
  });
});
