import { describe, it, expect, afterEach, vi } from 'vitest';

/**
 * fetchOrgConfig() sources org config from a different origin per platform
 * (issue #265): on Capacitor it must go only through the embedded backend's
 * loopback API — the WebView cannot reach the remote plain-http config server
 * (blocked as mixed content on both Android and iOS), and the backend fetches
 * it server-side. Non-Capacitor platforms keep their config-server fallback.
 *
 * The module reads CONFIG_SERVER_URL from clientConfig at load time, so each
 * case re-imports it fresh via vi.resetModules() with platform + secureStorage
 * + clientConfig mocked.
 */

const BACKEND_URL = 'http://127.0.0.1:41234';
const CONFIG_SERVER_URL = 'http://config.example:3904';

const FULL_CONFIG = {
  organization: { aid: 'EOrg', name: 'Loopback Org', oobi: '' },
  admins: [{ aid: 'EAdmin', name: 'Admin' }],
  registry: { id: 'EReg', name: 'reg' },
  generated: '2026-09-01',
};

// An IDSS gateway serves the community backend descriptor (ADR 0226) at
// /api/config — a `community` block plus `admins[]`, with NO `organization`.
// The wallet must derive an OrgConfig from it (issue #610).
const IDSS_DESCRIPTOR = {
  version: '1.1',
  backend_kind: 'idss',
  community: {
    name: 'WHAKATOHEA DEMO',
    slug: 'whakatohea-demo',
    aid: 'EEPniUBMcommunityAID',
    oobi: 'https://whakatohea-demo.idss.nz/oobi/EEPniUBMcommunityAID',
    registry: 'ERegistryLedgerId',
  },
  admins: [
    { aid: 'EBenSteward', name: 'ben', oobi: 'https://whakatohea-demo.idss.nz/oobi/EBenSteward' },
  ],
  schemas: {},
};

async function loadConfigApi(opts: { capacitor: boolean }) {
  vi.resetModules();

  vi.doMock('../../src/lib/platform', () => ({
    isCapacitor: () => opts.capacitor,
    getBackendUrl: () => Promise.resolve(BACKEND_URL),
  }));

  vi.doMock('../../src/lib/clientConfig', () => ({
    getConfigUrl: () => CONFIG_SERVER_URL,
    getEnv: () => 'prod',
  }));

  vi.doMock('../../src/lib/secureStorage', () => ({
    secureStorage: {
      getItem: vi.fn(() => Promise.resolve(null)),
      setItem: vi.fn(() => Promise.resolve()),
      removeItem: vi.fn(() => Promise.resolve()),
    },
  }));

  const mod = await import('../../src/api/config');
  return mod;
}

/** A fetch stub that records URLs and answers per-URL. */
function stubFetch(handler: (url: string) => { ok: boolean; status: number; body?: unknown }) {
  const calls: string[] = [];
  const fetchMock = vi.fn((url: string) => {
    calls.push(url);
    const res = handler(url);
    return Promise.resolve({
      ok: res.ok,
      status: res.status,
      json: () => Promise.resolve(res.body ?? {}),
    });
  });
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
  return { calls };
}

describe('fetchOrgConfig platform-aware routing (#265)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('sources org config from the backend loopback API on Capacitor', async () => {
    const mod = await loadConfigApi({ capacitor: true });
    const { calls } = stubFetch((url) =>
      url.startsWith(BACKEND_URL)
        ? { ok: true, status: 200, body: FULL_CONFIG }
        : { ok: false, status: 500 },
    );

    const result = await mod.fetchOrgConfig();

    expect(result.status).toBe('configured');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(`${BACKEND_URL}/api/v1/org/config`);
    // The remote config-server host is never contacted from the WebView.
    expect(calls.some((u) => u.includes('config.example'))).toBe(false);
  });

  it('does NOT hit the remote config server when the backend 404s on Capacitor', async () => {
    const mod = await loadConfigApi({ capacitor: true });
    const { calls } = stubFetch((url) =>
      url.startsWith(BACKEND_URL) ? { ok: false, status: 404 } : { ok: true, status: 200, body: FULL_CONFIG },
    );

    const result = await mod.fetchOrgConfig();

    expect(result.status).toBe('not_configured');
    expect(calls).toEqual([`${BACKEND_URL}/api/v1/org/config`]);
    expect(calls.some((u) => u.includes('config.example'))).toBe(false);
  });

  it('falls back to the remote config server on non-Capacitor platforms', async () => {
    const mod = await loadConfigApi({ capacitor: false });
    const { calls } = stubFetch((url) =>
      url.startsWith(BACKEND_URL) ? { ok: false, status: 404 } : { ok: true, status: 200, body: FULL_CONFIG },
    );

    const result = await mod.fetchOrgConfig();

    expect(result.status).toBe('configured');
    expect(calls).toEqual([
      `${BACKEND_URL}/api/v1/org/config`,
      `${CONFIG_SERVER_URL}/api/config`,
    ]);
  });
});

describe('fetchOrgConfig derives OrgConfig from an IDSS descriptor (#610)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('an IDSS-shaped document from the backend parses to a usable OrgConfig', async () => {
    const mod = await loadConfigApi({ capacitor: true });
    stubFetch((url) =>
      url.startsWith(BACKEND_URL)
        ? { ok: true, status: 200, body: IDSS_DESCRIPTOR }
        : { ok: false, status: 500 },
    );

    const result = await mod.fetchOrgConfig();

    expect(result.status).toBe('configured');
    if (result.status !== 'configured') return;
    // organization ← community.{aid,name,oobi}
    expect(result.config.organization).toEqual({
      aid: 'EEPniUBMcommunityAID',
      name: 'WHAKATOHEA DEMO',
      oobi: 'https://whakatohea-demo.idss.nz/oobi/EEPniUBMcommunityAID',
    });
    // registry ← { id: community.registry, name }
    expect(result.config.registry).toEqual({ id: 'ERegistryLedgerId', name: 'WHAKATOHEA DEMO' });
    // admins carried through as-is
    expect(result.config.admins).toEqual([
      { aid: 'EBenSteward', name: 'ben', oobi: 'https://whakatohea-demo.idss.nz/oobi/EBenSteward' },
    ]);
  });

  it('an IDSS descriptor served by the config server also derives a usable OrgConfig', async () => {
    const mod = await loadConfigApi({ capacitor: false });
    const { calls } = stubFetch((url) =>
      url.startsWith(BACKEND_URL)
        ? { ok: false, status: 404 }
        : { ok: true, status: 200, body: IDSS_DESCRIPTOR },
    );

    const result = await mod.fetchOrgConfig();

    expect(result.status).toBe('configured');
    if (result.status !== 'configured') return;
    expect(result.config.organization.aid).toBe('EEPniUBMcommunityAID');
    expect(calls).toEqual([
      `${BACKEND_URL}/api/v1/org/config`,
      `${CONFIG_SERVER_URL}/api/config`,
    ]);
  });

  it('deriveIdssOrgConfig ignores a non-IDSS document', async () => {
    const mod = await loadConfigApi({ capacitor: true });
    expect(mod.deriveIdssOrgConfig(FULL_CONFIG)).toBeNull();
  });

  it('deriveIdssOrgConfig ignores an IDSS document that already carries organization', async () => {
    const mod = await loadConfigApi({ capacitor: true });
    expect(
      mod.deriveIdssOrgConfig({ ...IDSS_DESCRIPTOR, organization: FULL_CONFIG.organization }),
    ).toBeNull();
  });
});
