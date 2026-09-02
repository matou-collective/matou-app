// @vitest-environment happy-dom
/**
 * The org setup screen is pre-filled from the kit (coa-kit plan Task 5, issue #241).
 *
 * The organisation name is fixed by the kit — the screen no longer asks for it
 * and only collects the first admin's profile. This mounts OrgSetupScreen and
 * asserts:
 *   - there is no "Organization Name" input,
 *   - the heading names the kit (KIT.brand.name),
 *   - the submit button stays disabled until an admin name is typed.
 *
 * useOrgSetup and the api client are stubbed so the mount stays a pure template
 * test. The base MInput/MBtn wrappers are stubbed with plain input/button so
 * the test does not need the Quasar plugin (its server build breaks under
 * happy-dom) — the disabled logic under test lives in OrgSetupScreen itself.
 */
import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent } from 'vue';
import { KIT } from 'src/generated/kit';

vi.mock('src/composables/useOrgSetup', async () => {
  const { ref } = await import('vue');
  return {
    useOrgSetup: () => ({
      isSubmitting: ref(false),
      error: ref<string | null>(null),
      progress: ref(''),
      setupOrg: vi.fn(),
    }),
  };
});

vi.mock('src/lib/api/client', () => ({
  uploadFile: vi.fn(),
}));

import OrgSetupScreen from 'src/components/setup/OrgSetupScreen.vue';

// Lightweight stand-ins for the Quasar-backed base components. MInput exposes a
// v-model'd <input>; MBtn a <button :disabled> so fall-through class/type land
// on a real element.
const MInputStub = defineComponent({
  props: { modelValue: { type: String, default: '' } },
  emits: ['update:modelValue'],
  template: `<input :value="modelValue" @input="$emit('update:modelValue', $event.target.value)" />`,
});
const MBtnStub = defineComponent({
  props: { disabled: { type: Boolean, default: false } },
  template: `<button :disabled="disabled"><slot /></button>`,
});

function mountScreen() {
  return mount(OrgSetupScreen, {
    global: { stubs: { MInput: MInputStub, MBtn: MBtnStub } },
  });
}

describe('kit setup screen', () => {
  it('has no "Organization Name" input', () => {
    const wrapper = mountScreen();
    expect(wrapper.text()).not.toContain('Organization Name');
    // Only admin-profile inputs remain: admin name + optional email
    // (the avatar file input is separate).
    const inputs = wrapper
      .findAll('input')
      .filter((i) => (i.attributes('type') ?? 'text') !== 'file');
    expect(inputs.length).toBe(2);
    wrapper.unmount();
  });

  it('heading names the kit', () => {
    const wrapper = mountScreen();
    expect(wrapper.get('h1').text()).toContain(KIT.brand.name);
    wrapper.unmount();
  });

  it('submit is disabled until an admin name is typed', async () => {
    const wrapper = mountScreen();
    const submit = wrapper.get('button.submit-btn');

    // Disabled with no admin name.
    expect(submit.attributes('disabled')).toBeDefined();

    // Typing a valid admin name enables it.
    await wrapper.get('input').setValue('Admin User');
    expect(submit.attributes('disabled')).toBeUndefined();

    wrapper.unmount();
  });
});
