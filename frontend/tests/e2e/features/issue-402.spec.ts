import { test, expect, Page } from './fixtures';

// Feature (#402): render custom (admin-added) schema fields in the profile
// surfaces via TypedForm/TypedDisplay. A field the SharedProfile type
// definition declares beyond the built-in set is rendered in the Account
// Settings edit form ("Additional Information"), persists on save, shows back
// after a reload, and is displayed in the member's profile modal.
//
// Seeding goes through the real schema write path from #399/#405:
// `PUT /api/v1/types/SharedProfile` (RBAC manage_schema → the admin/founder's
// X-User-AID; optimistic `version` lock; core fields re-asserted; layouts
// validated against the field set). The custom field is appended to the
// definition AND to the form/detail layouts — #405 400s a layout naming an
// unknown field, and the layouts are what order the rendered fields.
//
// Seeding happens in beforeAll, before the adminPage fixture logs in: the
// dashboard layout loads /api/v1/types on mount and the types store caches
// it, so a definition written after login would not be seen by the page.
// afterAll restores the original definition so later specs are unaffected.

const API = 'http://localhost:9080/api/v1';
// Mutating requests need the dev/test API token; identity is the self-asserted
// X-User-AID of the admin backend (founder → holds manage_schema).
const AUTH = { 'Content-Type': 'application/json', Authorization: 'Bearer matou-dev' };
const SETTINGS_URL = '/#/dashboard/settings';
const DASHBOARD_URL = '/#/dashboard';
const CUSTOM_FIELD = 'iwi';
const CUSTOM_LABEL = 'Iwi';
const CUSTOM_VALUE = 'Ngāti Test';

interface FieldDef {
  name: string;
  type: string;
  core?: boolean;
  uiHints?: Record<string, unknown>;
  [k: string]: unknown;
}
interface TypeDef {
  name: string;
  version: number;
  fields: FieldDef[];
  layouts?: Record<string, { fields: string[] }>;
  [k: string]: unknown;
}

async function adminAid(): Promise<string> {
  const res = await fetch(`${API}/identity`);
  const body = await res.json();
  if (!body?.aid) throw new Error(`admin backend has no identity: ${JSON.stringify(body)}`);
  return body.aid as string;
}

async function getSharedProfileDef(): Promise<TypeDef> {
  const res = await fetch(`${API}/types/SharedProfile`);
  if (!res.ok) throw new Error(`GET /types/SharedProfile: ${res.status} ${await res.text()}`);
  const def = (await res.json()) as TypeDef;
  if (!Array.isArray(def?.fields)) throw new Error('no SharedProfile definition to extend');
  return def;
}

// PUT the definition back with the version it was read at (the write path's
// optimistic lock); the response carries the bumped version.
async function putSharedProfileDef(aid: string, def: TypeDef): Promise<TypeDef> {
  const res = await fetch(`${API}/types/SharedProfile`, {
    method: 'PUT',
    headers: { ...AUTH, 'X-User-AID': aid },
    body: JSON.stringify(def),
  });
  if (!res.ok) {
    throw new Error(`PUT /types/SharedProfile failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as TypeDef;
}

function addToLayout(def: TypeDef, layout: string, name: string): void {
  const l = def.layouts?.[layout];
  if (l && !l.fields.includes(name)) l.fields.push(name);
}

// Extend the served SharedProfile definition with a non-core custom field.
// Idempotent: a retry (fresh worker) finds the field already present and
// leaves the definition alone.
async function seedCustomProfileField(aid: string): Promise<void> {
  const def = await getSharedProfileDef();
  if (def.fields.some((f) => f.name === CUSTOM_FIELD)) return;

  def.fields.push({
    name: CUSTOM_FIELD,
    type: 'string',
    uiHints: { inputType: 'text', label: CUSTOM_LABEL, section: 'profile', filterable: true },
  });
  addToLayout(def, 'form', CUSTOM_FIELD);
  addToLayout(def, 'detail', CUSTOM_FIELD);

  const updated = await putSharedProfileDef(aid, def);
  if (!updated.fields.some((f) => f.name === CUSTOM_FIELD)) {
    throw new Error('PUT accepted but the custom field is missing from the returned definition');
  }
  // Belt and braces: the served definition is what the frontend will render.
  const served = await getSharedProfileDef();
  if (!served.fields.some((f) => f.name === CUSTOM_FIELD)) {
    throw new Error('GET /types/SharedProfile does not serve the seeded custom field');
  }
}

// Restore the definition's field set and layouts (the version keeps bumping;
// only the shape matters to later specs).
async function restoreProfileDef(aid: string, original: TypeDef): Promise<void> {
  const current = await getSharedProfileDef();
  current.fields = original.fields;
  current.layouts = original.layouts;
  await putSharedProfileDef(aid, current);
}

// The admin's own display name, so its member card can be found on the dashboard.
async function adminDisplayName(aid: string): Promise<string> {
  const res = await fetch(`${API}/profiles/SharedProfile`);
  const body = await res.json();
  const mine = (body?.profiles ?? []).find(
    (p: { data?: Record<string, unknown> }) => p.data?.aid === aid,
  );
  const name = mine?.data?.displayName as string | undefined;
  if (!name) throw new Error(`admin ${aid} has no SharedProfile displayName`);
  return name;
}

// loginWithMnemonic parks the app on the "Enter Community" welcome screen (or,
// on a warm session, straight on the dashboard). The router is in hash mode,
// so click through the gate if it is showing, then use the hash route.
async function passWelcomeGate(page: Page): Promise<void> {
  const enter = page.getByRole('button', { name: /enter community/i });
  // Right after a reload the app is still booting: the gate is not rendered
  // yet, an instant isVisible() says false, and the following goto() gets
  // bounced back to the gate once boot completes (pr-e2e capture on #403).
  // Wait for either the gate or the dashboard shell before deciding.
  await Promise.race([
    enter.waitFor({ state: 'visible', timeout: 20_000 }),
    page.locator('.sidebar-header').waitFor({ state: 'visible', timeout: 20_000 }),
  ]).catch(() => {});
  if (await enter.isVisible().catch(() => false)) {
    await enter.click();
    await expect(enter).toBeHidden({ timeout: 30_000 });
  }
}

async function openAccountSettings(page: Page): Promise<void> {
  await passWelcomeGate(page);
  await page.goto(SETTINGS_URL);
  await expect(page.getByText('Additional Information')).toBeVisible({ timeout: 30_000 });
}

test.describe('custom schema fields in profile surfaces (#402)', () => {
  let aid = '';
  let original: TypeDef | null = null;

  test.beforeAll(async () => {
    aid = await adminAid();
    const def = await getSharedProfileDef();
    original = structuredClone(def);
    await seedCustomProfileField(aid);
  });

  test.afterAll(async () => {
    if (original) await restoreProfileDef(aid, original);
  });

  test('a seeded custom profile field renders, persists, and displays', async ({
    adminPage,
    snap,
  }) => {
    test.setTimeout(120_000);

    // 1. The custom field renders in the edit form's Additional Information card.
    await openAccountSettings(adminPage);
    const section = adminPage.locator('[data-test="custom-fields-section"]');
    await expect(section).toBeVisible();
    const input = section.locator(`#${CUSTOM_FIELD}`);
    await expect(input).toBeVisible();
    await expect(section.getByText(CUSTOM_LABEL)).toBeVisible();
    await snap(adminPage, 'custom-field-in-edit-form');

    // 2. Fill and save (the unsaved-changes bar's Save button).
    await input.fill(CUSTOM_VALUE);
    const save = adminPage.locator('.btn-save');
    await expect(save).toBeVisible();
    await save.click();
    await expect(adminPage.getByText('Saved', { exact: true })).toBeVisible({ timeout: 30_000 });
    await snap(adminPage, 'custom-field-saved');

    // 3. Reload — the value persisted and shows back in the form.
    await adminPage.reload();
    await openAccountSettings(adminPage);
    await expect(section.locator(`#${CUSTOM_FIELD}`)).toHaveValue(CUSTOM_VALUE);
    await snap(adminPage, 'custom-field-persisted');

    // 4. The member's profile modal displays the custom field via TypedDisplay.
    const name = await adminDisplayName(aid);
    await adminPage.goto(DASHBOARD_URL);
    await expect(adminPage.locator('.members-card')).toBeVisible({ timeout: 30_000 });
    const card = adminPage
      .locator('.members-card .profile-card')
      .filter({ hasText: name })
      .first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.click();
    const modal = adminPage.locator('.modal-content');
    await expect(modal).toBeVisible({ timeout: 15_000 });
    const custom = modal.locator('[data-test="custom-profile-fields"]');
    await expect(custom).toBeVisible({ timeout: 15_000 });
    await expect(custom.getByText(CUSTOM_LABEL)).toBeVisible();
    await expect(custom.getByText(CUSTOM_VALUE)).toBeVisible();
    await snap(adminPage, 'custom-field-in-profile-modal');
  });
});
