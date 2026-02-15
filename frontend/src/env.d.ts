/// <reference types="vite/client" />

interface ElectronAPI {
  secureStorageGet(key: string): Promise<string | null>;
  secureStorageSet(key: string, value: string): Promise<void>;
  secureStorageRemove(key: string): Promise<void>;
}

interface Window {
  electronAPI?: ElectronAPI;
}

interface ImportMetaEnv {
  /** Environment: 'dev' | 'test' | 'prod' (default: 'dev') */
  readonly VITE_ENV?: string;
  /** Config server URL for development */
  readonly VITE_DEV_CONFIG_URL?: string;
  /** Config server URL for test environment */
  readonly VITE_TEST_CONFIG_URL?: string;
  /** Config server URL for production */
  readonly VITE_PROD_CONFIG_URL?: string;
  /** Backend API URL (Go server) */
  readonly VITE_BACKEND_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
