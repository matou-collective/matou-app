// @vitest-environment happy-dom
/**
 * WelcomeOverlayScreen offers Retry when a check fails outright (issue #570).
 *
 * A linking phone whose identity/set POST timed out showed a red "Backend
 * identity configured" and a disabled "Verifying..." button: the only way out
 * was force-closing the app. The waiting-for-sync state had a Retry button; a
 * hard failure did not.
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

// Per-test knobs read at store-construction time (the factories below are
// re-run on every vi.resetModules(), but the component reads these through the
// returned functions so a test can flip them before mounting).
let onboardingPath: 'link' | 'recover' = 'link';
let hasPendingSpaceAccess = false;

const fetchUserSpaces = vi.fn(async () => {});
const verifyCommunityAccess = vi.fn(async () => true);
vi.mock('stores/identity', () => ({
  useIdentityStore: () => ({
    hasIdentity: true,
    currentAID: { prefix: 'EAID-linked-device', name: 'Kaia' },
    get hasPendingSpaceAccess() {
      return hasPendingSpaceAccess;
    },
    fetchUserSpaces,
    verifyCommunityAccess,
  }),
}));

vi.mock('stores/onboarding', () => ({
  useOnboardingStore: () => ({
    get onboardingPath() {
      return onboardingPath;
    },
    profile: { name: 'Kaia' },
  }),
}));

vi.mock('stores/app', () => ({
  useAppStore: () => ({
    orgAid: 'EORG',
    orgConfig: { communitySpaceId: 'cs', readOnlySpaceId: 'ro', adminSpaceId: 'adm' },
  }),
}));

vi.mock('src/lib/keri/client', () => ({
  useKERIClient: () => ({
    getSignifyClient: () => ({
      credentials: () => ({ list: async () => [{ said: 'cred-1' }] }),
    }),
  }),
}));

const HARD_FAILURE = { success: false, error: 'Network error' };
const OK = { success: true, peerId: 'peer', privateSpaceId: 'sp' };

async function importComponent() {
  return (await import('src/components/onboarding/WelcomeOverlayScreen.vue')).default;
}

describe('WelcomeOverlayScreen Retry on a hard failure (#570)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    onboardingPath = 'link';
    hasPendingSpaceAccess = false;
    setBackendIdentity.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows Retry instead of a dead end, and a click re-runs the checks', async () => {
    setBackendIdentity.mockResolvedValueOnce(HARD_FAILURE).mockResolvedValue(OK);

    const Component = await importComponent();
    const wrapper = mount(Component);
    await vi.advanceTimersByTimeAsync(400);

    expect(wrapper.text()).toContain('Network error');
    expect(wrapper.find('.retry-failed-btn').exists()).toBe(true);
    expect(wrapper.find('.continue-btn').exists()).toBe(false);

    // A hard failure is never retried unattended.
    await vi.advanceTimersByTimeAsync(60000);
    expect(setBackendIdentity).toHaveBeenCalledTimes(1);

    await wrapper.find('.retry-failed-btn').trigger('click');
    await vi.advanceTimersByTimeAsync(2000);
    expect(setBackendIdentity).toHaveBeenCalledTimes(2);
    expect(wrapper.find('.retry-failed-btn').exists()).toBe(false);
    expect(wrapper.vm.allChecksPassed).toBe(true);
  });
});
