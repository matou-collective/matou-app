/**
 * TypeScript declarations for the Electron preload API.
 */
export interface ElectronAPI {
  isElectron: true;
  platform: string;
  getBackendPort: () => Promise<number>;
  getDataDir: () => Promise<string>;
  secureStorageGet: (key: string) => Promise<string | null>;
  secureStorageSet: (key: string, value: string) => Promise<void>;
  secureStorageRemove: (key: string) => Promise<void>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
