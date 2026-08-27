import { describe, it, expect, afterEach, vi } from 'vitest';

/**
 * secureStorage picks its backend at call time (Capacitor) or module load
 * (Electron), so each case installs its own `window`/`localStorage` and
 * re-imports the module. The tests/scripts vitest env is `node` (no jsdom).
 */

interface FakeSecureStoragePlugin {
  getItem: ReturnType<typeof vi.fn>;
  setItem: ReturnType<typeof vi.fn>;
  removeItem: ReturnType<typeof vi.fn>;
}

function installLocalStorageSpy() {
  const ls = {
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  };
  (globalThis as unknown as { localStorage: unknown }).localStorage = ls;
  return ls;
}

/** In-memory stand-in for the native EncryptedSharedPreferences plugin. */
function fakePlugin(): FakeSecureStoragePlugin {
  const store = new Map<string, string>();
  return {
    getItem: vi.fn(({ key }: { key: string }) => Promise.resolve({ value: store.get(key) ?? null })),
    setItem: vi.fn(({ key, value }: { key: string; value: string }) => {
      store.set(key, value);
      return Promise.resolve();
    }),
    removeItem: vi.fn(({ key }: { key: string }) => {
      store.delete(key);
      return Promise.resolve();
    }),
  };
}

function installCapacitor(plugin?: FakeSecureStoragePlugin) {
  (globalThis as unknown as { window: unknown }).window = {
    Capacitor: {
      isNativePlatform: () => true,
      Plugins: plugin ? { SecureStorage: plugin } : {},
    },
  };
}

async function loadSecureStorage() {
  vi.resetModules();
  const mod = await import('../../src/lib/secureStorage');
  return mod.secureStorage;
}

describe('secureStorage', () => {
  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
    delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
    vi.restoreAllMocks();
  });

  it('round-trips through the native plugin on Capacitor and never touches localStorage', async () => {
    const ls = installLocalStorageSpy();
    const plugin = fakePlugin();
    installCapacitor(plugin);
    const storage = await loadSecureStorage();

    expect(await storage.getItem('matou_passcode')).toBeNull();
    await storage.setItem('matou_passcode', 'hunter2');
    expect(await storage.getItem('matou_passcode')).toBe('hunter2');
    await storage.removeItem('matou_passcode');
    expect(await storage.getItem('matou_passcode')).toBeNull();

    expect(plugin.setItem).toHaveBeenCalledWith({ key: 'matou_passcode', value: 'hunter2' });
    expect(plugin.removeItem).toHaveBeenCalledWith({ key: 'matou_passcode' });
    expect(ls.setItem).not.toHaveBeenCalled();
    expect(ls.getItem).not.toHaveBeenCalled();
    expect(ls.removeItem).not.toHaveBeenCalled();
  });

  it('refuses to fall back to localStorage on Capacitor when the plugin is missing', async () => {
    const ls = installLocalStorageSpy();
    installCapacitor(undefined);
    const storage = await loadSecureStorage();

    await expect(storage.setItem('matou_passcode', 'hunter2')).rejects.toThrow(/SecureStorage plugin unavailable/);
    await expect(storage.getItem('matou_passcode')).rejects.toThrow(/SecureStorage plugin unavailable/);
    await expect(storage.removeItem('matou_passcode')).rejects.toThrow(/SecureStorage plugin unavailable/);
    expect(ls.setItem).not.toHaveBeenCalled();
    expect(ls.getItem).not.toHaveBeenCalled();
  });

  it('keeps the localStorage fallback in the browser (dev/test)', async () => {
    const ls = installLocalStorageSpy();
    (globalThis as unknown as { window: unknown }).window = {};
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const storage = await loadSecureStorage();

    await storage.setItem('k', 'v');
    await storage.getItem('k');
    await storage.removeItem('k');
    expect(ls.setItem).toHaveBeenCalledWith('k', 'v');
    expect(ls.getItem).toHaveBeenCalledWith('k');
    expect(ls.removeItem).toHaveBeenCalledWith('k');
  });

  it('keeps the Electron IPC path unchanged', async () => {
    const ls = installLocalStorageSpy();
    const electronAPI = {
      isElectron: true,
      secureStorageGet: vi.fn(() => Promise.resolve('from-keyring')),
      secureStorageSet: vi.fn(() => Promise.resolve()),
      secureStorageRemove: vi.fn(() => Promise.resolve()),
    };
    (globalThis as unknown as { window: unknown }).window = { electronAPI };
    const storage = await loadSecureStorage();

    expect(await storage.getItem('k')).toBe('from-keyring');
    await storage.setItem('k', 'v');
    await storage.removeItem('k');
    expect(electronAPI.secureStorageSet).toHaveBeenCalledWith('k', 'v');
    expect(electronAPI.secureStorageRemove).toHaveBeenCalledWith('k');
    expect(ls.setItem).not.toHaveBeenCalled();
  });
});
