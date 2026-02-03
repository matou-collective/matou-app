/**
 * Secure Storage Module
 * Uses Electron's safeStorage (OS-level encryption) when running in Electron,
 * falls back to localStorage when running in browser (dev mode).
 */

const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

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
    localStorage.setItem(key, value);
  },

  async removeItem(key: string): Promise<void> {
    if (isElectron) {
      return window.electronAPI!.secureStorageRemove(key);
    }
    localStorage.removeItem(key);
  },
};
