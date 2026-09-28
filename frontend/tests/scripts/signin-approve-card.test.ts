// @vitest-environment happy-dom
/**
 * ApproveCard renders the WS-A2/A2p/A2d/A2r faces with the wireframe's
 * data-field / data-action / data-status contract (idss #1492 stories 13–16/28).
 * No AID, SAID, nonce or bound message reaches the face — only the details
 * disclosure — and each refusal wears exactly its own line.
 */
import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import ApproveCard from 'src/components/signin/ApproveCard.vue';
import { buildCardView } from 'src/lib/signin/view';
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
const view = buildCardView(
  ask,
  { said: 'EMe7Qzr', schema: 'EMe', kindLabel: 'Membership', role: 'Member', issuedOn: '12 Aug 2026' },
  'EHa4mPq',
  true,
);

// MBtn forwards fallthrough attrs (data-action) and click to a plain button.
const stubs = { MBtn: { template: '<button v-bind="$attrs"><slot/></button>' } };

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
    expect(w.find('[data-field="credential-to-show"]').text()).toContain('Member since 12 Aug 2026');
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

    const noCred = mountCard({ canApprove: false });
    expect(noCred.find('[data-action="approve"]').attributes('disabled')).toBeDefined();
  });
});

// The steward-unlock line (#663, PU-A2u). Built onto its own view via a second
// buildCardView so the ordinary card above proves it stays untouched.
const panelView = buildCardView(
  ask,
  { said: 'EMe7Qzr', schema: 'EMe', kindLabel: 'Membership', role: 'operator', issuedOn: '12 Aug 2026' },
  'EHa4mPq',
  true,
  { sealingKeyFingerprint: 'eff1·63d6' },
);

describe('ApproveCard — the steward-unlock line (#663)', () => {
  it('shows the on-by-default line with the exact copy, and no second confirm', () => {
    const w = mount(ApproveCard, {
      props: { view: panelView, phase: 'card', refusal: null, canApprove: true, unlockOn: true },
      global: { stubs },
    });
    const line = w.find('[data-field="unlock-line"]');
    expect(line.exists()).toBe(true);
    expect(line.text()).toContain('Also unlock steward actions on this computer until you sign out');
    const on = w.find('[data-status="unlock-on"]');
    expect(on.exists()).toBe(true);
    expect(on.text()).toContain('approve people, issue and revoke credentials');
    expect(on.text()).toContain('without typing your twelve words');
    // The toggle IS the consent: the checkbox reflects on, and Approve is the
    // only other action — there is no separate "confirm unlock" control.
    expect((w.find('[data-action="toggle-unlock"]').element as HTMLInputElement).checked).toBe(true);
    expect(w.find('[data-status="unlock-off"]').exists()).toBe(false);
  });

  it('shows the off-state guard sentence when switched off, before any press', () => {
    const w = mount(ApproveCard, {
      props: { view: panelView, phase: 'card', refusal: null, canApprove: true, unlockOn: false },
      global: { stubs },
    });
    const off = w.find('[data-status="unlock-off"]');
    expect(off.exists()).toBe(true);
    expect(off.text()).toContain("this computer won't be able to approve people or issue credentials");
    expect(off.text()).toContain('unlock it later from the Members tab');
    expect(w.find('[data-status="unlock-on"]').exists()).toBe(false);
  });

  it('emits toggle-unlock with the new state when the switch is flipped', async () => {
    const w = mount(ApproveCard, {
      props: { view: panelView, phase: 'card', refusal: null, canApprove: true, unlockOn: true },
      global: { stubs },
    });
    const box = w.find('[data-action="toggle-unlock"]');
    (box.element as HTMLInputElement).checked = false;
    await box.trigger('change');
    expect(w.emitted('toggle-unlock')).toEqual([[false]]);
  });

  it('shows the sealing-key fingerprint only inside details, never on the face', () => {
    const w = mount(ApproveCard, {
      props: { view: panelView, phase: 'card', refusal: null, canApprove: true, unlockOn: true },
      global: { stubs },
    });
    const fp = w.find('[data-field="sealing-key-fingerprint"]');
    expect(fp.text()).toBe('eff1·63d6');
    // It lives within the <details> disclosure, not the unlock line on the face.
    expect(w.find('[data-action="details"]').element.contains(fp.element)).toBe(true);
    expect(w.find('[data-field="unlock-line"]').element.contains(fp.element)).toBe(false);
  });

  it('shows no unlock line on an ordinary card (view.unlock null)', () => {
    const w = mountCard({});
    expect(w.find('[data-field="unlock-line"]').exists()).toBe(false);
    expect(w.find('[data-field="sealing-key-fingerprint"]').exists()).toBe(false);
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
