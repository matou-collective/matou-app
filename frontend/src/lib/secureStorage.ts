/**
 * Secure Storage Module
 *
 * Backed by OS-level encryption on every shipped platform:
 * - Electron: safeStorage via IPC (OS keyring).
 * - Capacitor (Android): the native SecureStorage plugin — EncryptedSharedPreferences
 *   with a Keystore-held master key (src-capacitor/android/.../SecureStoragePlugin.java).
 * - Browser (dev/test only): localStorage, in plaintext.
 *
 * SECURITY NOTE: The browser fallback stores values in plaintext. This is
 * acceptable in dev mode since the backend is localhost-only. On Capacitor the
 * fallback is deliberately unreachable: a shell that failed to register the
 * plugin gets a hard error rather than the mnemonic landing in WebView storage.
 */

import { isCapacitor, getSecureStoragePlugin, type SecureStoragePlugin } from './capacitor';

const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

let warnedAboutLocalStorage = false;

/** The native plugin on Capacitor; throws if the shell didn't register it. */
function nativePlugin(): SecureStoragePlugin {
  const plugin = getSecureStoragePlugin();
  if (!plugin) {
    throw new Error('SecureStorage plugin unavailable on Capacitor — refusing to fall back to plaintext storage');
  }
  return plugin;
}

export const secureStorage = {
  async getItem(key: string): Promise<string | null> {
    if (isElectron) {
      return window.electronAPI!.secureStorageGet(key);
    }
    if (isCapacitor()) {
      const { value } = await nativePlugin().getItem({ key });
      return value ?? null;
    }
    return localStorage.getItem(key);
  },

  async setItem(key: string, value: string): Promise<void> {
    if (isElectron) {
      return window.electronAPI!.secureStorageSet(key, value);
    }
    if (isCapacitor()) {
      return nativePlugin().setItem({ key, value });
    }
    if (!warnedAboutLocalStorage) {
      console.warn('[SecureStorage] Using localStorage fallback (dev mode only). Secrets are NOT encrypted.');
      warnedAboutLocalStorage = true;
    }
    localStorage.setItem(key, value);
  },

  async removeItem(key: string): Promise<void> {
    if (isElectron) {
      return window.electronAPI!.secureStorageRemove(key);
    }
    if (isCapacitor()) {
      return nativePlugin().removeItem({ key });
    }
    localStorage.removeItem(key);
  },
};
