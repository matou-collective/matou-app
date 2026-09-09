// @vitest-environment happy-dom
/**
 * Profile form fields, kit interests and custom questions (coa-kit plan Task 7,
 * issue #243).
 *
 * Two layers:
 *  1. the pure helpers in src/kit/profile.ts — interest options derived from
 *     labels and per-type custom-answer validation;
 *  2. a mounted ProfileFormScreen driven by a scratch KIT — with
 *     `fields.email = false` the email input is gone, and a `select` custom
 *     question renders a labelled <select>.
 *
 * Runs under happy-dom (the repo's DOM env; jsdom is not installed). The
 * identity/KERI/api modules are stubbed so the mount stays a template test.
 */
import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { defineComponent } from 'vue';
import { interestOptions, emptyAnswers, answersValid } from 'src/kit/profile';

describe('kit profile helpers', () => {
  it('derives interest options from labels', () => {
    expect(
      interestOptions({
        fields: { photo: true, email: true, bio: true, location: true, whyJoin: true, interests: true },
        customQuestions: [],
        interestOptions: ['Kai', 'Art and Designs'],
      }),
    ).toEqual([
      { value: 'kai', label: 'Kai', description: '' },
      { value: 'art_and_designs', label: 'Art and Designs', description: '' },
    ]);
  });

  it('validates custom answers by type', () => {
    const qs = [
      { type: 'text', label: 'Why?' },
      { type: 'select', label: 'Marae', options: ['A', 'B'] },
      { type: 'multiselect', label: 'Days', options: ['Mon', 'Tue'] },
    ] as const;
    const a = emptyAnswers([...qs]);
    expect(answersValid([...qs], a)).toBe(true);
    a[1]!.value = 'Z';
    expect(answersValid([...qs], a)).toBe(false);
    a[1]!.value = 'A';
    a[2]!.value = ['Mon'];
    expect(answersValid([...qs], a)).toBe(true);
  });
});

// --- Mounted form with a scratch KIT ---------------------------------------

vi.mock('src/generated/kit', () => ({
  KIT: {
    brand: { name: 'Test Community' },
    onboarding: {
      profile: {
        fields: { photo: true, email: false, bio: true, location: true, whyJoin: true, interests: true },
        customQuestions: [{ type: 'select', label: 'Marae', options: ['A', 'B'] }],
        interestOptions: ['Kai', 'Art and Designs'],
      },
    },
  },
}));

// The identity/KERI/api modules pull Quasar + signify; stub them so the mount
// stays a pure template test (nothing under test calls them on mount/render).
vi.mock('stores/identity', () => ({
  useIdentityStore: () => ({ isConnected: false, currentAID: null, error: null }),
}));
vi.mock('src/lib/keri/client', () => ({
  KERIClient: { passcodeFromMnemonic: () => '' },
  useKERIClient: () => ({}),
}));
vi.mock('src/lib/api/client', () => ({ uploadFile: vi.fn() }));

import ProfileFormScreen from 'src/components/onboarding/ProfileFormScreen.vue';

const Passthrough = defineComponent({ template: '<div><slot /></div>' });
const MInputStub = defineComponent({
  props: { modelValue: { type: String, default: '' }, id: { type: String, default: '' } },
  emits: ['update:modelValue'],
  template: `<input :id="id" :value="modelValue" @input="$emit('update:modelValue', $event.target.value)" />`,
});
const MBtnStub = defineComponent({
  props: { disabled: { type: Boolean, default: false } },
  template: `<button :disabled="disabled"><slot /></button>`,
});

function mountForm() {
  setActivePinia(createPinia());
  return mount(ProfileFormScreen, {
    global: {
      stubs: { OnboardingHeader: Passthrough, MInput: MInputStub, MBtn: MBtnStub },
    },
  });
}

describe('kit profile form', () => {
  it('omits the email field when the kit turns it off', () => {
    const wrapper = mountForm();
    expect(wrapper.find('#email').exists()).toBe(false);
    // A field the kit leaves on is still present.
    expect(wrapper.find('#name').exists()).toBe(true);
    wrapper.unmount();
  });

  it('aligns interest checkboxes with their single-line labels (issue #369)', () => {
    const wrapper = mountForm();
    // Kit interest options carry no description, so every row is single-line.
    // The checkbox must not carry a fixed two-line top margin (mt-5) that
    // would drop it below the label, and its row must centre the two.
    const rows = wrapper.findAll('input[type="checkbox"]');
    const interestBox = rows.find((r) =>
      (r.element as HTMLInputElement).value === 'kai',
    );
    expect(interestBox).toBeTruthy();
    expect(interestBox!.classes()).not.toContain('mt-5');
    const row = interestBox!.element.closest('label');
    expect(row?.className).toContain('items-center');
    wrapper.unmount();
  });

  it('renders a select custom question with its label', () => {
    const wrapper = mountForm();
    expect(wrapper.text()).toContain('A few questions from Test Community');
    const select = wrapper.find('#custom-question-0');
    expect(select.exists()).toBe(true);
    expect(select.element.tagName).toBe('SELECT');
    expect(wrapper.text()).toContain('Marae');
    // Options come from the kit question (blank + A + B).
    const opts = select.findAll('option').map((o) => o.text());
    expect(opts).toContain('A');
    expect(opts).toContain('B');
    wrapper.unmount();
  });
});
