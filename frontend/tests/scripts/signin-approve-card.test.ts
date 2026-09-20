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
