// @vitest-environment happy-dom
/**
 * PU-A4n (#688; idss ADR 0282 as amended 2026-09-29, obligation 2c; wireframe
 * docs/ux/wireframes/panel-unlock/pu-a4-unlock-card.html). A code that says it
 * is an unlock, opened by an identity that is not one of the community's
 * stewards: the wallet says so, on a screen of its own, and sends nothing.
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import NotASteward from 'src/components/signin/NotASteward.vue';

const stubs = { MBtn: { template: '<button v-bind="$attrs"><slot/></button>' } };

function mountScreen() {
  return mount(NotASteward, { global: { stubs } });
}

describe('NotASteward — PU-A4n', () => {
  it('says this identity cannot unlock steward actions, and why', () => {
    const w = mountScreen();
    const face = w.find('[data-field="unlock-card"]');
    expect(face.attributes('data-status')).toBe('not-a-steward');
    expect(face.find('[data-field="heading"]').text()).toBe("This identity can't unlock steward actions");
    expect(face.find('[data-field="not-a-steward-body"]').text()).toBe(
      "Approving people and issuing credentials are done by your community's stewards, and this identity isn't one of them. You're still signed in to the control panel, and everything else in it works.",
    );
  });

  it('says nothing was sent', () => {
    expect(mountScreen().find('[data-field="nothing-shown"]').text()).toBe('Nothing was sent.');
  });

  it('offers Close and nothing else — no Unlock, no Approve, no switch', async () => {
    const w = mountScreen();
    expect(w.findAll('[data-action]').map((a) => a.attributes('data-action'))).toEqual(['close']);
    expect(w.find('[role="switch"]').exists()).toBe(false);
    await w.find('[data-action="close"]').trigger('click');
    expect(w.emitted('close')).toHaveLength(1);
  });

  it('never says refused — the door was never asked — and never offers a promotion', () => {
    const text = mountScreen().text();
    expect(text).not.toMatch(/refused/i);
    expect(text).not.toMatch(/become a steward/i);
    expect(text).not.toMatch(/phone/i);
  });

  it('carries every data-field, data-action and data-status the wireframe draws', () => {
    const w = mountScreen();
    const all = (attr: string) =>
      [w.element, ...w.element.querySelectorAll(`[${attr}]`)].map((e) => e.getAttribute(attr)).filter(Boolean);
    expect(all('data-field')).toEqual(
      expect.arrayContaining(['unlock-card', 'heading', 'not-a-steward-body', 'nothing-shown']),
    );
    expect(all('data-status')).toEqual(['not-a-steward']);
    expect(all('data-action')).toEqual(['close']);
  });
});
