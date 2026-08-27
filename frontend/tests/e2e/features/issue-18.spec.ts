import { test, expect } from './fixtures';
import { loginAs, jsonSessionHeaders } from '../utils/signed-auth';

// Feature (#18): KERI-signed request authentication makes X-User-AID
// trustworthy. The frontend signs a backend-issued challenge with the user's
// AID key (signify-ts) and exchanges it for a short-lived session token sent as
// a Bearer header; the backend verifies the signature against the AID's current
// key state before minting the token, and — with MATOU_REQUIRE_SIGNED_AUTH set
// (the e2e config turns it on) — only ever resolves roles for a verified session.
//
// This spec demonstrates:
//   1. The signed-challenge login really happened for both sessions — each page
//      holds a backend session token — and an RBAC-gated mutation succeeds when
//      it carries that token. This is only possible if the signify→Go
//      CESR/key-state path verified the signature (the backend never trusts a
//      client-supplied key).
//   2. The backend rejects requests that lack a valid signed session: a bare
//      X-User-AID (no token) and a bogus token are both refused, so roles are
//      never resolved for an unverified AID; a well-formed challenge is still
//      issued to anyone (it is how a client obtains a session).

const API = 'http://localhost:9080/api/v1';

test('signed-challenge login mints sessions that authorise RBAC-gated requests', async ({
  adminPage,
  memberPage,
  snap,
}) => {
  test.setTimeout(120_000);

  // The fixtures log both sessions in; connect() runs signInToBackend(), so each
  // page holds a verified Bearer session. loginAs() reads it from the identity
  // store and throws if the login did not produce one.
  const admin = await loginAs(adminPage);
  expect(admin.token.length, 'admin holds a backend session token').toBeGreaterThan(20);
  const member = await loginAs(memberPage);
  expect(member.token.length, 'member holds a backend session token').toBeGreaterThan(20);
  expect(member.aid).not.toBe(admin.aid);

  // Positive proof: an RBAC-gated mutation (project creation requires a
  // community role) succeeds with the admin's session token...
  const runTag = Date.now().toString(36);
  const created = await fetch(`${API}/projects`, {
    method: 'POST',
    headers: jsonSessionHeaders(admin.aid),
    body: JSON.stringify({
      title: `Signed-auth project ${runTag}`,
      description: 'Created with a KERI-signed session (issue-18 feature spec).',
      created_by: admin.aid,
    }),
  });
  expect(created.ok, `session-authenticated create should succeed: ${created.status}`).toBe(true);
  const project = (await created.json()) as { id: string; created_by?: string };
  expect(project.id).toBeTruthy();

  // ...and the backend attributed it to the VERIFIED AID from the session, not
  // to whatever the client claimed in the header.
  const spoofed = await fetch(`${API}/projects`, {
    method: 'POST',
    headers: { ...jsonSessionHeaders(admin.aid), 'X-User-AID': 'ESpoofedSomebodyElse' },
    body: JSON.stringify({
      title: `Signed-auth spoof check ${runTag}`,
      description: 'Header claims another AID; session binds it to the admin.',
      created_by: admin.aid,
    }),
  });
  expect(spoofed.ok, `spoofed header with a valid session: ${spoofed.status}`).toBe(true);
  const spoofedProject = (await spoofed.json()) as { id: string };
  const readBack = await fetch(`${API}/projects/${spoofedProject.id}`, {
    headers: jsonSessionHeaders(admin.aid),
  });
  expect(readBack.ok).toBe(true);
  const body = (await readBack.json()) as { created_by?: string; project?: { created_by?: string } };
  const createdBy = body.created_by ?? body.project?.created_by;
  expect(createdBy, 'creator is the session-verified AID').toBe(admin.aid);

  // The app itself is past the unlock gate on both sessions.
  await adminPage.goto('/');
  await adminPage.waitForLoadState('networkidle');
  await expect(adminPage.locator('body')).not.toContainText('Enter your recovery phrase');
  await snap(adminPage, 'admin-authenticated');
  await memberPage.goto('/');
  await memberPage.waitForLoadState('networkidle');
  await expect(memberPage.locator('body')).not.toContainText('Enter your recovery phrase');
  await snap(memberPage, 'member-authenticated');

  // Tidy up the seeded projects.
  for (const id of [project.id, spoofedProject.id]) {
    await fetch(`${API}/projects/${id}/archive`, {
      method: 'POST',
      headers: jsonSessionHeaders(admin.aid),
    }).catch(() => {});
  }
});

test('backend issues challenges and rejects unsigned RBAC requests', async ({ adminPage }) => {
  const admin = await loginAs(adminPage);

  // The challenge endpoint is reachable without a session (it is how a client
  // obtains one) and returns a fresh nonce for a well-formed AID...
  const challengeRes = await fetch(`${API}/auth/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ aid: admin.aid }),
  });
  expect(challengeRes.status).toBe(200);
  const challenge = (await challengeRes.json()) as { challenge: string };
  expect(typeof challenge.challenge).toBe('string');
  expect(challenge.challenge.length).toBeGreaterThan(0);

  // ...but a malformed AID is refused outright.
  const badAid = await fetch(`${API}/auth/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ aid: 'not-an-aid' }),
  });
  expect(badAid.status).toBe(400);

  // A login with a garbage signature for a real challenge is a 401 (the
  // challenge is consumed by the attempt — replay protection).
  const badLogin = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ aid: admin.aid, challenge: challenge.challenge, signature: '0B' + 'A'.repeat(86) }),
  });
  expect(badLogin.status).toBe(401);

  // A protected mutating endpoint with NO signed session (no token; the header
  // alone is not trusted under enforcement) must be rejected — roles are never
  // resolved for an unverified AID. The explicit dev API token satisfies
  // TokenGuard but is not a session, so X-User-AID is stripped → 401 from RBAC.
  const unsigned = await fetch(`${API}/projects`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-User-AID': admin.aid,
      Authorization: 'Bearer matou-dev',
    },
    body: JSON.stringify({ title: 'should not be created', created_by: admin.aid }),
  });
  expect(unsigned.status).toBe(401);

  // A bogus Bearer token is likewise refused.
  const bogus = await fetch(`${API}/projects`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-User-AID': admin.aid,
      Authorization: 'Bearer not-a-real-token',
    },
    body: JSON.stringify({ title: 'should not be created', created_by: admin.aid }),
  });
  expect(bogus.status).toBe(401);
});
