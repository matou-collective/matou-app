// @vitest-environment happy-dom
/**
 * Community Settings roles tables gate on the kit's features (#621).
 *
 * The Roles section renders a permission table per feature area. Before this
 * change every table rendered regardless of what the build's kit turned on.
 * Now each feature table renders only when its feature is on in KIT.features
 * (the same source the nav reads), while the always-on rows (Community,
 * Community roles, Org details) stay put. Two invariants must hold when a
 * feature is off:
 *   • Community roles doesn't grow — a disabled feature's capabilities are
 *     still excluded from the generic table (never reappear as columns).
 *   • Hidden isn't deleted — grants for a hidden feature's capabilities are
 *     saved back unchanged, so turning the feature on later shows them intact.
 *
 * This mounts the page under a feature set with projects+proposals off and
 * asserts the gated sections are absent, the Community-roles columns are the
 * same as with every feature on, and Save sends the hidden features' stored
 * grants back untouched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { defineComponent } from 'vue';
import { setActivePinia, createPinia } from 'pinia';

// A single mutable feature object shared with the KIT mock: tests flip
// individual flags before each mount to drive the page.
const { kitFeatures } = vi.hoisted(() => ({
  kitFeatures: {
    identity: true,
    chat: true,
    projects: true,
    proposals: true,
    notices: true,
    events: true,
    maramataka: true,
    order: [] as string[],
  },
}));
function setFeatures(overrides: Partial<typeof kitFeatures>) {
  Object.assign(kitFeatures, {
    identity: true,
    chat: true,
    projects: true,
    proposals: true,
    notices: true,
    events: true,
    maramataka: true,
    order: [],
  });
  Object.assign(kitFeatures, overrides);
}

vi.mock('src/generated/kit', () => ({
  KIT: { features: kitFeatures, brand: { name: 'Test Community' } },
}));
vi.mock('src/lib/api/communitySettings', () => ({
  checkCommunitySettingsAccess: vi.fn().mockResolvedValue(true),
}));
vi.mock('src/api/config', () => ({
  fetchOrgConfig: vi.fn().mockResolvedValue({
    status: 'configured',
    config: { organization: { aid: 'a', name: 'Org', oobi: '' }, admins: [], generated: '' },
  }),
  saveOrgConfig: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('quasar', () => ({ useQuasar: () => ({ notify: vi.fn() }) }));
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {} }),
  useRouter: () => ({ replace: vi.fn() }),
}));
vi.mock('src/stores/types', () => ({
  useTypesStore: () => ({
    loaded: true,
    loading: false,
    definitions: new Map(),
    loadDefinitions: vi.fn(),
  }),
}));
vi.mock('src/lib/api/rolePolicy', async (orig) => {
  const actual = await orig<typeof import('src/lib/api/rolePolicy')>();
  return { ...actual, fetchRolePolicy: vi.fn(), updateRolePolicy: vi.fn() };
});

import CommunitySettingsPage from 'src/pages/Dashboard/CommunitySettingsPage.vue';
import { fetchRolePolicy, updateRolePolicy } from 'src/lib/api/rolePolicy';

// A policy carrying grants for every feature area so the "hidden isn't
// deleted" invariant has something to preserve.
const ORIGINAL_GRANTS: Record<string, string[]> = {
  member: ['send_messages', 'contribute', 'create_proposals', 'post_notices'],
  kaitiaki: ['manage_roles', 'manage_projects', 'manage_governance', 'manage_communications'],
  project_steward: ['contribute', 'sign_off'],
};

function policyResponse() {
  return {
    policy: {
      version: 3,
      roles: [
        { id: 'member', displayName: 'Member', builtin: true, scope: 'community' },
        { id: 'kaitiaki', displayName: 'Kaitiaki', builtin: false, scope: 'community' },
        {
          id: 'project_steward',
          displayName: 'Project Steward',
          builtin: true,
          scope: 'project',
        },
      ],
      // Deep-copy so a test mutating editableGrants can't touch the baseline.
      grants: JSON.parse(JSON.stringify(ORIGINAL_GRANTS)) as Record<string, string[]>,
    },
    source: 'synced' as const,
    capabilities: {
      open_community_settings: [],
      manage_community_settings: [],
      manage_members: [],
      manage_roles: [],
      manage_communications: [],
      endorse_members: [],
      contribute: [],
      manage_projects: [],
      sign_off: [],
      create_proposals: [],
      manage_governance: [],
      send_messages: [],
      manage_channels: [],
      moderate_messages: [],
      post_notices: [],
      manage_notices: [],
    },
    capabilityOrder: [
      'open_community_settings',
      'manage_community_settings',
      'manage_members',
      'manage_roles',
      'manage_communications',
      'endorse_members',
      'contribute',
      'manage_projects',
      'sign_off',
      'create_proposals',
      'manage_governance',
      'send_messages',
      'manage_channels',
      'moderate_messages',
      'post_notices',
      'manage_notices',
    ],
    projectCapabilities: ['contribute', 'manage_projects', 'sign_off'],
    // manage_roles present so the caller can manage roles (toggles enabled).
    callerCapabilities: ['manage_roles'],
    capabilityMeta: [
      { id: 'contribute', displayName: 'Contribute', group: 'Projects & Contributions', scope: 'project' },
      { id: 'manage_projects', displayName: 'Manage projects', group: 'Projects & Contributions', scope: 'project' },
      { id: 'sign_off', displayName: 'Sign off', group: 'Projects & Contributions', scope: 'project' },
      { id: 'send_messages', displayName: 'Send messages', group: 'Chat', scope: 'community' },
      { id: 'manage_channels', displayName: 'Manage channels', group: 'Chat', scope: 'community' },
      { id: 'moderate_messages', displayName: 'Moderate messages', group: 'Chat', scope: 'community' },
      { id: 'post_notices', displayName: 'Post notices', group: 'Notices', scope: 'community' },
      { id: 'manage_notices', displayName: 'Manage notices', group: 'Notices', scope: 'community' },
      { id: 'manage_communications', displayName: 'Communications', group: 'Community', scope: 'community' },
      { id: 'endorse_members', displayName: 'Endorse members', group: 'Community', scope: 'community' },
    ],
  };
}

const Pass = defineComponent({ template: '<div><slot /></div>' });
const QToggle = defineComponent({
  props: {
    modelValue: { type: Boolean, default: false },
    disable: { type: Boolean, default: false },
  },
  emits: ['update:modelValue'],
  template: `<button class="qtoggle" :data-on="modelValue" :disabled="disable"
               @click="$emit('update:modelValue', !modelValue)"><slot /></button>`,
});

const STUBS = {
  QToggle,
  QTooltip: { template: '<span />' },
  QBanner: Pass,
  QMarkupTable: Pass,
  QBtnToggle: { template: '<div />' },
  QBadge: Pass,
  QDialog: Pass,
  QCard: Pass,
  QCardSection: Pass,
  QCardActions: Pass,
  QInput: { template: '<input />' },
  QSelect: { template: '<div />' },
  QBtn: Pass,
};

async function mountPage() {
  setActivePinia(createPinia());
  vi.mocked(fetchRolePolicy).mockResolvedValue(policyResponse());
  vi.mocked(updateRolePolicy).mockImplementation(async (u) => ({
    version: u.version,
    roles: u.roles,
    grants: u.grants,
  }));
  const wrapper = mount(CommunitySettingsPage, {
    global: { stubs: STUBS, directives: { 'close-popup': {} } },
  });
  await flushPromises();
  await flushPromises();
  return wrapper;
}

// The header th labels of one table, minus the leading "Role" column.
function columnLabels(wrapper: ReturnType<typeof mount>, tableClass: string): string[] {
  return wrapper
    .findAll(`.roles-matrix.${tableClass} thead th`)
    .map((th) => th.text().trim())
    .slice(1);
}

describe('community settings feature tables (#621)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hides a disabled feature\'s tables and keeps the always-on ones', async () => {
    setFeatures({ projects: false, proposals: false, chat: true, notices: true });
    const wrapper = await mountPage();

    // Always-on sections stay.
    expect(wrapper.find('.community-permissions-section').exists()).toBe(true);
    expect(wrapper.find('.community-section').exists()).toBe(true);
    expect(wrapper.find('.org-section').exists()).toBe(true);

    // Enabled features render (and carry their data-feature marker).
    expect(wrapper.find('.chat-section[data-feature="chat"]').exists()).toBe(true);
    expect(wrapper.find('.notices-section[data-feature="notices"]').exists()).toBe(true);

    // Disabled features are absent — table and its heading gone.
    expect(wrapper.find('.projects-section').exists()).toBe(false);
    expect(wrapper.find('.project-section').exists()).toBe(false);
    expect(wrapper.find('.proposals-section').exists()).toBe(false);

    wrapper.unmount();
  });

  it('shows every table when every feature is on, each feature-gated one marked', async () => {
    setFeatures({});
    const wrapper = await mountPage();

    expect(wrapper.find('.community-permissions-section').exists()).toBe(true);
    expect(wrapper.find('.community-section').exists()).toBe(true);
    expect(wrapper.find('.org-section').exists()).toBe(true);
    expect(wrapper.find('.projects-section[data-feature="projects"]').exists()).toBe(true);
    expect(wrapper.find('.project-section[data-feature="projects"]').exists()).toBe(true);
    expect(wrapper.find('.proposals-section[data-feature="proposals"]').exists()).toBe(true);
    expect(wrapper.find('.chat-section[data-feature="chat"]').exists()).toBe(true);
    expect(wrapper.find('.notices-section[data-feature="notices"]').exists()).toBe(true);

    wrapper.unmount();
  });

  it('keeps the Community-roles columns identical whether features are on or off', async () => {
    setFeatures({});
    const allOn = await mountPage();
    const columnsAllOn = columnLabels(allOn, 'community-roles');
    allOn.unmount();

    setFeatures({ projects: false, proposals: false, chat: false, notices: false });
    const someOff = await mountPage();
    const columnsSomeOff = columnLabels(someOff, 'community-roles');
    someOff.unmount();

    // The generic table excludes feature-owned capabilities regardless of
    // whether the feature is on, so a disabled feature never adds a column.
    expect(columnsSomeOff).toEqual(columnsAllOn);
    // And it is the community-only, non-feature capabilities that show.
    expect(columnsAllOn).toEqual(['Communications', 'Endorse members']);
  });

  it('saves a hidden feature\'s stored grants back unchanged', async () => {
    setFeatures({ projects: false, proposals: false, chat: true, notices: true });
    const wrapper = await mountPage();

    // Make an edit in a visible table so Save enables: flip the first chat toggle.
    const chatToggle = wrapper.find('.chat-section .qtoggle');
    expect(chatToggle.exists()).toBe(true);
    await chatToggle.trigger('click');
    await flushPromises();

    // Click the Roles-section Save button (the header action, not org save).
    const saveBtn = wrapper.find('.cs-actions button');
    expect(saveBtn.exists()).toBe(true);
    expect((saveBtn.element as HTMLButtonElement).disabled).toBe(false);
    await saveBtn.trigger('click');
    await flushPromises();

    expect(updateRolePolicy).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(updateRolePolicy).mock.calls[0]![0];

    // Grants for the hidden features (projects + proposals) must be byte-for-byte
    // what was stored — hiding a table never drops or resets its grants.
    const hiddenCaps = new Set([
      'contribute',
      'manage_projects',
      'sign_off',
      'create_proposals',
      'manage_governance',
    ]);
    const restrict = (g: Record<string, string[]>) =>
      Object.fromEntries(
        Object.entries(g).map(([r, caps]) => [r, [...caps].filter((c) => hiddenCaps.has(c)).sort()]),
      );
    expect(restrict(sent.grants)).toEqual(restrict(ORIGINAL_GRANTS));

    wrapper.unmount();
  });
});
