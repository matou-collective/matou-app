// @vitest-environment happy-dom
/**
 * Client-side validation of schema-driven custom fields (issue #402, review
 * follow-up on PR #403).
 *
 * TypedForm exposes `validate()`, but a parent-owned save is only protected if
 * the parent actually calls it. These tests mount the two surfaces that embed
 * TypedForm — AccountSettingsPage (SharedProfile) and CreateNoticeDialog
 * (Notice) — with a schema carrying a *required* custom field, and prove that
 * an empty required custom field blocks the save/submit with an inline error,
 * and that filling it lets the save through with the custom value attached.
 *
 * Runs under happy-dom. Every store/composable the pages touch is stubbed so
 * the mounts stay template tests; only the types store + TypedForm are real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { defineComponent } from 'vue';
import type { TypeDefinition } from 'src/lib/api/client';

const PROFILE_DEF: TypeDefinition = {
  name: 'SharedProfile',
  version: 1,
  description: '',
  space: 'community',
  fields: [
    { name: 'aid', type: 'string', core: true, readOnly: true },
    { name: 'displayName', type: 'string', core: true, required: true },
    { name: 'bio', type: 'string' },
    { name: 'iwi', type: 'string', required: true, uiHints: { label: 'Iwi', inputType: 'text' } },
  ],
  layouts: { form: { fields: ['displayName', 'bio', 'iwi'] } },
  permissions: { read: 'community', write: 'owner' },
};

const NOTICE_DEF: TypeDefinition = {
  name: 'Notice',
  version: 1,
  description: '',
  space: 'community',
  fields: [
    { name: 'title', type: 'string', core: true, required: true },
    { name: 'summary', type: 'string', core: true, required: true },
    { name: 'type', type: 'string', core: true },
    { name: 'region', type: 'string', required: true, uiHints: { label: 'Region', inputType: 'text' } },
  ],
  layouts: { form: { fields: ['title', 'summary', 'region'] } },
  permissions: { read: 'community', write: 'steward' },
};

const spies = vi.hoisted(() => ({
  saveProfile: vi.fn(async () => ({ success: true })),
  handleCreateNotice: vi.fn(async () => ({ success: true })),
}));

vi.mock('src/lib/api/client', () => ({
  getTypeDefinitions: vi.fn(async () => [PROFILE_DEF, NOTICE_DEF]),
  getTypeDefinition: vi.fn(async () => PROFILE_DEF),
  uploadFile: vi.fn(),
  getFileUrl: (r: string) => r,
}));

// --- AccountSettingsPage collaborators ---------------------------------------
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }));
vi.mock('stores/profiles', () => ({
  useProfilesStore: () => ({
    getMyProfile: (type: string) =>
      type === 'SharedProfile'
        ? { id: 'profile-1', type, data: { aid: 'EAdmin', displayName: 'Test User', bio: 'hi' } }
        : undefined,
    loadMyProfiles: async () => undefined,
    saveProfile: spies.saveProfile,
  }),
}));
vi.mock('stores/identity', () => ({ useIdentityStore: () => ({ aidPrefix: 'EAdmin' }) }));
vi.mock('stores/notifications', () => ({
  useNotificationsStore: () => ({
    pushEnabled: false,
    isChannelMuted: () => false,
    setPushEnabled: vi.fn(),
    toggleChannelMute: vi.fn(),
  }),
}));
vi.mock('stores/chat', () => ({
  useChatStore: () => ({ channels: [], sortedChannels: [], loadChannels: async () => undefined }),
}));
vi.mock('src/stores/rolePolicy', () => ({ useRolePolicyStore: () => ({ can: () => false }) }));
vi.mock('stores/onboarding', () => ({ PARTICIPATION_INTERESTS: [] }));
vi.mock('src/composables/useIsMobile', async () => {
  const { ref } = await import('vue');
  return { useIsMobile: () => ref(false) };
});
vi.mock('src/composables/usePush', () => ({ applyPushEnabled: vi.fn() }));

// --- CreateNoticeDialog collaborators ----------------------------------------
vi.mock('stores/activity', () => ({
  useActivityStore: () => ({ handleCreateNotice: spies.handleCreateNotice }),
}));
vi.mock('src/composables/noticeTypes', () => ({
  eventsEnabled: () => false,
  defaultNoticeType: () => 'announcement',
}));

import AccountSettingsPage from 'src/pages/AccountSettingsPage.vue';
import CreateNoticeDialog from 'src/components/activity/CreateNoticeDialog.vue';

const Passthrough = defineComponent({ template: '<div><slot /></div>' });

describe('AccountSettingsPage gates save on custom-field validation', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    spies.saveProfile.mockClear();
  });

  async function mountPage() {
    const wrapper = mount(AccountSettingsPage, {
      global: { stubs: { ReportIssueDialog: Passthrough } },
    });
    await flushPromises();
    await wrapper.vm.$nextTick();
    return wrapper;
  }

  it('an empty required custom field blocks the save with an inline error', async () => {
    const wrapper = await mountPage();
    const section = wrapper.find('[data-test="custom-fields-section"]');
    expect(section.exists()).toBe(true);
    const iwi = section.find('#iwi');
    expect(iwi.exists()).toBe(true);

    // Edit a built-in field so the unsaved bar appears; leave `iwi` empty.
    await wrapper.find('textarea[placeholder="Tell us about yourself"]').setValue('new bio');
    const save = wrapper.find('.btn-save');
    expect(save.exists()).toBe(true);
    await save.trigger('click');
    await flushPromises();

    expect(spies.saveProfile).not.toHaveBeenCalled();
    expect(section.find('.field-error').exists()).toBe(true);
    expect(section.find('.field-error').text()).toMatch(/Iwi is required/);
    wrapper.unmount();
  });

  it('does not report unsaved changes on load when a custom field has no stored value', async () => {
    // TypedForm seeds an unset string field to '' and emits it up through
    // v-model on mount; the page's snapshot must agree so a freshly opened
    // page is not marked dirty before the user touched anything.
    const wrapper = await mountPage();
    expect(wrapper.find('[data-test="custom-fields-section"] #iwi').exists()).toBe(true);
    expect(wrapper.find('.unsaved-bar').exists()).toBe(false);
    wrapper.unmount();
  });

  it('discarding changes resets the custom field input to its saved value', async () => {
    const wrapper = await mountPage();
    const iwi = wrapper.find('[data-test="custom-fields-section"] #iwi');
    await iwi.setValue('Ngāti Draft');
    expect(wrapper.find('.unsaved-bar').exists()).toBe(true);

    await wrapper.find('.btn-discard').trigger('click');
    await flushPromises();
    await wrapper.vm.$nextTick();

    expect((iwi.element as HTMLInputElement).value).toBe('');
    expect(wrapper.find('.unsaved-bar').exists()).toBe(false);
    wrapper.unmount();
  });

  it('a filled required custom field saves with the value attached', async () => {
    const wrapper = await mountPage();
    const section = wrapper.find('[data-test="custom-fields-section"]');
    await section.find('#iwi').setValue('Ngāti Test');
    await wrapper.find('.btn-save').trigger('click');
    await flushPromises();

    expect(spies.saveProfile).toHaveBeenCalledTimes(1);
    const [type, data] = spies.saveProfile.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(type).toBe('SharedProfile');
    expect(data.iwi).toBe('Ngāti Test');
    expect(section.find('.field-error').exists()).toBe(false);
    wrapper.unmount();
  });
});

describe('CreateNoticeDialog gates submit on custom-field validation', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    spies.handleCreateNotice.mockClear();
  });

  async function mountDialog() {
    const wrapper = mount(CreateNoticeDialog, {
      global: { stubs: { FileUploadInput: Passthrough } },
    });
    await flushPromises();
    await wrapper.vm.$nextTick();
    return wrapper;
  }

  it('an empty required custom field blocks the submit with an inline error', async () => {
    const wrapper = await mountDialog();
    const section = wrapper.find('[data-test="custom-notice-fields"]');
    expect(section.exists()).toBe(true);
    expect(section.find('#region').exists()).toBe(true);

    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(spies.handleCreateNotice).not.toHaveBeenCalled();
    expect(section.find('.field-error').text()).toMatch(/Region is required/);
    wrapper.unmount();
  });

  it('a filled required custom field submits with the value attached', async () => {
    const wrapper = await mountDialog();
    await wrapper.find('[data-test="custom-notice-fields"] #region').setValue('Te Tai Tokerau');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(spies.handleCreateNotice).toHaveBeenCalledTimes(1);
    const [req] = spies.handleCreateNotice.mock.calls[0] as unknown as [{ data?: Record<string, unknown> }];
    expect(req.data).toEqual({ region: 'Te Tai Tokerau' });
    wrapper.unmount();
  });
});
