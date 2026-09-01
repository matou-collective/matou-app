/**
 * Capacitor (Android + iOS) bridge helpers.
 *
 * The native shell injects `window.Capacitor` into the WebView, which is how we
 * reach the MatouBackend plugin (src-capacitor/android/.../MatouBackendPlugin.java,
 * src-capacitor/ios/App/App/MatouBackendPlugin.swift)
 * that boots the embedded Go backend and reports its loopback port and per-launch
 * API token.
 *
 * Deliberately no `@capacitor/core` import: the browser and Electron bundles must
 * not grow a Capacitor dependency, and the injected global is all we need.
 */

/** Result of MatouBackend.getInfo() — mirrors MatouBackendPlugin.java / .swift. */
export interface BackendInfo {
  /** Loopback port the embedded Go backend bound to. */
  port: number;
  /** Per-launch token the backend's TokenGuard requires on mutating requests. */
  token: string;
}

interface MatouBackendPlugin {
  getInfo(): Promise<BackendInfo>;
}

/**
 * Secure key/value storage backed by EncryptedSharedPreferences on Android and
 * the Keychain on iOS (#71). Both native sides implement exactly this contract.
 */
export interface SecureStoragePlugin {
  getItem(options: { key: string }): Promise<{ value: string | null }>;
  setItem(options: { key: string; value: string }): Promise<void>;
  removeItem(options: { key: string }): Promise<void>;
}

/** The subset of Capacitor's injected global this module relies on. */
interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: {
    MatouBackend?: MatouBackendPlugin;
    SecureStorage?: SecureStoragePlugin;
  };
}

function capacitorGlobal(): CapacitorGlobal | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
}

/**
 * Check if running inside the Capacitor native shell.
 *
 * Only the native WebView injects `window.Capacitor` (we never bundle
 * @capacitor/core), so its presence is the signal. A bridge that predates
 * `isNativePlatform()` still counts as native.
 */
export function isCapacitor(): boolean {
  const cap = capacitorGlobal();
  if (!cap) return false;
  return typeof cap.isNativePlatform === 'function' ? cap.isNativePlatform() : true;
}

let backendInfoPromise: Promise<BackendInfo> | null = null;

/**
 * Resolve the embedded backend's port and API token, memoised for the life of
 * the page. The first call boots the Go backend (Mobile.start on a background
 * thread), so it can take seconds; every later caller shares that one promise.
 *
 * A failed attempt is NOT memoised — the next caller retries rather than
 * inheriting a permanently poisoned app.
 */
export function getBackendInfo(): Promise<BackendInfo> {
  if (!backendInfoPromise) {
    const pending = requestBackendInfo();
    backendInfoPromise = pending;
    pending.catch(() => {
      if (backendInfoPromise === pending) backendInfoPromise = null;
    });
  }
  return backendInfoPromise;
}

async function requestBackendInfo(): Promise<BackendInfo> {
  const plugin = capacitorGlobal()?.Plugins?.MatouBackend;
  if (!plugin) {
    throw new Error('MatouBackend plugin unavailable — the native shell did not register it');
  }
  const info = await plugin.getInfo();
  if (!info || typeof info.port !== 'number' || info.port <= 0 || !info.token) {
    throw new Error(`MatouBackend.getInfo() returned an unusable result: ${JSON.stringify(info)}`);
  }
  return { port: info.port, token: info.token };
}

/**
 * The native SecureStorage plugin, or undefined when it isn't registered
 * (any non-Capacitor build, or a shell built before #71).
 */
export function getSecureStoragePlugin(): SecureStoragePlugin | undefined {
  return capacitorGlobal()?.Plugins?.SecureStorage;
}
