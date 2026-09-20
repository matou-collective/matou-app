// @vitest-environment happy-dom
/**
 * WelcomeOverlayScreen offers a Retry when the "Backend identity configured"
 * step hard-fails (issue #570 item 3).
 *
 * The retryable waitingForSync gate (a 503 / pending space access) already had a
 * Retry button. But when the backend identity check fails with a NON-retryable
 * error, the check row rendered as "failed" with no retry affordance — the only
 * way out was force-closing the app. These tests pin the fix: a hard backend
 * failure shows a working Retry control that re-runs the checks, and a
 * subsequent success drives the overlay to the ready state.
 *
 * All collaborators are mocked so the flow is driven entirely by the mocked
 * setBackendIdentity responses.
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

let onboardingPath: 'link' | 'recover' | 'returning' = 'recover';
const hasPendingSpaceAccess = false;

const fetchUserSpaces = vi.fn(async () => {});
const verifyCommunityAccess = vi.fn(async () => true);
vi.mock('stores/identity', () => ({
  useIdentityStore: () => ({
    hasIdentity: true,
    currentAID: { prefix: 'EAID-device', name: 'Kaia' },
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

const HARD_FAIL = { success: false, retryable: false, error: 'Backend identity setup failed' };
const OK = { success: true, peerId: 'peer', privateSpaceId: 'sp' };

async function importComponent() {
  return (await import('src/components/onboarding/WelcomeOverlayScreen.vue')).default;
}

describe('WelcomeOverlayScreen backend hard-fail Retry (#570)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    onboardingPath = 'recover';
    setBackendIdentity.mockReset();
    fetchUserSpaces.mockClear();
    verifyCommunityAccess.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a Retry when the backend identity step hard-fails, and it re-runs the checks', async () => {
    // First attempt hard-fails (non-retryable), then success on retry.
    setBackendIdentity.mockResolvedValueOnce(HARD_FAIL).mockResolvedValue(OK);

    const Component = await importComponent();
    const wrapper = mount(Component);

    // onMounted -> runRecoveryChecks -> identity sleep(300) -> backend check.
    await vi.advanceTimersByTimeAsync(400);
    expect(setBackendIdentity).toHaveBeenCalledTimes(1);

    // The backend check is a hard failure: a Retry is offered, and it is NOT the
    // retryable waitingForSync Retry (that one has class .retry-btn).
    expect(wrapper.find('.retry-failed-btn').exists()).toBe(true);
    expect(wrapper.find('.retry-btn').exists()).toBe(false);
    expect(wrapper.text()).toContain('Backend identity setup failed');
    expect(wrapper.vm.allChecksPassed).toBe(false);

    // Clicking Retry re-runs the checks from the top; this time they all pass.
    await wrapper.find('.retry-failed-btn').trigger('click');
    await vi.advanceTimersByTimeAsync(1000);

    expect(setBackendIdentity).toHaveBeenCalledTimes(2);
    expect(wrapper.find('.retry-failed-btn').exists()).toBe(false);
    expect(wrapper.vm.allChecksPassed).toBe(true);

    wrapper.unmount();
  });

  it('keeps the Retry available if the backend keeps hard-failing', async () => {
    setBackendIdentity.mockResolvedValue(HARD_FAIL);

    const Component = await importComponent();
    const wrapper = mount(Component);

    await vi.advanceTimersByTimeAsync(400);
    expect(wrapper.find('.retry-failed-btn').exists()).toBe(true);

    // A hard failure must not auto-retry (that is the waitingForSync gate's job).
    await vi.advanceTimersByTimeAsync(400_000);
    expect(setBackendIdentity).toHaveBeenCalledTimes(1);

    // Retry still there; clicking it drives another attempt.
    await wrapper.find('.retry-failed-btn').trigger('click');
    await vi.advanceTimersByTimeAsync(400);
    expect(setBackendIdentity).toHaveBeenCalledTimes(2);
    expect(wrapper.find('.retry-failed-btn').exists()).toBe(true);

    wrapper.unmount();
  });
});
