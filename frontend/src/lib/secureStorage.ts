/**
 * Secure Storage Module
 * Uses Electron's safeStorage (OS-level encryption) when running in Electron,
 * falls back to localStorage when running in browser (dev mode only).
 *
 * SECURITY NOTE: The browser fallback (localStorage) stores values in plaintext.
 * This is acceptable in dev mode since the backend is localhost-only. In production,
 * the app always runs inside Electron where safeStorage encrypts via the OS keyring.
 */

const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

let warnedAboutLocalStorage = false;

export const secureStorage = {
  async getItem(key: string): Promise<string | null> {
    if (isElectron) {
      return window.electronAPI!.secureStorageGet(key);
    }
    return localStorage.getItem(key);
  },

  async setItem(key: string, value: string): Promise<void> {
    if (isElectron) {
      return window.electronAPI!.secureStorageSet(key, value);
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
    localStorage.removeItem(key);
  },
};
