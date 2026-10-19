import { test, expect } from './fixtures';

// Feature (#731): deleting a project used to fail silently. The project
// detail page's "Delete Project" danger-zone flow awaited the archive action
// in a try/finally with no catch, so a backend rejection (e.g. a 403
// "insufficient permissions") became an unhandled promise rejection that only
// hit the console — the confirm dialog stayed open and the user saw nothing.
//
// The fix adds a catch that surfaces the backend error as a negative Quasar
// notification (matching the sibling mutation handlers on the same page) and
// clears the busy flag so the dialog returns to an actionable state.
//
// This spec drives the real delete flow as admin and forces the archive
// endpoint to 403; the assertion is that the user now SEES the error.

const API = 'http://localhost:9080/api/v1';

async function adminAid(): Promise<string> {
  const res = await fetch(`${API}/identity`);
  const body = await res.json();
  if (!body?.aid) throw new Error(`admin backend has no identity: ${JSON.stringify(body)}`);
  return body.aid as string;
}

async function seedProject(aid: string, title: string): Promise<void> {
  const res = await fetch(`${API}/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-AID': aid },
    body: JSON.stringify({
      title,
      description: 'Seeded by the issue-731 feature spec to exercise the delete flow.',
      created_by: aid,
    }),
  });
  if (!res.ok) throw new Error(`seed project failed: ${res.status}`);
}

test.describe('deleting a project surfaces backend errors (#731)', () => {
  test('a denied delete shows a negative notification instead of failing silently', async ({
    adminPage,
    snap,
  }) => {
    test.setTimeout(120_000);

    const aid = await adminAid();
    const title = `Delete-me ${Date.now().toString(36)}`;
    await seedProject(aid, title);

    // Enter the community and open the Projects list.
    const enter = adminPage.getByRole('button', { name: /enter community/i });
    await enter.click({ timeout: 15_000 }).catch(() => {});
    await adminPage.getByRole('button', { name: 'Projects' }).click();

    // Open the seeded project's detail page.
    await adminPage.getByText(title).first().click();
    await expect(adminPage.getByRole('heading', { name: title })).toBeVisible({ timeout: 30_000 });
    await snap(adminPage, 'project-detail');

    // Force the archive endpoint to reject as the reporter's backend did:
    // a 403 carrying an { error } message.
    await adminPage.route('**/api/v1/projects/*/archive', async (route) => {
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'insufficient permissions' }),
      });
    });

    // Open the edit dialog, then the danger-zone delete confirmation.
    await adminPage.getByRole('button', { name: 'Edit' }).click();
    await adminPage.getByRole('button', { name: 'Delete Project' }).click();

    // Confirm the destroy: type the confirm word and click the destructive btn.
    const dialog = adminPage.locator('.destroy-dialog');
    await expect(dialog).toBeVisible();
    await dialog.locator('input').fill('DESTROY');
    await snap(adminPage, 'confirm-destroy-dialog');
    await dialog.getByRole('button', { name: 'Delete Project' }).click();

    // The fix: the backend error is now shown on screen (previously silent).
    await expect(adminPage.getByText('insufficient permissions')).toBeVisible({ timeout: 15_000 });
    // The confirm dialog is left actionable, not stuck or navigated away.
    await expect(dialog).toBeVisible();
    await snap(adminPage, 'delete-denied-notification');
  });
});
