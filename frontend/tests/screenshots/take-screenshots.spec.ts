/**
 * Screenshot script for MR review.
 * Logs in via mnemonic recovery, then captures key frontend screens.
 *
 * Run: cd frontend && npx playwright test --config=tests/screenshots/playwright.config.ts
 */
import { test, expect, Page, BrowserContext } from '@playwright/test';

const SESSION_MEMBER = 'http://localhost:5100';
const SESSION_ADMIN = 'http://localhost:5101';
const BACKEND_MEMBER = 'http://localhost:4000';
const BACKEND_ADMIN = 'http://localhost:4001';
const SCREENSHOT_DIR = '/home/engie/Pictures/matou-mr';

const MNEMONIC_MEMBER = 'burden siege false when alcohol game raccoon stock nose bright bargain weather'.split(' ');
const MNEMONIC_ADMIN = 'fork quick glow business robust spawn develop million fabric garage three cushion'.split(' ');

const TIMEOUT = 30000;

// ── Helpers ──────────────────────────────────────────────────────────────────

async function loginWithMnemonic(page: Page, frontendUrl: string, mnemonic: string[]) {
  await page.goto(frontendUrl);
  await expect(page.getByRole('button', { name: /join now/i })).toBeVisible({ timeout: TIMEOUT });

  await page.getByText(/recover identity/i).click();
  await expect(page.getByText(/enter your 12-word recovery phrase/i)).toBeVisible({ timeout: TIMEOUT });

  for (let i = 0; i < mnemonic.length; i++) {
    await page.locator(`#word-${i}`).fill(mnemonic[i]);
  }

  await page.getByRole('button', { name: /recover identity/i }).click();
  await expect(page.getByText(/identity recovered/i)).toBeVisible({ timeout: 60000 });

  await page.getByRole('button', { name: /continue/i }).click();

  const enterBtn = page.getByRole('button', { name: /enter community/i });
  await expect(enterBtn).toBeVisible({ timeout: 60000 });
  await expect(enterBtn).toBeEnabled({ timeout: 60000 });
  await enterBtn.click();

  await expect(page).toHaveURL(/#\/dashboard/, { timeout: TIMEOUT });
}

async function getAID(backendUrl: string): Promise<string> {
  const res = await fetch(`${backendUrl}/api/v1/identity`);
  const data = await res.json();
  return data.aid;
}

async function listProposals(backendUrl: string, aid: string) {
  const res = await fetch(`${backendUrl}/api/v1/proposals`, {
    headers: { 'X-User-AID': aid },
  });
  const data = await res.json();
  return data.proposals || [];
}

function findByStatus(proposals: any[], status: string) {
  return proposals.find((p: any) => p.status === status);
}

async function ensureInReviewProposal(backendUrl: string, aid: string) {
  const proposals = await listProposals(backendUrl, aid);
  const existing = findByStatus(proposals, 'in_review');
  if (existing) return existing;

  const createRes = await fetch(`${backendUrl}/api/v1/proposals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-AID': aid },
    body: JSON.stringify({
      proposer_id: 'admin',
      title: 'Whakatū Marae Digital Whakapapa Project',
      type: ['community', 'technical'],
      priority: 'high',
      description: 'Build a digital whakapapa platform for Whakatū Marae to preserve and share iwi connections.',
      problem_statement: 'Physical whakapapa records are at risk. Younger generation lacks easy access.',
      solution: 'Develop a secure, community-owned digital platform using Matou distributed infrastructure.',
      expected_outcomes: ['Digitize 500+ whakapapa records', 'Train 3 kaimahi', 'Run 2 community workshops'],
      estimated_budget: '35000',
      timeline: '6',
      endorsement_threshold: 1,
    }),
  });
  const proposal = await createRes.json();

  const transition = async (status: string) => {
    await fetch(`${backendUrl}/api/v1/proposals/${proposal.id}/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-AID': aid },
      body: JSON.stringify({ status }),
    });
  };

  await transition('submitted');
  await transition('endorsing');

  await fetch(`${backendUrl}/api/v1/proposals/${proposal.id}/endorsements`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-AID': aid },
    body: JSON.stringify({ endorser_id: aid, endorser_name: 'Admin', reason: 'Critical community project' }),
  });

  await transition('in_review');
  return { ...proposal, status: 'in_review' };
}

// ── Tests ────────────────────────────────────────────────────────────────────

let adminContext: BrowserContext;
let memberContext: BrowserContext;
let adminPage: Page;
let memberPage: Page;

test.describe.serial('MR Screenshots', () => {
  test.setTimeout(120000);

  test('00a - Login admin session', async ({ browser }) => {
    adminContext = await browser.newContext();
    adminPage = await adminContext.newPage();
    await loginWithMnemonic(adminPage, SESSION_ADMIN, MNEMONIC_ADMIN);
  });

  test('00b - Login member session', async ({ browser }) => {
    memberContext = await browser.newContext();
    memberPage = await memberContext.newPage();
    await loginWithMnemonic(memberPage, SESSION_MEMBER, MNEMONIC_MEMBER);
  });

  test('01 - Proposals list page', async () => {
    await adminPage.goto(`${SESSION_ADMIN}/#/dashboard/proposals`);
    await adminPage.waitForTimeout(3000);
    await adminPage.screenshot({ path: `${SCREENSHOT_DIR}/01-proposals-list.png`, fullPage: true });
  });

  test('02 - Proposal in_review - Admin view (sign off, reject, claim roles)', async () => {
    const aid = await getAID(BACKEND_ADMIN);
    const proposal = await ensureInReviewProposal(BACKEND_ADMIN, aid);

    await adminPage.goto(`${SESSION_ADMIN}/#/dashboard/proposals/${proposal.id}`);
    await adminPage.waitForTimeout(3000);
    await adminPage.screenshot({ path: `${SCREENSHOT_DIR}/02-in-review-admin-view.png`, fullPage: true });
  });

  test('03 - Proposal in_review - Member view (claim role buttons)', async () => {
    const aid = await getAID(BACKEND_ADMIN);
    const proposals = await listProposals(BACKEND_ADMIN, aid);
    const proposal = findByStatus(proposals, 'in_review');
    if (!proposal) { test.skip(); return; }

    await memberPage.goto(`${SESSION_MEMBER}/#/dashboard/proposals/${proposal.id}`);
    await memberPage.waitForTimeout(3000);
    await memberPage.screenshot({ path: `${SCREENSHOT_DIR}/03-in-review-member-view.png`, fullPage: true });
  });

  test('04 - Proposal voting_process - Governance actions', async () => {
    const aid = await getAID(BACKEND_ADMIN);
    const proposals = await listProposals(BACKEND_ADMIN, aid);
    const proposal = findByStatus(proposals, 'voting_process');
    if (!proposal) { test.skip(); return; }

    await adminPage.goto(`${SESSION_ADMIN}/#/dashboard/proposals/${proposal.id}`);
    await adminPage.waitForTimeout(3000);
    await adminPage.screenshot({ path: `${SCREENSHOT_DIR}/04-voting-process-proposal.png`, fullPage: true });

    const actionCard = adminPage.locator('.action-card').first();
    if (await actionCard.isVisible().catch(() => false)) {
      await actionCard.click();
      await adminPage.waitForTimeout(1500);
      await adminPage.screenshot({ path: `${SCREENSHOT_DIR}/05-governance-action-vote-buttons.png`, fullPage: true });
      await adminPage.locator('button:has-text("Close")').click().catch(() => {});
    }
  });

  test('06 - Governance action - Voting Not Yet Open (signed_off phase)', async () => {
    const aid = await getAID(BACKEND_ADMIN);
    const proposals = await listProposals(BACKEND_ADMIN, aid);
    let proposal = findByStatus(proposals, 'in_review');
    if (!proposal) { test.skip(); return; }

    await fetch(`${BACKEND_ADMIN}/api/v1/proposals/${proposal.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-User-AID': aid, 'X-User-Name': 'Admin' },
      body: JSON.stringify({ proposal_lead_id: 'Admin', proposal_steward_id: 'Admin' }),
    });
    await fetch(`${BACKEND_ADMIN}/api/v1/proposals/${proposal.id}/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-AID': aid },
      body: JSON.stringify({ status: 'signed_off' }),
    });

    const dpRes = await fetch(`${BACKEND_ADMIN}/api/v1/decision-plans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proposal_id: proposal.id,
        title: 'Governance Review Plan',
        description: 'Three-house governance review for the whakapapa project.',
        objectives: ['Elder council veto review', 'Community rep approval'],
        expected_outcomes: ['All houses approve'],
        proposal_lead_id: 'Admin',
        proposal_steward_id: 'Admin',
      }),
    });
    const dp = await dpRes.json();

    await fetch(`${BACKEND_ADMIN}/api/v1/governance-actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        decision_plan_id: dp.id,
        house: 'elders_council',
        action_type: 'decision',
        description: 'Elder Council veto review for whakapapa project',
      }),
    });

    await adminPage.goto(`${SESSION_ADMIN}/#/dashboard/proposals/${proposal.id}`);
    await adminPage.waitForTimeout(3000);
    await adminPage.screenshot({ path: `${SCREENSHOT_DIR}/06-signed-off-with-decision-plan.png`, fullPage: true });

    const actionCard = adminPage.locator('.action-card').first();
    if (await actionCard.isVisible().catch(() => false)) {
      await actionCard.click();
      await adminPage.waitForTimeout(1500);
      await adminPage.screenshot({ path: `${SCREENSHOT_DIR}/07-voting-not-yet-open.png`, fullPage: true });
      await adminPage.locator('button:has-text("Close")').click().catch(() => {});
    }
  });

  test('08 - Approved proposal - View Project / Create Project', async () => {
    const aid = await getAID(BACKEND_ADMIN);
    const proposals = await listProposals(BACKEND_ADMIN, aid);
    const approved = proposals.filter((p: any) => p.status === 'approved');

    for (const proposal of approved) {
      const projRes = await fetch(`${BACKEND_ADMIN}/api/v1/projects?proposal_id=${proposal.id}`);
      const projData = await projRes.json();

      await adminPage.goto(`${SESSION_ADMIN}/#/dashboard/proposals/${proposal.id}`);
      await adminPage.waitForTimeout(3000);

      if (projData.total > 0) {
        await adminPage.screenshot({ path: `${SCREENSHOT_DIR}/08-approved-view-project.png`, fullPage: true });
      } else {
        await adminPage.screenshot({ path: `${SCREENSHOT_DIR}/09-approved-create-project.png`, fullPage: true });
      }
    }
  });

  test('10 - Chat with proposal link card', async () => {
    await adminPage.goto(`${SESSION_ADMIN}/#/dashboard/chat`);
    await adminPage.waitForTimeout(3000);
    await adminPage.screenshot({ path: `${SCREENSHOT_DIR}/10-chat-proposal-link-card.png`, fullPage: true });
  });

  test('cleanup', async () => {
    await adminPage?.close();
    await memberPage?.close();
    await adminContext?.close();
    await memberContext?.close();
  });
});
