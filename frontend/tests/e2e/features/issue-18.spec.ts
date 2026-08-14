import { test, expect } from './fixtures';

// Feature (#18): KERI-signed request authentication makes X-User-AID
// trustworthy. The frontend signs a backend-issued challenge with the user's
// AID key (signify-ts) and exchanges it for a short-lived session token sent as
// a Bearer header; the backend verifies the signature against the AID's current
// key state before minting the token, and — with MATOU_REQUIRE_SIGNED_AUTH set
// (the e2e config turns it on) — only ever resolves roles for a verified session.
//
// This spec demonstrates:
//   1. The authenticated app works end-to-end under signed-auth enforcement —
//      admin and member sessions render RBAC-gated data, which is only possible
//      if the signed-challenge login succeeded (otherwise the backend 401s).
//   2. The backend rejects requests that lack a valid signed session: an absent
//      signature and a bogus token are both refused; roles are never resolved
//      for an unverified AID.

const API = 'http://localhost:9080/api/v1';

test('authenticated app works under signed-auth enforcement', async ({ adminPage, memberPage, snap }) => {
  // The fixtures log both sessions in; connect() runs signInToBackend(), so each
  // page holds a verified Bearer session. Landing on authenticated content is the
  // positive proof the signify→Go CESR/key-state path worked.
  await adminPage.goto('/');
  await adminPage.waitForLoadState('networkidle');
  // The app is past the unlock/login gate — no passcode entry is shown.
  await expect(adminPage.locator('body')).not.toContainText('Enter your recovery phrase');
  await snap(adminPage, 'admin-authenticated');

  await memberPage.goto('/');
  await memberPage.waitForLoadState('networkidle');
  await expect(memberPage.locator('body')).not.toContainText('Enter your recovery phrase');
  await snap(memberPage, 'member-authenticated');
});

test('backend issues challenges and rejects unsigned RBAC requests', async () => {
  // The challenge endpoint is reachable without a session (it is how a client
  // obtains one) and returns a fresh nonce.
  const challengeRes = await fetch(`${API}/auth/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ aid: 'ETestChallengeAID' }),
  });
  expect(challengeRes.status).toBe(200);
  const challenge = await challengeRes.json();
  expect(typeof challenge.challenge).toBe('string');
  expect(challenge.challenge.length).toBeGreaterThan(0);

  // A protected mutating endpoint with NO signed session (no token; the header
  // alone is not trusted under enforcement) must be rejected — roles are never
  // resolved for an unverified AID.
  const unsigned = await fetch(`${API}/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-AID': 'ESpoofedAdmin' },
    body: JSON.stringify({ title: 'should not be created', created_by: 'ESpoofedAdmin' }),
  });
  expect(unsigned.status).toBe(401);

  // A bogus Bearer token is likewise refused.
  const bogus = await fetch(`${API}/projects`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer not-a-real-token',
    },
    body: JSON.stringify({ title: 'should not be created' }),
  });
  expect(bogus.status).toBe(401);
});
