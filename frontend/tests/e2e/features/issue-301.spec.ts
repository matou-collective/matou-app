import { test, expect, Page } from './fixtures';

// Feature (#301): the participation-interest options offered on a member's
// profile form are sourced from the org's SharedProfile schema enum, which is
// seeded from the org's kit at setup — rather than a hardcoded frontend list.
//
// At org setup the frontend seeds SharedProfile.participationInterests
// `validation.enum` from the kit's (slugified) interest options, so the schema
// is the runtime source of truth: an org that edits the enum immediately
// changes what the form offers, and writes carrying a value outside the enum
// are rejected server-side. The Account Settings "Interests & Skills" section
// renders exactly those options, decorated with their kit labels.
//
// This spec verifies the offered options render on the member profile form and
// are selectable. The server-side enforcement (out-of-enum writes rejected) is
// covered by backend unit tests; editing the enum needs the schema-edit path.

async function enterCommunity(page: Page) {
  await page
    .getByRole('button', { name: /enter community/i })
    .click({ timeout: 15_000 })
    .catch(() => {});
}

test.describe('participation interests come from the SharedProfile schema (#301)', () => {
  test('the profile form offers the schema-sourced interest options', async ({
    memberPage,
    snap,
  }) => {
    test.setTimeout(120_000);

    await enterCommunity(memberPage);
    await memberPage.goto('/#/dashboard/settings');

    // The "Interests & Skills" section renders the participation-interest chips.
    const interests = memberPage.locator('.interests-chips');
    await expect(interests).toBeVisible({ timeout: 20_000 });
    await interests.scrollIntoViewIfNeeded();

    // The default kit vocabulary is offered, decorated with its kit labels.
    const research = memberPage.getByRole('button', { name: /Research and Knowledge/i });
    await expect(research).toBeVisible();
    await expect(
      memberPage.getByRole('button', { name: /Cultural Oversight/i }),
    ).toBeVisible();

    await snap(memberPage, 'account-settings-interests-offered');

    // Selecting an option toggles it on (schema-sourced value, kit label).
    await research.click();
    await expect(research).toHaveClass(/interest-chip--selected/);

    await snap(memberPage, 'account-settings-interest-selected');
  });
});
