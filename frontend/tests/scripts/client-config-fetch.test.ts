import { describe, it, expect, afterEach, vi } from 'vitest';

/**
 * clientConfig.ts sources the client config from a different origin per platform
 * (issue #99): on Capacitor it must go through the embedded backend's loopback
 * API (the WebView blocks cleartext to the remote config server), while every
 * other platform keeps hitting the remote config server directly.
 *
 * The module memoises the fetched config at module scope and reads CONFIG_URL
 * from import.meta.env at load time, so each case re-imports it fresh via
 * vi.resetModules() with the platform + secureStorage modules mocked.
 */

const BACKEND_URL = 'http://127.0.0.1:41234';

const SAMPLE_CONFIG = {
  version: '1.0',
  mode: 'prod',
  keri: { admin_url: '', boot_url: '', cesr_url: '' },
  schema_server_url: '',
  config_server_url: '',
  witnesses: { urls: [], aids: {}, oobis: [] },
  anysync: { id: 'net-1', networkId: 'net-1', nodes: [] },
};

/**
 * Load a fresh clientConfig module with platform.isCapacitor() forced and a
 * stubbed global fetch that captures the requested URL.
 */
async function loadClientConfig(opts: { capacitor: boolean }) {
  vi.resetModules();

  vi.doMock('../../src/lib/platform', () => ({
    isCapacitor: () => opts.capacitor,
    getBackendUrl: () => Promise.resolve(BACKEND_URL),
  }));

  vi.doMock('../../src/lib/secureStorage', () => ({
    secureStorage: {
      getItem: vi.fn(() => Promise.resolve(null)),
      setItem: vi.fn(() => Promise.resolve()),
      removeItem: vi.fn(() => Promise.resolve()),
    },
  }));

  const fetchMock = vi.fn((_url: string) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(SAMPLE_CONFIG),
    }),
  );
  (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;

  const mod = await import('../../src/lib/clientConfig');
  return { mod, fetchMock };
}

describe('clientConfig platform-aware fetch (#99)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('fetches via the embedded backend loopback API on Capacitor', async () => {
    const { mod, fetchMock } = await loadClientConfig({ capacitor: true });

    const config = await mod.fetchClientConfig();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(`${BACKEND_URL}/api/v1/client-config`);
    // No request goes to the remote config server host.
    expect(fetchMock.mock.calls[0]![0]).not.toContain('3904');
    expect(config.anysync.id).toBe('net-1');
  });

  it('fetches directly from the remote config server on non-Capacitor platforms', async () => {
    const { mod, fetchMock } = await loadClientConfig({ capacitor: false });

    await mod.fetchClientConfig();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0]![0] as string;
    // Default dev config server, byte-for-byte unchanged behaviour.
    expect(url).toBe(`${mod.getConfigUrl()}/api/client-config`);
    expect(url).not.toContain('127.0.0.1:41234');
  });
});
