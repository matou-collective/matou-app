/**
 * Regression test for #128 — a backend-start failure at launch (mobile
 * `Mobile.start` cannot reach the any-sync coordinator) must NOT throw out of
 * boot and leave a blank WebView. initializeApp() catches it and surfaces the
 * "Connection Error — Try Again" splash (initialization error + app state
 * 'ready'), and the retry re-attempts the backend start.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// Backend URL/token init: the failing call at boot. Mutable per-test.
const initBackendUrl = vi.fn<[], Promise<void>>();
const initApiToken = vi.fn<[], Promise<void>>();
const installBackendAuth = vi.fn();

vi.mock('src/lib/api/client', () => ({
  initBackendUrl: () => initBackendUrl(),
  initApiToken: () => initApiToken(),
  installBackendAuth: () => installBackendAuth(),
  getBackendIdentity: vi.fn(),
  setBackendIdentity: vi.fn(),
  // Pulled in transitively by the identity store.
  getUserSpaces: vi.fn(),
  verifyCommunityAccess: vi.fn(),
  joinCommunity: vi.fn(),
  getAuthChallenge: vi.fn(),
  postAuthLogin: vi.fn(),
  setSessionToken: vi.fn(),
}));

vi.mock('src/lib/keri/client', () => ({
  KERIClient: class {},
  useKERIClient: () => ({ setOrgAID: vi.fn(), getSignifyClient: () => null }),
  initKeriConfig: vi.fn(async () => ({ mode: 'test' })),
}));

vi.mock('src/lib/secureStorage', () => ({
  secureStorage: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

vi.mock('src/api/config', () => ({
  fetchOrgConfig: vi.fn(),
}));

import { initializeApp } from 'src/boot/keri';
import { useOnboardingStore } from 'stores/onboarding';
import { useIdentityStore } from 'stores/identity';
import { useAppStore } from 'stores/app';

describe('initializeApp backend-start guard (#128)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    initApiToken.mockResolvedValue(undefined);
  });

  it('surfaces a backend-start failure as the retry splash instead of throwing', async () => {
    initBackendUrl.mockRejectedValue(
      new Error('Cannot connect to any-sync network: coordinator unreachable'),
    );

    const onboarding = useOnboardingStore();

    // Must resolve (not throw) — a throw is what left the WebView blank.
    await expect(initializeApp()).resolves.toBeUndefined();

    expect(onboarding.initializationError).toBe(
      'Cannot connect to any-sync network: coordinator unreachable',
    );
    expect(onboarding.appState).toBe('ready');
    expect(useIdentityStore().isReady).toBe(true);
  });

  it('retry after connectivity returns re-attempts the backend start and clears the error', async () => {
    // First attempt fails.
    initBackendUrl.mockRejectedValueOnce(new Error('coordinator unreachable'));
    const onboarding = useOnboardingStore();
    await initializeApp();
    expect(onboarding.initializationError).toBe('coordinator unreachable');

    // Connectivity restored: the next attempt succeeds. No saved session and no
    // org config → app becomes ready with the error cleared (entry splash).
    initBackendUrl.mockResolvedValue(undefined);
    const app = useAppStore();
    vi.spyOn(app, 'loadOrgConfig').mockResolvedValue({} as never);

    await initializeApp();

    // getBackendInfo memo does not cache failures, so the retry genuinely
    // re-invokes the backend start.
    expect(initBackendUrl).toHaveBeenCalledTimes(2);
    expect(onboarding.initializationError).toBeNull();
    expect(onboarding.appState).toBe('ready');
  });
});
