// @vitest-environment happy-dom
/**
 * ApproveCard renders the WS-A2/A2p/A2d/A2r faces with the wireframe's
 * data-field / data-action / data-status contract (idss #1492 stories 13–16/28).
 * No AID, SAID, nonce or bound message reaches the face — only the details
 * disclosure — and each refusal wears exactly its own line.
 */
import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';

// The credential card's mark reads two schema constants off a composable that
// pulls in the whole admin surface; the card needs only the constants.
vi.mock('src/composables/useAdminActions', () => ({
  ENDORSEMENT_SCHEMA_SAID: 'EENDORSESCHEMA',
  EVENT_ATTENDANCE_SCHEMA_SAID: 'EEVENTSCHEMA',
}));

import ApproveCard from 'src/components/signin/ApproveCard.vue';
import { buildCardView } from 'src/lib/signin/view';
import { describeCredential, type HeldCredential } from 'src/lib/signin/credential';
import { refusalCopy } from 'src/lib/signin/refusal';
import type { SigninAsk } from 'src/lib/signin/link';

const ask: SigninAsk = {
  door: 'https://id.example.nz/login',
  present: 'https://id.example.nz/login/app/present',
  challenge: 'c_3f9',
  schemas: ['EMe'],
  community: 'Te Rūnanga o Example',
  service: 'Files',
};
const KINDS = { EMe: 'membership', ECo: 'committee' };
const membership: HeldCredential = {
  sad: { d: 'EMe7Qzr', s: 'EMe', i: 'ECommunity', a: { i: 'EHa4mPq', role: 'Member', dt: '2026-08-12T00:00:00Z' } },
  status: { s: '0', et: 'iss' },
};
const view = buildCardView(ask, describeCredential(membership, KINDS, ask.community), 'EHa4mPq', true, false, 'Membership');

// MBtn forwards fallthrough attrs (data-action) and click to a plain button; the
// credential card's legacy mark is a Quasar icon.
const stubs = {
  MBtn: { template: '<button v-bind="$attrs"><slot/></button>' },
  'q-icon': { template: '<i />' },
};

function mountCard(props: Record<string, unknown>) {
  return mount(ApproveCard, {
    props: { view, phase: 'card', refusal: null, canApprove: true, ...props },
    global: { stubs },
  });
}

describe('ApproveCard — WS-A2 the card', () => {
  it('shows service, community, site line with the home chip, and the credential', () => {
    const w = mountCard({});
    expect(w.find('[data-field="ask"]').text()).toContain('Sign in to');
    expect(w.find('[data-field="service"]').text()).toBe('Files');
    expect(w.find('[data-field="community"]').text()).toBe('Te Rūnanga o Example');
    const site = w.find('[data-field="site"]');
    expect(site.attributes('data-status')).toBe('home-site');
    expect(site.text()).toContain('id.example.nz');
    expect(w.find('[data-field="home-mark"]').text()).toBe('your community');
    expect(w.find('[data-field="credential-to-show"]').text()).toContain('Membership');
  });

  it('keeps the AID, SAID, nonce and bound message off the face, only in details', () => {
    const w = mountCard({});
    // The identifiers appear only inside the <details> disclosure.
    expect(w.find('[data-field="aid"]').text()).toBe('EHa4mPq');
    expect(w.find('[data-field="credential-said"]').text()).toBe('EMe7Qzr');
    expect(w.find('[data-field="challenge-id"]').text()).toBe('c_3f9');
    expect(w.find('[data-field="bound-message"]').text()).toBe(
      'idss-idp:https://id.example.nz/login:EHa4mPq:c_3f9',
    );
    expect(w.find('[data-action="details"]').element.tagName.toLowerCase()).toBe('details');
  });

  it('Approve and Not now emit; Approve is disabled without a credential', async () => {
    const w = mountCard({});
    await w.find('[data-action="approve"]').trigger('click');
    await w.find('[data-action="not-now"]').trigger('click');
    expect(w.emitted('approve')).toHaveLength(1);
    expect(w.emitted('not-now')).toHaveLength(1);

    const held = mountCard({ canApprove: false });
    expect(held.find('[data-action="approve"]').attributes('disabled')).toBeDefined();
  });
});

// #683 (Ben, 2026-09-28): the approve screen shows the credential that will be
// presented AS ITS CARD — the card the wallet draws for a held credential — and
// Approve sits at the foot of that card, so what is pressed is visibly the thing
// being shown.
describe('ApproveCard — the credential card, with Approve at its foot (#683)', () => {
  const administrator: HeldCredential = {
    sad: {
      d: 'EAdministratorSAID',
      s: 'ECo',
      i: 'ECommunity',
      a: { i: 'EHa4mPq', committee: 'administrator', communityName: 'Whakatōhea', dt: '2026-09-28T00:00:00Z' },
    },
    status: { s: '0', et: 'iss' },
  };
  const panelAsk: SigninAsk = {
    ...ask,
    schemas: ['ECo', 'EMe'],
    community: 'Whakatōhea',
    service: 'the control panel',
    credential: 'administrator',
  };
  const adminView = buildCardView(
    panelAsk,
    describeCredential(administrator, KINDS, panelAsk.community),
    'EHa4mPq',
    true,
    false,
    'Administrator',
  );

  it('draws a Membership ask as the Membership card: name, role, community, issue date', () => {
    const w = mountCard({});
    const credCard = w.find('[data-field="credential-to-show"] .wallet-cred-card');
    expect(credCard.exists()).toBe(true);
    expect(w.find('[data-field="credential-to-show"]').attributes('data-kind')).toBe('membership');
    expect(credCard.find('.cred-name').text()).toBe('Membership');
    expect(credCard.find('.cred-subtitle').text()).toBe('Member');
    expect(credCard.text()).toContain('Te Rūnanga o Example');
    expect(credCard.find('.cred-date').text()).toBe('Issued 12 Aug 2026');
    expect(credCard.find('.cred-chip').text()).toBe('Active');
    expect(credCard.find('.cred-tile').exists()).toBe(true);
  });

  it('draws an Administrator ask as the Administrator card', () => {
    const w = mountCard({ view: adminView });
    const credCard = w.find('[data-field="credential-to-show"] .wallet-cred-card');
    expect(w.find('[data-field="credential-to-show"]').attributes('data-kind')).toBe('administrator');
    expect(credCard.find('.cred-name').text()).toBe('Administrator');
    expect(credCard.text()).toContain('Whakatōhea');
    expect(credCard.find('.cred-date').text()).toBe('Issued 28 Sep 2026');
    // The headline still names the service first, and the site line stays.
    expect(w.find('[data-field="service"]').text()).toBe('the control panel');
    expect(w.find('[data-field="site"]').text()).toContain('id.example.nz');
  });

  it("draws an operator's fallback at the control panel as their Membership card, Approve at its foot", () => {
    // #683 as amended: the door asked for Administrator, the wallet holds none,
    // and the operator's Membership is what will be shown.
    const operator: HeldCredential = {
      ...membership,
      sad: { ...membership.sad, a: { ...membership.sad!.a, role: 'operator' } },
    };
    const w = mountCard({
      view: buildCardView(panelAsk, describeCredential(operator, KINDS, 'Whakatōhea'), 'EHa4mPq', true, false, 'Administrator'),
    });
    expect(w.find('[data-field="credential-to-show"]').attributes('data-kind')).toBe('membership');
    const credCard = w.find('.wallet-cred-card');
    expect(credCard.find('.cred-name').text()).toBe('Membership');
    expect(credCard.find('.cred-subtitle').text()).toBe('operator');
    expect(credCard.find('.cred-foot [data-action="approve"]').exists()).toBe(true);
  });

  it('paints the card with the look the credential was issued with', () => {
    const branded: HeldCredential = {
      ...administrator,
      sad: {
        ...administrator.sad,
        a: { ...administrator.sad!.a, display: { name: 'Kaiwhakahaere', background: '#1a4d3a' } },
      },
    };
    const w = mountCard({
      view: buildCardView(panelAsk, describeCredential(branded, KINDS, 'Whakatōhea'), 'EHa4mPq', true, false, 'Administrator'),
    });
    const credCard = w.find('.wallet-cred-card');
    expect(credCard.classes()).toContain('painted');
    expect(credCard.find('.cred-name').text()).toBe('Kaiwhakahaere');
    // What the credential IS does not change with what its community calls it.
    expect(w.find('[data-field="credential-to-show"]').attributes('data-kind')).toBe('administrator');
    // Approve inverts the card's own pair — the ink as its ground, the card's
    // colour as its label — so it stands off whatever colour the community chose.
    const style = credCard.attributes('style') ?? '';
    expect(style).toContain('--cred-paint-bg: #1a4d3a');
    expect(style).toContain('--cred-paint-ink: #ffffff');
    expect(credCard.find('[data-action="approve"]').classes()).toContain('on-painted');
  });

  it('an unpainted card leaves Approve in the app\'s own colours', () => {
    const w = mountCard({ view: adminView });
    expect(w.find('.wallet-cred-card').classes()).not.toContain('painted');
    expect(w.find('[data-action="approve"]').classes()).not.toContain('on-painted');
  });

  it('puts Approve at the foot of the credential card — and nowhere else', async () => {
    const w = mountCard({ view: adminView });
    const approves = w.findAll('[data-action="approve"]');
    expect(approves).toHaveLength(1);
    const foot = w.find('.wallet-cred-card .cred-foot');
    expect(foot.element.contains(approves[0]!.element)).toBe(true);
    expect(approves[0]!.text()).toBe('Approve');
    // It is the last thing in the card: nothing of the card sits beneath it.
    expect(foot.element.lastElementChild).toBe(approves[0]!.element);
    expect(w.find('.wallet-cred-card').element.lastElementChild).toBe(foot.element);
    // The wallet's own OPEN is not on a card that is being presented.
    expect(w.find('.cred-open').exists()).toBe(false);

    await approves[0]!.trigger('click');
    expect(w.emitted('approve')).toHaveLength(1);
  });

  it('Not now stays beneath the card, outside it', () => {
    const w = mountCard({ view: adminView });
    const notNow = w.find('[data-action="not-now"]');
    expect(notNow.exists()).toBe(true);
    expect(w.find('.wallet-cred-card').element.contains(notNow.element)).toBe(false);
  });

  it('keeps the identifiers off the card face — the SAID is in details only', () => {
    const w = mountCard({ view: adminView });
    expect(w.find('.wallet-cred-card').text()).not.toContain('EAdministratorSAID');
    expect(w.find('[data-field="credential-said"]').text()).toBe('EAdministratorSAID');
  });

  it('never offers Approve without a credential to show', () => {
    const w = mountCard({
      view: buildCardView(panelAsk, null, 'EHa4mPq', true, false, 'Administrator'),
      canApprove: false,
    });
    expect(w.find('[data-action="approve"]').exists()).toBe(false);
    expect(w.find('.wallet-cred-card').exists()).toBe(false);
  });

  it('while proving, the card stays and says what is being proved; Approve is gone', () => {
    const w = mountCard({ view: adminView, phase: 'proving' });
    expect(w.find('.wallet-cred-card').exists()).toBe(true);
    expect(w.find('[data-action="approve"]').exists()).toBe(false);
    expect(w.find('[data-status="proving"]').text()).toContain('Proving you hold Administrator…');
  });
});

// The steward-unlock line (PU-A2u; #663, read from the code's own offer since
// #688). Built onto its own view via a second buildCardView so the ordinary card
// above proves it stays untouched.
const administratorCred: HeldCredential = {
  sad: {
    d: 'EAdministratorSAID',
    s: 'ECo',
    i: 'ECommunity',
    a: { i: 'EHa4mPq', committee: 'administrator', communityName: 'Te Rūnanga o Example', dt: '2026-08-12T00:00:00Z' },
  },
  status: { s: '0', et: 'iss' },
};
const seatUnlockAsk: SigninAsk = {
  ...ask,
  schemas: ['ECo', 'EMe'],
  service: 'the control panel',
  credential: 'administrator',
  offer: 'seat-unlock',
};
const panelView = buildCardView(
  seatUnlockAsk,
  describeCredential(administratorCred, KINDS, ask.community),
  'EHa4mPq',
  true,
  true,
  'Administrator',
);

/** Every `data-field` / `data-action` / `data-status` a rendered face carries. */
function contractOf(w: { element: Element }): { fields: string[]; actions: string[]; statuses: string[] } {
  const read = (attr: string) =>
    [...new Set([w.element, ...w.element.querySelectorAll(`[${attr}]`)].map((e) => e.getAttribute(attr)))]
      .filter((v): v is string => !!v)
      .sort();
  return { fields: read('data-field'), actions: read('data-action'), statuses: read('data-status') };
}

describe('ApproveCard — the steward-unlock line (PU-A2u)', () => {
  function mountPanel(props: Record<string, unknown> = {}) {
    return mount(ApproveCard, {
      props: { view: panelView, phase: 'card', refusal: null, canApprove: true, unlockOn: true, ...props },
      global: { stubs },
    });
  }

  it('shows the on-by-default line with the exact copy, and no second confirm', () => {
    const w = mountPanel();
    const line = w.find('[data-field="unlock-steward-actions-line"]');
    expect(line.exists()).toBe(true);
    expect(line.text()).toContain('Also unlock steward actions on this computer until you sign out');
    const guard = line.find('[data-field="unlock-guard"]');
    expect(guard.text()).toBe(
      "This computer will be able to approve people, issue and revoke credentials, and see who's waiting — without typing your twelve words. You can end it from your app at any time.",
    );
    expect(guard.attributes('data-status')).toBeUndefined();
    // The switch IS the consent: it reflects on, and Approve is the only other
    // action — there is no separate "confirm unlock" control.
    const toggle = w.find('[data-action="toggle-unlock-steward-actions"]');
    expect(toggle.attributes('role')).toBe('switch');
    expect(toggle.attributes('aria-checked')).toBe('true');
    expect((toggle.element as HTMLInputElement).checked).toBe(true);
    expect(w.find('[data-action="approve"]').text()).toBe('Approve');
  });

  it('shows the off-state guard sentence when switched off, before any press', () => {
    const w = mountPanel({ unlockOn: false });
    const guard = w.find('[data-field="unlock-guard"]');
    expect(guard.attributes('data-status')).toBe('off');
    expect(guard.text()).toBe(
      "You'll be signed in, but this computer won't be able to approve people or issue credentials. You can unlock it later from the Members tab.",
    );
    expect(w.find('[data-action="toggle-unlock-steward-actions"]').attributes('aria-checked')).toBe('false');
  });

  it('emits toggle-unlock with the new state when the switch is flipped', async () => {
    const w = mountPanel();
    const box = w.find('[data-action="toggle-unlock-steward-actions"]');
    (box.element as HTMLInputElement).checked = false;
    await box.trigger('change');
    expect(w.emitted('toggle-unlock')).toEqual([[false]]);
  });

  it('says "your app", never "your phone"', () => {
    expect(mountPanel().text()).not.toMatch(/phone/i);
    expect(mountPanel({ unlockOn: false }).text()).not.toMatch(/phone/i);
  });

  it('renders no sealing-key fingerprint, in details or anywhere (#688)', () => {
    const w = mountPanel();
    expect(w.find('[data-field="sealing-key-fingerprint"]').exists()).toBe(false);
    expect(w.find('[data-field="tab-sealing-key"]').exists()).toBe(false);
    expect(w.text()).not.toMatch(/sealing|fingerprint|this computer's key/i);
    // The details are the four every approve card has.
    expect(w.findAll('[data-action="details"] dd').map((d) => d.attributes('data-field'))).toEqual([
      'aid',
      'credential-said',
      'challenge-id',
      'bound-message',
    ]);
  });

  it('shows no unlock line on an ordinary card', () => {
    const w = mountCard({});
    expect(w.find('[data-field="unlock-steward-actions-line"]').exists()).toBe(false);
    expect(w.find('[data-action="toggle-unlock-steward-actions"]').exists()).toBe(false);
    expect(w.find('[data-field="approve-card"]').attributes('data-service')).toBeUndefined();
  });

  it('shows no unlock line to an administrator who is not a steward — the same card, without it', () => {
    const w = mountPanel({
      view: buildCardView(
        seatUnlockAsk,
        describeCredential(administratorCred, KINDS, ask.community),
        'EHa4mPq',
        true,
        false,
        'Administrator',
      ),
    });
    expect(w.find('[data-field="unlock-steward-actions-line"]').exists()).toBe(false);
    expect(w.find('[data-action="approve"]').exists()).toBe(true);
  });

  // The design contract: every data-field / data-action / data-status drawn on
  // idss docs/ux/wireframes/panel-unlock/pu-a2u-approve-card-unlock-line.html.
  it('carries every data-field, data-action and data-status the wireframe draws', () => {
    const on = contractOf(mountPanel());
    expect(on.fields).toEqual(
      expect.arrayContaining([
        'ask',
        'service',
        'community',
        'approve-card',
        'site',
        'home-mark',
        'credential-to-show',
        'unlock-steward-actions-line',
        'unlock-guard',
        'aid',
        'credential-said',
        'challenge-id',
        'bound-message',
      ]),
    );
    expect(on.actions).toEqual(
      expect.arrayContaining(['toggle-unlock-steward-actions', 'details', 'approve', 'not-now']),
    );
    expect(on.statuses).toEqual(expect.arrayContaining(['home-site']));
    expect(contractOf(mountPanel({ unlockOn: false })).statuses).toEqual(expect.arrayContaining(['home-site', 'off']));

    const w = mountPanel();
    expect(w.find('[data-field="approve-card"]').attributes('data-service')).toBe('panel');
    expect(w.find('[data-field="credential-to-show"]').attributes('data-kind')).toBe('administrator');
  });
});

// A locked panel unlocks through the sign-in door (#688): the approve card in
// its unlock form. idss docs/ux/wireframes/panel-unlock/pu-a4-unlock-card.html.
const unlockAsk: SigninAsk = { ...seatUnlockAsk, offer: 'unlock', challenge: 'c_2d7' };
const unlockView = buildCardView(
  unlockAsk,
  describeCredential(administratorCred, KINDS, ask.community),
  'EHa4mPq',
  true,
  false,
  'Administrator',
);

describe('ApproveCard — the unlock form (PU-A4)', () => {
  function mountUnlock(props: Record<string, unknown> = {}) {
    return mount(ApproveCard, {
      props: { view: unlockView, phase: 'card', refusal: null, canApprove: true, form: 'unlock', ...props },
      global: { stubs },
    });
  }

  it('asks to unlock, never to sign in', () => {
    const w = mountUnlock();
    expect(w.find('[data-field="ask"]').text()).toBe('Unlock steward actions on this computer?');
    expect(w.find('[data-field="where"]').text()).toBe('this computer');
    expect(w.find('[data-field="ask"]').text()).not.toMatch(/sign in to/i);
    expect(w.find('[data-field="service"]').exists()).toBe(false);
  });

  it('says where, which sign-in site, and that the person is already signed in', () => {
    const w = mountUnlock();
    const card = w.find('[data-field="unlock-card"]');
    expect(card.attributes('data-service')).toBe('panel');
    expect(card.attributes('data-offer')).toBe('unlock');
    expect(card.find('[data-field="panel-site"]').text()).toContain("Te Rūnanga o Example's control panel");
    const site = card.find('[data-field="site"]');
    expect(site.attributes('data-status')).toBe('home-site');
    expect(site.text()).toContain("Te Rūnanga o Example's sign-in site");
    expect(site.text()).toContain('id.example.nz');
    expect(card.find('[data-field="home-mark"]').text()).toBe('your community');
    expect(card.find('[data-field="session-note"]').text()).toBe(
      "You're already signed in on that computer. This only unlocks steward actions.",
    );
    // It is an unlock card, not a second approve card.
    expect(w.find('[data-field="approve-card"]').exists()).toBe(false);
  });

  it('shows the credential as its card, with the guard and Unlock at its foot', async () => {
    const w = mountUnlock();
    const shownRegion = w.find('[data-field="credential-to-show"]');
    expect(shownRegion.attributes('data-kind')).toBe('administrator');
    const credCard = shownRegion.find('.wallet-cred-card');
    expect(credCard.find('[data-field="credential-name"]').text()).toBe('Administrator');
    expect(credCard.find('[data-field="credential-issuer"]').text()).toContain('Te Rūnanga o Example');
    expect(credCard.find('.cred-date').text()).toBe('Issued 12 Aug 2026');

    const foot = credCard.find('.cred-foot');
    expect(foot.find('[data-field="unlock-guard"]').text()).toBe(
      "That computer will be able to approve people, issue and revoke credentials, and see who's waiting, until you sign out or the page is closed. You can end it from your app at any time.",
    );
    const act = foot.find('[data-action="approve-unlock"]');
    expect(act.text()).toBe('Unlock');
    expect(foot.element.lastElementChild).toBe(act.element);
    // The act reads Unlock, and there is no Approve beside it.
    expect(w.find('[data-action="approve"]').exists()).toBe(false);

    await act.trigger('click');
    expect(w.emitted('approve')).toHaveLength(1);
  });

  it('has NO switch', () => {
    const w = mountUnlock({ unlockOn: true });
    expect(w.find('[data-field="unlock-steward-actions-line"]').exists()).toBe(false);
    expect(w.find('[data-action="toggle-unlock-steward-actions"]').exists()).toBe(false);
    expect(w.find('[role="switch"]').exists()).toBe(false);
    expect(w.find('input[type="checkbox"]').exists()).toBe(false);
  });

  it('Not now sits beneath the card and emits; nothing else is offered', async () => {
    const w = mountUnlock();
    const notNow = w.find('[data-action="not-now"]');
    expect(w.find('.wallet-cred-card').element.contains(notNow.element)).toBe(false);
    await notNow.trigger('click');
    expect(w.emitted('not-now')).toHaveLength(1);
    expect(w.emitted('approve')).toBeUndefined();
  });

  it('keeps the identifiers in details, labelled as this unlock, with no sealing key', () => {
    const w = mountUnlock();
    const details = w.find('[data-action="details"]');
    expect(details.findAll('dd').map((d) => d.attributes('data-field'))).toEqual([
      'aid',
      'credential-said',
      'challenge-id',
      'bound-message',
    ]);
    expect(details.text()).toContain('this unlock');
    expect(details.find('[data-field="challenge-id"]').text()).toBe('c_2d7');
    expect(details.find('[data-field="bound-message"]').text()).toBe(
      'idss-idp:https://id.example.nz/login:EHa4mPq:c_2d7',
    );
    expect(w.text()).not.toMatch(/sealing|fingerprint/i);
  });

  it('draws no countdown, and never suggests the session is at risk or over', () => {
    const text = mountUnlock().text();
    expect(text).not.toMatch(/expires in|seconds left|countdown/i);
    expect(text).not.toMatch(/at risk|signed out|sign in again/i);
    expect(text).not.toMatch(/phone/i);
  });

  it('while proving, the card stays and Unlock is gone', () => {
    const w = mountUnlock({ phase: 'proving' });
    expect(w.find('.wallet-cred-card').exists()).toBe(true);
    expect(w.find('[data-action="approve-unlock"]').exists()).toBe(false);
    expect(w.find('[data-status="proving"]').text()).toContain('Proving you hold Administrator…');
  });

  it('a refusal wears the same lines as any sign-in', () => {
    const w = mountUnlock({ phase: 'refused', refusal: refusalCopy('expired') });
    expect(w.find('[data-status="refused"]').attributes('data-refusal')).toBe('expired');
    expect(w.find('[data-field="unlock-card"]').exists()).toBe(false);
  });

  it('before it is loaded, it speaks of an unlock — never of a sign-in', () => {
    const loading = mountUnlock({ view: null, phase: 'loading', canApprove: false });
    expect(loading.find('[data-status="loading"]').text()).toContain('Getting this unlock ready…');
    const unavailable = mountUnlock({ view: null, phase: 'unavailable', canApprove: false });
    expect(unavailable.find('[data-status="unavailable"]').text()).toContain("Couldn't load this unlock.");
    expect(unavailable.text()).not.toMatch(/sign-in/i);
  });

  it('carries every data-field, data-action and data-status the wireframe draws', () => {
    const c = contractOf(mountUnlock());
    expect(c.fields).toEqual(
      expect.arrayContaining([
        'ask',
        'where',
        'unlock-card',
        'panel-site',
        'site',
        'home-mark',
        'session-note',
        'credential-to-show',
        'credential-name',
        'credential-issuer',
        'unlock-guard',
        'aid',
        'credential-said',
        'challenge-id',
        'bound-message',
      ]),
    );
    expect(c.actions).toEqual(expect.arrayContaining(['approve-unlock', 'details', 'not-now']));
    expect(c.statuses).toEqual(expect.arrayContaining(['home-site']));
  });
});

describe('ApproveCard — after Unlock verifies (PU-A4d)', () => {
  function mountDone() {
    return mount(ApproveCard, {
      props: { view: unlockView, phase: 'done', refusal: null, canApprove: true, form: 'unlock' },
      global: { stubs },
    });
  }

  it('says the computer is unlocking, where to go, and to keep the app open', () => {
    const w = mountDone();
    const done = w.find('[data-field="unlock-card"]');
    expect(done.attributes('data-status')).toBe('done');
    expect(done.find('[data-field="done-title"]').text()).toBe('Unlocking that computer');
    expect(done.find('[data-field="done-body"]').text()).toBe(
      'Go back to your browser — Members will open in a moment. Keep this app open until it does.',
    );
  });

  it('never says "Unlocked" as a finished fact, nor "Signed in"', () => {
    const text = mountDone().text();
    expect(text).not.toMatch(/\bunlocked\b/i);
    expect(text).not.toMatch(/signed in\./i);
  });

  it('offers Close', async () => {
    const w = mountDone();
    await w.find('[data-action="close"]').trigger('click');
    expect(w.emitted('close')).toHaveLength(1);
  });

  it('carries every data-field, data-action and data-status the wireframe draws', () => {
    const c = contractOf(mountDone());
    expect(c.fields).toEqual(expect.arrayContaining(['unlock-card', 'done-title', 'done-body']));
    expect(c.actions).toEqual(['close']);
    expect(c.statuses).toEqual(['done']);
  });

  it('an ordinary sign-in still ends on "Signed in."', () => {
    const w = mountCard({ phase: 'done' });
    expect(w.find('[data-status="done"]').text()).toContain('Signed in.');
    expect(w.find('[data-field="done-title"]').exists()).toBe(false);
  });
});

describe('ApproveCard — the follow-on faces', () => {
  it('WS-A2p Proving: one honest line, no card actions', () => {
    const w = mountCard({ phase: 'proving' });
    expect(w.find('[data-status="proving"]').text()).toContain("Proving you're a member…");
    expect(w.find('[data-action="approve"]').exists()).toBe(false);
  });

  it('WS-A2d Signed in: the done line and a Close', () => {
    const w = mountCard({ phase: 'done' });
    expect(w.find('[data-status="done"]').text()).toContain('Signed in.');
    expect(w.find('[data-status="done"]').text()).toContain('Back to your browser.');
    expect(w.find('[data-action="close"]').exists()).toBe(true);
  });

  it('WS-A2r a verification refusal: the shared sentence, Try again and the contact line', () => {
    const w = mountCard({ phase: 'refused', refusal: refusalCopy('no-membership') });
    const region = w.find('[data-status="refused"]');
    expect(region.attributes('data-refusal')).toBe('no-membership');
    expect(region.text()).toContain('Your access could not be verified.');
    expect(w.find('[data-action="try-again"]').exists()).toBe(true);
    expect(w.find('[data-field="contact-line"]').exists()).toBe(true);
  });

  it('records-unreachable wears its own line with no contact line', () => {
    const w = mountCard({ phase: 'refused', refusal: refusalCopy('records-unreachable') });
    expect(w.find('[data-status="records-unreachable"]').exists()).toBe(true);
    expect(w.find('[data-field="contact-line"]').exists()).toBe(false);
  });

  it('site-unreachable is the wallet-only network line', () => {
    const w = mountCard({ phase: 'refused', refusal: refusalCopy('site-unreachable') });
    expect(w.find('[data-status="site-unreachable"]').text()).toContain("Couldn't reach the sign-in site");
    expect(w.find('[data-field="contact-line"]').exists()).toBe(false);
  });
});

describe('ApproveCard — before the sign-in is loaded', () => {
  it('loading: a quiet line and no Approve or Not now', () => {
    const w = mountCard({ view: null, phase: 'loading', canApprove: false });
    expect(w.find('[data-status="loading"]').exists()).toBe(true);
    expect(w.find('[data-action="approve"]').exists()).toBe(false);
    expect(w.find('[data-action="not-now"]').exists()).toBe(false);
  });

  it('never shows the actions without the service details, even on the card face', () => {
    const w = mountCard({ view: null, phase: 'card', canApprove: false });
    expect(w.find('[data-action="approve"]').exists()).toBe(false);
    expect(w.find('[data-action="not-now"]').exists()).toBe(false);
  });

  it('unavailable: the try-again message, Try again emits retry, Not now closes', async () => {
    const w = mountCard({ view: null, phase: 'unavailable', canApprove: false });
    const msg = w.find('[data-status="unavailable"]');
    expect(msg.text()).toContain("Couldn't load this sign-in");
    expect(w.find('[data-action="approve"]').exists()).toBe(false);
    await w.find('[data-action="retry"]').trigger('click');
    await w.find('[data-action="not-now"]').trigger('click');
    expect(w.emitted('retry')).toHaveLength(1);
    expect(w.emitted('not-now')).toHaveLength(1);
  });
});
