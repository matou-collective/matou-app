import { test, expect } from './fixtures';

// Feature (#20): high-stakes actions carry a KERI-verifiable proof envelope so
// honest peers can validate legitimacy independently of the any-sync transport
// signature (peer-side verification itself lands with #19).
//
// This exercises the WRITER path end-to-end: an admin/steward signs off a
// contribution THROUGH THE UI, so the frontend signify-ts wallet signs the
// canonical action digest, and the persisted contribution then carries a
// `proof`. We drive the earlier lifecycle via the API (as the admin) to get a
// contribution to "approved", then perform only the high-stakes sign-off in the
// UI, and finally read the object back to confirm the proof was attached.

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

// Walk a fresh contribution to "approved" (ready for sign-off) via the API so
// the UI only has to perform the high-stakes sign-off itself.
async function seedApprovedContribution(aid: string, title: string): Promise<string> {
  const proj = await api(aid, 'POST', '/projects', {
    title,
    description: 'Seeded by issue-20 feature spec.',
    created_by: aid,
  });
  const plan = await api(aid, 'POST', '/implementation-plans', {
    project_id: proj.id,
    total_budget: '100',
    project_lead: aid,
    project_steward_id: aid,
  });
  const planWithMs = await api(aid, 'POST', `/implementation-plans/${plan.id}/milestones`, {
    title: 'Only milestone',
    duration: '1 week',
  });
  const milestoneId = (planWithMs.milestones ?? planWithMs.Milestones)[0].milestone_id;

  const contrib = await api(aid, 'POST', '/contributions', {
    project_id: proj.id,
    milestone_id: milestoneId,
    title,
    description: 'Single seeded contribution to sign off through the UI.',
    contribution_type: 'task',
    priority: 'medium',
    created_by: aid,
    objectives: ['demonstrate a signed proof'],
    deliverables: ['a signed-off contribution'],
    acceptance_criteria: ['contribution reaches signed_off with a proof'],
    deadline: '2027-01-01',
  });

  await api(aid, 'POST', `/contributions/${contrib.id}/confirm`);
  await api(aid, 'POST', `/contributions/${contrib.id}/assign`, { user_id: aid });
  await api(aid, 'POST', `/contributions/${contrib.id}/submit-evidence`, {
    completion_notes: 'Done — seeded lifecycle.',
  });
  await api(aid, 'POST', `/contributions/${contrib.id}/review`, {
    decision: 'approved',
    review_notes: 'Approved by seeding.',
  });
  // Sign off the plan first (its own sign-off is a separate high-stakes action);
  // done via API here since this spec demonstrates the CONTRIBUTION sign-off.
  await api(aid, 'POST', `/implementation-plans/${plan.id}/sign-off`);
  return contrib.id;
}

test.describe('KERI proof on high-stakes actions (#20)', () => {
  test('signing off a contribution in the UI attaches a verifiable proof', async ({
    adminPage,
    snap,
  }) => {
    test.setTimeout(300_000);
    const aid = await adminAid();

    const runTag = Date.now().toString(36);
    const title = `Proofed Contribution ${runTag}`;
    const contributionId = await seedApprovedContribution(aid, title);

    // Enter the community (dismiss the welcome splash if present) and open the
    // contribution from the Contributions list.
    await adminPage
      .getByRole('button', { name: /enter community/i })
      .click({ timeout: 15_000 })
      .catch(() => {});
    await adminPage.getByRole('button', { name: 'Contributions' }).click();
    await adminPage.getByText(title).first().click({ timeout: 30_000 });

    // The approved contribution exposes the Sign Off action.
    const signOff = adminPage.getByRole('button', { name: 'Sign Off' });
    await expect(signOff).toBeVisible({ timeout: 30_000 });
    await snap(adminPage, 'ready-for-sign-off');

    // Sign off through the UI — the frontend signs the canonical action digest
    // with the current user's personal AID and embeds the proof on the object.
    await signOff.click();
    await expect(adminPage.getByText('Signed Off').first()).toBeVisible({ timeout: 60_000 });
    await snap(adminPage, 'signed-off');

    // The persisted contribution now carries a KERI proof envelope that a peer
    // (via #19) can verify against the signer's key state + org credential.
    const fetched = await api(aid, 'GET', `/contributions/${contributionId}`);
    const contribution = fetched.contribution ?? fetched;
    expect(contribution.status).toBe('signed_off');

    const proof = contribution.proof;
    expect(proof, 'sign-off object must carry a proof').toBeTruthy();
    expect(proof.v).toBe('matou-proof/v1');
    expect(proof.action).toBe('contribution_signoff');
    expect(proof.subject).toBe(contributionId);
    expect(proof.value).toBe('signed_off');
    expect(proof.aid).toBe(aid);
    expect(typeof proof.sig).toBe('string');
    expect(proof.sig.length).toBeGreaterThan(0);
  });
});
