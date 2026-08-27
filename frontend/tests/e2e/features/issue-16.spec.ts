import { test, expect } from './fixtures';
import { loginAs } from '../utils/signed-auth';

// Feature (#16): local API hardening. The backend now applies LocalhostGuard
// in every mode and a per-launch TokenGuard that rejects mutating requests
// (POST/PUT/PATCH/DELETE) lacking a valid `Authorization: Bearer <token>`.
// Read requests stay open. Dev/test backends accept the fixed `matou-dev`
// token, which the app attaches automatically and which Playwright injects
// centrally, so the app keeps working end-to-end from the user's perspective.
//
// This spec exercises the enforcement directly at the API layer (a mutation is
// rejected without a valid token and accepted with it) and confirms the admin
// app boots and operates normally with the guard active.

const API = 'http://localhost:9080/api/v1';

async function adminAid(): Promise<string> {
  // GET /identity is a read — it passes the guard without a token.
  const res = await fetch(`${API}/identity`);
  const body = await res.json();
  if (!body?.aid) throw new Error(`admin backend has no identity: ${JSON.stringify(body)}`);
  return body.aid as string;
}

test.describe('local API hardening — TokenGuard on mutations (#16)', () => {
  test('mutating request is rejected without a valid token, accepted with it', async ({
    adminPage,
    snap,
  }) => {
    test.setTimeout(120_000);
    const aid = await adminAid();
    // Signed-auth session (issue #18): the only bearer that also carries a
    // verified AID when MATOU_REQUIRE_SIGNED_AUTH is on.
    const session = await loginAs(adminPage);
    const runTag = Date.now().toString(36);

    // Negative: an explicit wrong bearer token → TokenGuard returns 401.
    // (The explicit header stops the central Node-fetch auth from supplying the
    // valid dev token, so this genuinely tests the unauthenticated path.)
    const rejected = await fetch(`${API}/projects`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-User-AID': aid,
        Authorization: 'Bearer not-the-real-token',
      },
      body: JSON.stringify({
        title: `Should never be created ${runTag}`,
        description: 'Rejected by TokenGuard — no valid token.',
        created_by: aid,
      }),
    });
    expect(rejected.status, 'mutation without a valid token must be 401').toBe(401);

    // Positive: a valid bearer (the admin's signed-auth session) → the mutation succeeds.
    const acceptedTitle = `Token-authenticated project ${runTag}`;
    const accepted = await fetch(`${API}/projects`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-User-AID': aid,
        // A session token satisfies TokenGuard too — it was minted through the
        // token-guarded login endpoints — and binds the request to the admin AID.
        Authorization: `Bearer ${session.token}`,
      },
      body: JSON.stringify({
        title: acceptedTitle,
        description: 'Created via the token-authenticated path (issue-16 feature spec).',
        created_by: aid,
      }),
    });
    expect(accepted.ok, `mutation with a valid token should succeed: ${accepted.status}`).toBe(true);

    // The app itself keeps working end-to-end: the admin session (which boots
    // through authenticated backend calls) loads and can browse Projects, where
    // the token-authenticated project appears.
    const enterBtn = adminPage.getByRole('button', { name: /enter community/i });
    await enterBtn.click({ timeout: 15_000 }).catch(() => {});
    await adminPage.getByRole('button', { name: 'Projects' }).click();
    await expect(adminPage.getByText(acceptedTitle).first()).toBeVisible({ timeout: 30_000 });
    await snap(adminPage, 'app-works-with-token-guard-active');
  });
});
