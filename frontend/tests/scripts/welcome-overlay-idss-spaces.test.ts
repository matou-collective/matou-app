// @vitest-environment happy-dom
/**
 * WelcomeOverlayScreen recovery reads the community's space IDs from the IDSS
 * descriptor (issue #645).
 *
 * On an IDSS backend the three any-sync space IDs live in the descriptor's
 * `anysync` block, NOT in the OrgConfig the wallet derives from the descriptor's
 * `community` block. Before #645 the recovery path read them from orgConfig
 * (always `undefined` on IDSS), so set-identity joined no community space and
 * the welcome checks dead-ended at "No community space found — your backend may
 * need reconfiguration" until a restart let the boot restore path pick the IDs
 * up.
 *
 * These tests pin the fix: on an IDSS descriptor that records the three spaces,
 * the recovery path passes exactly those IDs to set-identity and the checks
 * pass with no restart; on an IDSS descriptor that records none (the founding-
 * ceremony state), the community failure says "still being set up", not
 * "reconfigure your backend".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount } from '@vue/test-utils';

const setBackendIdentity = vi.fn();
const getSyncStatus = vi.fn(async () => ({
  community: { hasObjectTree: false, profileCount: 0 },
  readOnly: { hasObjectTree: false, profileCount: 0 },
}));
const getProfiles = vi.fn(async () => []);

vi.mock('src/lib/api/client', () => ({
  setBackendIdentity: (...a: unknown[]) => setBackendIdentity(...a),
  getSyncStatus: (...a: unknown[]) => getSyncStatus(...a),
  getProfiles: (...a: unknown[]) => getProfiles(...a),
}));

vi.mock('src/lib/secureStorage', () => ({
  secureStorage: { getItem: vi.fn(async () => 'test mnemonic phrase') },
}));

// The three IDs the whakatohea-demo descriptor records under `anysync`.
const RECORDED = {
  communitySpaceId: 'bafyreienvc-community-space-id',
  readOnlySpaceId: 'bafyreickyd-readonly-space-id',
  adminSpaceId: 'bafyreia2rh-admin-space-id',
};

let verifyResult = true;
let anysync: Record<string, unknown> = { ...RECORDED };

const fetchUserSpaces = vi.fn(async () => {});
const verifyCommunityAccess = vi.fn(async () => verifyResult);
vi.mock('stores/identity', () => ({
  useIdentityStore: () => ({
    hasIdentity: true,
    currentAID: { prefix: 'EI5am6mv-recovered-aid', name: 'Founder' },
    hasPendingSpaceAccess: false,
    fetchUserSpaces,
    verifyCommunityAccess,
  }),
}));

vi.mock('stores/onboarding', () => ({
  useOnboardingStore: () => ({
    onboardingPath: 'recover',
    profile: { name: 'Founder' },
  }),
}));

// An IDSS backend: isIdssBackend true, and orgConfig (derived from the
// descriptor's `community` block) carries NO space IDs — they live in `anysync`.
vi.mock('stores/app', () => ({
  useAppStore: () => ({
    orgAid: 'EEPniUBM-org-aid',
    orgConfig: { organization: { aid: 'EEPniUBM-org-aid', name: 'Whakatohea', oobi: '' } },
    isIdssBackend: true,
  }),
}));

const MEMBERSHIP_SCHEMA = 'ESchemaMembership0000000000000000000000000000';
vi.mock('src/lib/clientConfig', () => ({
  getMembershipSchemaSaid: async () => MEMBERSHIP_SCHEMA,
  getCommunityDescriptor: async () => ({
    version: '1.1',
    backend_kind: 'idss',
    admins: [],
    schemas: { membership: { said: MEMBERSHIP_SCHEMA, oobi: '' } },
    community: { name: 'Whakatohea', slug: 'whakatohea', aid: 'EEPniUBM-org-aid', oobi: '', registry: 'EReg' },
    anysync,
  }),
}));

vi.mock('src/lib/keri/client', () => ({
  useKERIClient: () => ({
    getSignifyClient: () => ({
      credentials: () => ({
        list: async () => [
          { sad: { d: 'cred-1', s: MEMBERSHIP_SCHEMA, a: { i: 'EI5am6mv-recovered-aid' } } },
        ],
      }),
    }),
  }),
}));

const OK = { success: true, peerId: 'peer', privateSpaceId: 'sp' };

async function importComponent() {
  return (await import('src/components/onboarding/WelcomeOverlayScreen.vue')).default;
}

describe('WelcomeOverlayScreen recovery on an IDSS backend (#645)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    verifyResult = true;
    anysync = { ...RECORDED };
    setBackendIdentity.mockReset();
    setBackendIdentity.mockResolvedValue(OK);
    fetchUserSpaces.mockClear();
    verifyCommunityAccess.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes the descriptor-recorded space IDs to set-identity and the checks pass with no restart', async () => {
    const Component = await importComponent();
    const wrapper = mount(Component);

    // onMounted -> runRecoveryChecks -> identity sleep(300) -> backend check.
    await vi.advanceTimersByTimeAsync(400);

    expect(setBackendIdentity).toHaveBeenCalledTimes(1);
    expect(setBackendIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        aid: 'EI5am6mv-recovered-aid',
        communitySpaceId: RECORDED.communitySpaceId,
        readOnlySpaceId: RECORDED.readOnlySpaceId,
        adminSpaceId: RECORDED.adminSpaceId,
      }),
    );

    // Community + credential checks then pass — the dashboard opens, no restart.
    await vi.advanceTimersByTimeAsync(1000);
    expect(wrapper.vm.allChecksPassed).toBe(true);

    wrapper.unmount();
  });

  it('reports the founding-ceremony state, not a backend fault, when the descriptor records no spaces', async () => {
    // No recorded spaces (founding-ceremony state, idss #1867) and community
    // access cannot be verified.
    anysync = {};
    verifyResult = false;

    const Component = await importComponent();
    const wrapper = mount(Component);

    await vi.advanceTimersByTimeAsync(400);
    // set-identity is still called, with no space IDs.
    expect(setBackendIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        communitySpaceId: undefined,
        readOnlySpaceId: undefined,
        adminSpaceId: undefined,
      }),
    );

    // Community check retries with backoff (6 attempts × ~2s) then fails.
    await vi.advanceTimersByTimeAsync(15000);
    expect(wrapper.text()).toContain('still being set up by its stewards');
    expect(wrapper.text()).not.toContain('your backend may need reconfiguration');

    wrapper.unmount();
  });
});
