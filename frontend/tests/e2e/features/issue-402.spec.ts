import { test, expect, Page } from './fixtures';

// Feature (#402): render custom (admin-added) schema fields in the profile
// surfaces via TypedForm/TypedDisplay. A field the SharedProfile type
// definition declares beyond the built-in set is rendered in the Account
// Settings edit form ("Additional Information"), persists on save, and shows
// back on reload.
//
// Seeding: this spec writes an extended SharedProfile `type_definition` (the
// bootstrap fields plus a custom `iwi` string field) into the community space
// via the admin API, then relies on GET /api/v1/types serving that custom
// field so the frontend can render it.
//
// NB: as of this slice the backend type registry is bootstrap-only
// (types.Registry.LoadFromSpace is not yet wired and there is no runtime
// schema-write endpoint), so a seeded custom field is not yet served by
// /api/v1/types. This spec encodes the intended end-to-end behaviour and
// becomes green once a #396 backend slice serves persisted custom fields. See
// the PR body for the blocked-run note.

const API = 'http://localhost:9080/api/v1';
const CUSTOM_FIELD = 'iwi';
const CUSTOM_LABEL = 'Iwi';
const CUSTOM_VALUE = 'Ngāti Test';

async function adminAid(): Promise<string> {
  const res = await fetch(`${API}/identity`);
  const body = await res.json();
  if (!body?.aid) throw new Error(`admin backend has no identity: ${JSON.stringify(body)}`);
  return body.aid as string;
}

// Fetch the current SharedProfile definition and re-write it with an added
// custom field, persisted as a type_definition object in the community space.
async function seedCustomProfileField(aid: string): Promise<void> {
  const defRes = await fetch(`${API}/types/SharedProfile`);
  const def = await defRes.json();
  if (!Array.isArray(def?.fields)) throw new Error('no SharedProfile definition to extend');

  if (!def.fields.some((f: { name: string }) => f.name === CUSTOM_FIELD)) {
    def.fields.push({
      name: CUSTOM_FIELD,
      type: 'string',
      uiHints: { inputType: 'text', label: CUSTOM_LABEL, section: 'profile', filterable: true },
    });
  }
  if (def.layouts?.form?.fields && !def.layouts.form.fields.includes(CUSTOM_FIELD)) {
    def.layouts.form.fields.push(CUSTOM_FIELD);
  }
  if (def.layouts?.detail?.fields && !def.layouts.detail.fields.includes(CUSTOM_FIELD)) {
    def.layouts.detail.fields.push(CUSTOM_FIELD);
  }

  const res = await fetch(`${API}/profiles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-AID': aid },
    body: JSON.stringify({ type: 'type_definition', id: 'typedef-SharedProfile', data: def }),
  });
  if (!res.ok) {
    throw new Error(`failed to seed custom field: ${res.status} ${await res.text()}`);
  }
}

async function openAccountSettings(page: Page): Promise<void> {
  const enter = page.getByRole('button', { name: /enter community/i });
  if (await enter.isVisible().catch(() => false)) {
    await enter.click();
  }
  await page.goto('/#/account-settings');
  await expect(page.getByText('Additional Information')).toBeVisible({ timeout: 30_000 });
}

test.describe('custom schema fields in profile form (#402)', () => {
  test('a seeded custom profile field renders, persists, and displays', async ({
    adminPage,
    snap,
  }) => {
    test.setTimeout(120_000);

    const aid = await adminAid();
    await seedCustomProfileField(aid);

    // 1. The custom field renders in the edit form's Additional Information card.
    await openAccountSettings(adminPage);
    const section = adminPage.locator('[data-test="custom-fields-section"]');
    await expect(section).toBeVisible();
    const input = section.locator(`#${CUSTOM_FIELD}`);
    await expect(input).toBeVisible();
    await snap(adminPage, 'custom-field-in-edit-form');

    // 2. Fill and save.
    await input.fill(CUSTOM_VALUE);
    await adminPage.getByRole('button', { name: /save/i }).first().click();
    await snap(adminPage, 'custom-field-saved');

    // 3. Reload — the value persisted and shows back in the form.
    await adminPage.reload();
    await openAccountSettings(adminPage);
    await expect(section.locator(`#${CUSTOM_FIELD}`)).toHaveValue(CUSTOM_VALUE);
    await snap(adminPage, 'custom-field-persisted');
  });
});
