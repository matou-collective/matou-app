// @vitest-environment happy-dom
/**
 * Schema-driven custom fields (issue #402).
 *
 * Covers the reusable primitives that wire org-added (non-core) schema fields
 * into the bespoke profile surfaces:
 *  1. useTypesStore.customFieldNames — non-core fields not already rendered by a
 *     surface's built-in UI, in form-layout order.
 *  2. useTypesStore.filterableFieldNames — fields the schema marks filterable.
 *  3. TypedForm (embedded) — renders only the requested custom fields and
 *     two-way binds their values through v-model.
 *  4. TypedDisplay — renders a custom field's stored value.
 *
 * Runs under happy-dom. The api client is stubbed so the mounts stay template
 * tests (nothing under test uploads or fetches on render).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import type { TypeDefinition } from 'src/lib/api/client';

// A scratch SharedProfile-like definition: two core fields, the built-in `bio`,
// and two org-added custom fields (one plain, one filterable).
const DEF: TypeDefinition = {
  name: 'SharedProfile',
  version: 1,
  description: '',
  space: 'community',
  fields: [
    { name: 'aid', type: 'string', core: true, readOnly: true },
    { name: 'displayName', type: 'string', core: true },
    { name: 'bio', type: 'string' },
    { name: 'iwi', type: 'string', required: true, uiHints: { label: 'Iwi', inputType: 'text', filterable: true } },
    { name: 'marae', type: 'string', uiHints: { label: 'Marae', inputType: 'text' } },
  ],
  layouts: {
    form: { fields: ['displayName', 'bio', 'iwi', 'marae'] },
    detail: { fields: ['displayName', 'bio', 'iwi', 'marae'] },
  },
  permissions: { read: 'community', write: 'owner' },
};

vi.mock('src/lib/api/client', () => ({
  getTypeDefinitions: vi.fn(async () => [DEF]),
  getTypeDefinition: vi.fn(async () => DEF),
  uploadFile: vi.fn(),
  getFileUrl: (r: string) => r,
}));

import { useTypesStore } from 'stores/types';
import TypedForm from 'src/components/profiles/TypedForm.vue';
import TypedDisplay from 'src/components/profiles/TypedDisplay.vue';

// The built-in SharedProfile fields the bespoke forms render themselves.
const BUILTIN = ['displayName', 'bio', 'avatar'];

async function loadedStore() {
  const store = useTypesStore();
  await store.loadDefinitions();
  return store;
}

describe('types store custom-field helpers', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('customFieldNames returns only non-core, non-built-in fields in form order', async () => {
    const store = await loadedStore();
    expect(store.customFieldNames('SharedProfile', BUILTIN)).toEqual(['iwi', 'marae']);
  });

  it('customFieldNames excludes core fields even when not named as built-in', async () => {
    const store = await loadedStore();
    // `aid` is core → never surfaced as a custom field.
    expect(store.customFieldNames('SharedProfile', [])).not.toContain('aid');
    expect(store.customFieldNames('SharedProfile', [])).toContain('iwi');
  });

  it('filterableFieldNames returns fields flagged filterable', async () => {
    const store = await loadedStore();
    expect(store.filterableFieldNames('SharedProfile')).toEqual(['iwi']);
  });

  it('returns empty lists for an unknown type', async () => {
    const store = await loadedStore();
    expect(store.customFieldNames('Nope', BUILTIN)).toEqual([]);
    expect(store.filterableFieldNames('Nope')).toEqual([]);
  });
});

describe('TypedForm embedded custom fields', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('renders only the requested custom fields and syncs v-model', async () => {
    const store = await loadedStore();
    void store;
    const model: Record<string, unknown> = { iwi: 'Ngāti Test' };
    const wrapper = mount(TypedForm, {
      props: {
        typeName: 'SharedProfile',
        embedded: true,
        fields: ['iwi', 'marae'],
        modelValue: model,
        'onUpdate:modelValue': (v: Record<string, unknown>) => Object.assign(model, v),
      },
    });
    await wrapper.vm.$nextTick();

    // Only the two custom fields render — no submit button in embedded mode.
    const inputs = wrapper.findAll('input.field-input');
    expect(inputs).toHaveLength(2);
    expect(wrapper.find('.submit-btn').exists()).toBe(false);
    // Seeded from the bound model.
    expect((inputs[0].element as HTMLInputElement).value).toBe('Ngāti Test');

    // Editing the second field flows back up through v-model.
    await inputs[1].setValue('Test Marae');
    expect(model.marae).toBe('Test Marae');
    wrapper.unmount();
  });

  it('flags a required custom field left empty on validate()', async () => {
    const store = await loadedStore();
    void store;
    const wrapper = mount(TypedForm, {
      props: { typeName: 'SharedProfile', embedded: true, fields: ['iwi', 'marae'], modelValue: {} },
    });
    await wrapper.vm.$nextTick();
    // `iwi` is required; validate() should fail and surface an error.
    const ok = (wrapper.vm as unknown as { validate: () => boolean }).validate();
    expect(ok).toBe(false);
    await wrapper.vm.$nextTick();
    expect(wrapper.find('.field-error').exists()).toBe(true);
    wrapper.unmount();
  });
});

describe('TypedDisplay custom fields', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('renders the stored value of a custom field', async () => {
    const store = await loadedStore();
    void store;
    const wrapper = mount(TypedDisplay, {
      props: {
        typeName: 'SharedProfile',
        layout: 'detail',
        fields: ['iwi'],
        data: { iwi: 'Ngāti Display' },
      },
    });
    await wrapper.vm.$nextTick();
    expect(wrapper.text()).toContain('Iwi');
    expect(wrapper.text()).toContain('Ngāti Display');
    wrapper.unmount();
  });
});
