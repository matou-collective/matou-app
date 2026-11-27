/**
 * Regression test for #610 — an IDSS-backed app never founds, it can only join
 * (ADR 0226 decision 3). So a missing org identity on an IDSS backend (roster
 * not yet written, /api/config momentarily 404'ing) must NOT drop the app into
 * the first-admin setup flow: the app store surfaces `backend_provisioning`
 * (never `not_configured`), `needsSetup` stays false, and initializeApp lands on
 * welcome/join with a "being set up by its stewards" message rather than /setup.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// The org-config fetch result — mutable per test.
const fetchOrgConfig = vi.fn();
// The community backend descriptor — carries backend_kind. Mutable per test.
const getCommunityDescriptor = vi.fn();

vi.mock('src/api/config', () => ({
  fetchOrgConfig: () => fetchOrgConfig(),
  getCachedConfig: vi.fn(async () => null),
}));

vi.mock('src/lib/clientConfig', () => ({
  getCommunityDescriptor: () => getCommunityDescriptor(),
}));

// Boot-only dependencies (mirrors backend-start-boot-guard.test.ts).
const initBackendUrl = vi.fn(async () => undefined);
const initApiToken = vi.fn(async () => undefined);
const installBackendAuth = vi.fn();

vi.mock('src/lib/api/client', () => ({
  initBackendUrl: () => initBackendUrl(),
  initApiToken: () => initApiToken(),
  installBackendAuth: () => installBackendAuth(),
  getBackendIdentity: vi.fn(),
  setBackendIdentity: vi.fn(),
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

import { useAppStore } from 'stores/app';
import { useOnboardingStore } from 'stores/onboarding';
import { useIdentityStore } from 'stores/identity';
import { initializeApp } from 'src/boot/keri';

const IDSS_DESCRIPTOR = { version: '1.1', backend_kind: 'idss', admins: [], schemas: {} };
const LEGACY_DESCRIPTOR = { version: '1.0', backend_kind: '', admins: [], schemas: {} };

describe('IDSS backend never routes to setup (#610)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('a 404 (not_configured) on an IDSS backend yields backend_provisioning, not needsSetup', async () => {
    getCommunityDescriptor.mockResolvedValue(IDSS_DESCRIPTOR);
    fetchOrgConfig.mockResolvedValue({ status: 'not_configured' });

    const app = useAppStore();
    await app.loadOrgConfig();

    expect(app.isIdssBackend).toBe(true);
    expect(app.configState).toBe('backend_provisioning');
    expect(app.isBackendProvisioning).toBe(true);
    // The router redirect to /setup keys off needsSetup — it must stay false.
    expect(app.needsSetup).toBe(false);
    expect(app.isConfigured).toBe(false);
  });

  it('a 404 on a non-IDSS backend still yields not_configured (legacy founding flow)', async () => {
    getCommunityDescriptor.mockResolvedValue(LEGACY_DESCRIPTOR);
    fetchOrgConfig.mockResolvedValue({ status: 'not_configured' });

    const app = useAppStore();
    await app.loadOrgConfig();

    expect(app.isIdssBackend).toBe(false);
    expect(app.needsSetup).toBe(true);
    expect(app.isBackendProvisioning).toBe(false);
  });

  it('initializeApp on a provisioning IDSS backend surfaces a wait message and never needsSetup', async () => {
    getCommunityDescriptor.mockResolvedValue(IDSS_DESCRIPTOR);
    fetchOrgConfig.mockResolvedValue({ status: 'not_configured' });

    const onboarding = useOnboardingStore();
    await expect(initializeApp()).resolves.toBeUndefined();

    const app = useAppStore();
    expect(app.needsSetup).toBe(false);
    expect(app.isBackendProvisioning).toBe(true);
    expect(onboarding.initializationError).toBe(
      'This community is being set up by its stewards — try again shortly.',
    );
    expect(onboarding.appState).toBe('ready');
    expect(useIdentityStore().isReady).toBe(true);
  });
});
