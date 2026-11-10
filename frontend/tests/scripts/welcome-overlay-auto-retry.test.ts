// @vitest-environment happy-dom
/**
 * WelcomeOverlayScreen auto-retries the sync-wait gate (issue #506).
 *
 * A linked device that finishes pairing boots into the welcome overlay and runs
 * the recovery-style checks. When the backend answers the identity/set POST
 * with a retryable 503 ("… space not reachable"), or an adopted space is still
 * `spaceAccess:'pending'`, the screen enters `waitingForSync` and shows
 * "Waiting for your data to sync…". Before #506 that state was cleared ONLY by
 * the manual Retry button, so a device waiting on a slow-but-eventual cold
 * space pull hung forever.
 *
 * These tests pin the fix: while waiting, the screen re-runs the checks on a
 * bounded exponential backoff (no human click), reaches the dashboard once the
 * backend eventually returns success, and stops after a ceiling of attempts
 * while keeping the manual Retry button.
 *
 * All of the component's collaborators (stores, KERI client, API client,
 * secure storage) are mocked so the flow is driven entirely by the mocked
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

// The wallet holds a valid Membership credential of the community's schema,
// issued to this device's AID (#615: the check now matches schema + holder,
// not merely "any credential").
const MEMBERSHIP_SCHEMA = 'ESchemaMembership0000000000000000000000000000';
vi.mock('src/lib/clientConfig', () => ({
  getMembershipSchemaSaid: async () => MEMBERSHIP_SCHEMA,
}));

vi.mock('src/lib/keri/client', () => ({
  useKERIClient: () => ({
    getSignifyClient: () => ({
      credentials: () => ({
        list: async () => [
          { sad: { d: 'cred-1', s: MEMBERSHIP_SCHEMA, a: { i: 'EAID-linked-device' } } },
        ],
      }),
    }),
  }),
}));

const RETRYABLE = { success: false, retryable: true, error: 'private space not reachable' };
const OK = { success: true, peerId: 'peer', privateSpaceId: 'sp' };

async function importComponent() {
  return (await import('src/components/onboarding/WelcomeOverlayScreen.vue')).default;
}

describe('WelcomeOverlayScreen auto-retry (#506)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    onboardingPath = 'link';
    hasPendingSpaceAccess = false;
    setBackendIdentity.mockReset();
    fetchUserSpaces.mockClear();
    verifyCommunityAccess.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-runs the checks on a backoff and reaches the dashboard with no manual click', async () => {
    // Two retryable 503s, then success — with no human clicking Retry.
    setBackendIdentity
      .mockResolvedValueOnce(RETRYABLE)
      .mockResolvedValueOnce(RETRYABLE)
      .mockResolvedValue(OK);

    const Component = await importComponent();
    const wrapper = mount(Component);

    // onMounted -> runRecoveryChecks -> identity sleep(300) -> backend check.
    await vi.advanceTimersByTimeAsync(400);
    expect(setBackendIdentity).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain('Waiting for your data to sync');
    expect(wrapper.find('.retry-btn').exists()).toBe(true);

    // No click. The backoff timer fires the retry (first delay ~2s) and the
    // second attempt is still retryable.
    await vi.advanceTimersByTimeAsync(3000);
    expect(setBackendIdentity).toHaveBeenCalledTimes(2);
    expect(wrapper.text()).toContain('Waiting for your data to sync');

    // The next backoff (~4s) fires the third attempt, which succeeds; the
    // remaining checks pass and the overlay leaves the waiting state.
    await vi.advanceTimersByTimeAsync(6000);
    expect(setBackendIdentity).toHaveBeenCalledTimes(3);
    expect(wrapper.find('.retry-btn').exists()).toBe(false);
    expect(wrapper.vm.allChecksPassed).toBe(true);

    wrapper.unmount();
  });

  it('bounds the auto-retry and keeps the manual Retry button after the ceiling', async () => {
    // Always retryable: the auto-retry must stop after a finite ceiling.
    setBackendIdentity.mockResolvedValue(RETRYABLE);

    const Component = await importComponent();
    const wrapper = mount(Component);

    // Advance well past the whole backoff schedule (2s+4s+8s+15s×9 ≈ 149s).
    await vi.advanceTimersByTimeAsync(400);
    await vi.advanceTimersByTimeAsync(400_000);

    const calls = setBackendIdentity.mock.calls.length;
    // 1 initial attempt + a bounded number of auto-retries — never unbounded.
    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThanOrEqual(13);

    // Advancing further must not produce more attempts (ceiling reached).
    await vi.advanceTimersByTimeAsync(400_000);
    expect(setBackendIdentity.mock.calls.length).toBe(calls);

    // The manual Retry button is still offered so the user is never stuck.
    expect(wrapper.find('.retry-btn').exists()).toBe(true);

    // Once the ceiling is reached the screen must stop claiming the data is
    // "syncing" and say plainly that it was not reachable (review of #507):
    // an exhausted backoff is an outcome, not a quiet halt behind a spinner.
    expect(wrapper.find('.sync-exhausted').exists()).toBe(true);
    expect(wrapper.text()).toContain("We couldn't reach your data after several attempts");
    expect(wrapper.text()).not.toContain('Waiting for your data to sync');

    // A manual click resets the backoff, clears the exhausted copy while the
    // checks re-run, and drives at least one more attempt.
    await wrapper.find('.retry-btn').trigger('click');
    await vi.advanceTimersByTimeAsync(3000);
    expect(setBackendIdentity.mock.calls.length).toBeGreaterThan(calls);
    expect(wrapper.find('.sync-exhausted').exists()).toBe(false);
    expect(wrapper.text()).toContain('Waiting for your data to sync');

    wrapper.unmount();
  });

  it('does not auto-retry in the recovery flow, where identity/set would fork a private space each time', async () => {
    // A recovering (not linking) device: identity/set succeeds (recovery mode
    // never 503s — it creates on a miss) but an adopted space is still
    // spaceAccess:'pending', so the screen enters the waiting state. Re-POSTing
    // identity/set unattended here would call CreateSpaceWithKeys on every tick
    // (#506 defect C), so only the manual Retry button may drive a retry.
    onboardingPath = 'recover';
    hasPendingSpaceAccess = true;
    setBackendIdentity.mockResolvedValue(OK);

    const Component = await importComponent();
    const wrapper = mount(Component);

    await vi.advanceTimersByTimeAsync(400);
    expect(setBackendIdentity).toHaveBeenCalledTimes(1);
    expect(wrapper.text()).toContain('Waiting for your data to sync');
    expect(wrapper.find('.retry-btn').exists()).toBe(true);

    // No timer-driven retries, however long we wait.
    await vi.advanceTimersByTimeAsync(400_000);
    expect(setBackendIdentity).toHaveBeenCalledTimes(1);
    expect(wrapper.find('.sync-exhausted').exists()).toBe(false);

    // The manual button still re-runs the checks.
    await wrapper.find('.retry-btn').trigger('click');
    await vi.advanceTimersByTimeAsync(400);
    expect(setBackendIdentity).toHaveBeenCalledTimes(2);

    wrapper.unmount();
  });

  it('tears the auto-retry timer down on unmount', async () => {
    setBackendIdentity.mockResolvedValue(RETRYABLE);

    const Component = await importComponent();
    const wrapper = mount(Component);

    await vi.advanceTimersByTimeAsync(400);
    expect(setBackendIdentity).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    wrapper.unmount();
    await vi.advanceTimersByTimeAsync(400_000);
    // Nothing fired after unmount: no leaked backoff timer re-POSTing identity/set.
    expect(setBackendIdentity).toHaveBeenCalledTimes(1);
  });
});
