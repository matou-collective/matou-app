import { test, expect, Page } from './fixtures';

// Feature (#615): a member holding the community's Membership credential is
// recognised as a member and routed to the welcome/dashboard path — NOT to the
// "Your application is being reviewed" pending-approval screen.
//
// The bug was an IDSS founder holding a Membership credential of the
// community's OWN schema (schemas.membership.said in the descriptor) landing on
// pending-approval forever, because every membership check tested only the
// hardcoded Mātou (coa-shared) schema SAID. The fix resolves the schema from
// the descriptor, falling back to the Mātou constant only for a coa-shared
// backend with no `schemas` block.
//
// This e2e runs against the coa-shared test env (the fixture accounts), where
// the descriptor names no `schemas` block so the membership check falls back to
// the Mātou schema — proving the credential-holder still reaches the dashboard
// through the descriptor-driven check (no regression). The IDSS founder-first-
// run proof (the community's own schema) needs the idss WKT-DEMO Drive and is
// noted as live verification in the PR.

async function enterCommunity(page: Page) {
  await page
    .getByRole('button', { name: /enter community/i })
    .click({ timeout: 15_000 })
    .catch(() => {});
}

test.describe('membership credential routes to the dashboard, not pending-approval (#615)', () => {
  test('a member holding their Membership credential reaches the dashboard', async ({
    memberPage,
    snap,
  }) => {
    test.setTimeout(120_000);

    // The memberPage fixture logs in via mnemonic; that path runs the welcome
    // overlay's membership check (the descriptor-resolved schema this issue
    // fixes) and, when it passes, lands on the dashboard.
    await enterCommunity(memberPage);
    await expect(memberPage).toHaveURL(/#\/dashboard/, { timeout: 20_000 });

    // The pending-approval "being reviewed" copy must NOT be shown — the
    // credential-holder was recognised as a member.
    await expect(
      memberPage.getByText(/being reviewed|application is being reviewed/i),
    ).toHaveCount(0);

    await snap(memberPage, 'member-reaches-dashboard');
  });
});
