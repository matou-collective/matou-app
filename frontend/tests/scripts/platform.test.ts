import { describe, it, expect, afterEach, vi } from 'vitest';

/**
 * platform.ts / capacitor.ts resolve the backend URL and API token per platform.
 * Both modules memoise at module scope, so every case re-imports them fresh via
 * vi.resetModules(). The tests/scripts vitest env is `node` (no jsdom), so
 * `window` is installed by hand — the same pattern as use-is-mobile.test.ts.
 */

interface FakeWindow {
  electronAPI?: unknown;
  cordova?: unknown;
  Capacitor?: unknown;
}

function installWindow(win: FakeWindow) {
  (globalThis as unknown as { window: unknown }).window = win;
}

function uninstallWindow() {
  delete (globalThis as unknown as { window?: unknown }).window;
}

/** A Capacitor bridge whose MatouBackend plugin reports port/token. */
function installCapacitor(info: { port: number; token: string }) {
  const getInfo = vi.fn(() => Promise.resolve(info));
  installWindow({
    Capacitor: {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
      Plugins: { MatouBackend: { getInfo } },
    },
  });
  return getInfo;
}

/** Fresh copies of both modules (module-level caches reset). */
async function loadPlatform() {
  vi.resetModules();
  return import('../../src/lib/platform');
}

describe('platform backend resolution', () => {
  afterEach(() => {
    uninstallWindow();
    vi.restoreAllMocks();
  });

  it('resolves the backend URL and token from the MatouBackend plugin on Capacitor', async () => {
    installCapacitor({ port: 41234, token: 'deadbeef' });
    const platform = await loadPlatform();

    expect(platform.isCapacitor()).toBe(true);
    expect(platform.isBrowser()).toBe(false);
    expect(await platform.getBackendUrl()).toBe('http://127.0.0.1:41234');
    expect(await platform.getApiToken()).toBe('deadbeef');
  });

  it('calls the plugin once and memoises the result', async () => {
    const getInfo = installCapacitor({ port: 41234, token: 'deadbeef' });
    const platform = await loadPlatform();

    await Promise.all([
      platform.getBackendUrl(),
      platform.getApiToken(),
      platform.getBackendUrl(),
      platform.getApiToken(),
    ]);

    expect(getInfo).toHaveBeenCalledTimes(1);
    // Sync accessors serve the resolved values once the async pair has run.
    expect(platform.getBackendUrlSync()).toBe('http://127.0.0.1:41234');
    expect(platform.getApiTokenSync()).toBe('deadbeef');
  });

  it('rejects on Capacitor when the plugin is missing, without falling back to the dev token', async () => {
    installWindow({ Capacitor: { isNativePlatform: () => true, Plugins: {} } });
    const platform = await loadPlatform();

    await expect(platform.getBackendUrl()).rejects.toThrow(
      /MatouBackend plugin unavailable/,
    );
    await expect(platform.getApiToken()).rejects.toThrow(
      /MatouBackend plugin unavailable/,
    );
    // Never the shared dev token, and never a guessed port.
    expect(platform.getApiTokenSync()).toBe('');
    expect(platform.getBackendUrlSync()).toBe('');
  });

  it('leaves browser behaviour unchanged (dev token, default port)', async () => {
    installWindow({});
    const platform = await loadPlatform();

    expect(platform.isCapacitor()).toBe(false);
    expect(platform.isBrowser()).toBe(true);
    // VITE_BACKEND_URL is set by frontend/.env in local runs and unset in CI —
    // either way the browser path is env-var-then-default, unchanged by this work.
    const expectedUrl =
      import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:8080';
    expect(await platform.getBackendUrl()).toBe(expectedUrl);
    expect(await platform.getApiToken()).toBe(
      import.meta.env.VITE_API_TOKEN ?? 'matou-dev',
    );
  });

  it('leaves Electron behaviour unchanged (IPC port and token)', async () => {
    installWindow({
      electronAPI: {
        isElectron: true,
        getBackendPort: () => Promise.resolve(8123),
        getApiToken: () => Promise.resolve('electron-token'),
      },
    });
    const platform = await loadPlatform();

    expect(platform.isCapacitor()).toBe(false);
    expect(platform.isBrowser()).toBe(false);
    expect(await platform.getBackendUrl()).toBe('http://127.0.0.1:8123');
    expect(await platform.getApiToken()).toBe('electron-token');
  });

  it('retries after a failed backend start instead of caching the failure', async () => {
    const getInfo = vi
      .fn<() => Promise<{ port: number; token: string }>>()
      .mockRejectedValueOnce(new Error('backend start failed'))
      .mockResolvedValue({ port: 5000, token: 'later' });
    installWindow({
      Capacitor: {
        isNativePlatform: () => true,
        Plugins: { MatouBackend: { getInfo } },
      },
    });
    vi.resetModules();
    const { getBackendInfo } = await import('../../src/lib/capacitor');

    await expect(getBackendInfo()).rejects.toThrow(/backend start failed/);
    await expect(getBackendInfo()).resolves.toEqual({
      port: 5000,
      token: 'later',
    });
    expect(getInfo).toHaveBeenCalledTimes(2);
  });
});
