import { test, expect, Page } from './fixtures';

// Feature (#591): the Create Proposal dialog must collect the schema-required
// `priority` field. The backend Proposal schema marks `priority` as
// required + core with an enum (low/medium/high/critical) and runs
// validateAgainstSchema after base validation, so a create request without a
// priority is rejected with a 400 before the "proposal created" log line — the
// dialog stayed open with no proposal and only a generic toast.
//
// This spec drives the dialog through the admin session: it fills every field,
// picks a priority, submits, and verifies the proposal is created (dialog
// closes, card appears with the chosen priority). The priority selector is the
// piece the dialog previously lacked.

async function openProposals(page: Page) {
  await page.goto('/#/dashboard/proposals');
  await expect(page).toHaveURL(/\/dashboard\/proposals/, { timeout: 20_000 });
}

test.describe('Create Proposal dialog collects priority (#591)', () => {
  test('admin creates a proposal with a chosen priority via the UI', async ({
    adminPage,
    snap,
  }) => {
    test.setTimeout(120_000);

    await openProposals(adminPage);

    // Open the Create Proposal dialog.
    await adminPage.locator('.create-btn', { hasText: '+ New Proposal' }).click();
    const dialog = adminPage.locator('.q-dialog');
    await expect(dialog.locator('.text-h6')).toContainText('Create Proposal', {
      timeout: 20_000,
    });
    await snap(adminPage, 'create-dialog-open');

    const title = `Priority E2E Proposal ${Date.now()}`;

    // Fill every required field.
    await dialog.getByLabel('Title *').fill(title);
    await dialog.locator('.type-card').filter({ hasText: 'Governance' }).click();

    // The priority selector added by this issue — defaults to Medium; pick High.
    const prioritySelect = dialog.getByLabel('Priority *');
    await expect(prioritySelect).toBeVisible();
    await prioritySelect.click();
    await adminPage.getByRole('option', { name: 'High' }).click();
    await snap(adminPage, 'priority-selected');

    await dialog.getByLabel('Description *').fill('Exercise the priority field end-to-end');
    await dialog.getByLabel('Problem Statement *').fill('Create rejected without a priority');
    await dialog.getByLabel('Proposed Solution *').fill('Collect priority in the create dialog');
    await dialog.getByLabel('Outcome 1').fill('Proposal is created via the UI');
    await dialog.getByLabel('Estimated Budget *').fill('500');
    await dialog.getByLabel(/Timeline/i).fill('4');

    await dialog.getByRole('button', { name: /Create Proposal/i }).click();

    // Success: the dialog closes and the new proposal appears in the list.
    await expect(dialog.locator('.text-h6')).toBeHidden({ timeout: 30_000 });
    const card = adminPage
      .locator('.proposal-card')
      .filter({ hasText: title })
      .first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.locator('.proposal-priority')).toContainText('high');
    await snap(adminPage, 'proposal-created');
  });
});
