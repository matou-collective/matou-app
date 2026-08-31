/**
 * Capacitor (Android) bridge helpers.
 *
 * The native shell injects `window.Capacitor` into the WebView, which is how we
 * reach the MatouBackend plugin (src-capacitor/android/.../MatouBackendPlugin.java)
 * that boots the embedded Go backend and reports its loopback port and per-launch
 * API token.
 *
 * Deliberately no `@capacitor/core` import: the browser and Electron bundles must
 * not grow a Capacitor dependency, and the injected global is all we need.
 */

/** Result of MatouBackend.getInfo() — mirrors MatouBackendPlugin.java. */
export interface BackendInfo {
  /** Loopback port the embedded Go backend bound to. */
  port: number;
  /** Per-launch token the backend's TokenGuard requires on mutating requests. */
  token: string;
}

interface MatouBackendPlugin {
  getInfo(): Promise<BackendInfo>;
  /**
   * Wake the embedded backend just long enough to sync one channel tree, used
   * by the push receipt handler (docs/architecture/08-push-notifications.md §5).
   * Optional: shells built before the push slice don't register it, so callers
   * must feature-detect. The native, time-boxed implementation lands with the
   * Capacitor/Firebase slice; until then the frontend calls it when present.
   */
  syncChannel?(options: { channelId: string }): Promise<void>;
}

/**
 * The `@capacitor/push-notifications` plugin surface this app relies on. We
 * deliberately do NOT import the package (same doctrine as MatouBackend — the
 * browser/Electron bundles must not grow a Capacitor dependency); the native
 * shell injects it as `window.Capacitor.Plugins.PushNotifications`. The real
 * plugin + Firebase wiring lands in the Capacitor/Firebase slice (#177 task 3);
 * this is the contract the frontend logic (#177 task 4) builds against.
 */
export interface PushPermissionStatus {
  receive: 'prompt' | 'prompt-with-rationale' | 'granted' | 'denied';
}

/** Opaque token delivered on the `registration` event. */
export interface PushRegistrationToken {
  value: string;
}

/** A received data-only push — mirrors PushNotificationSchema.data. */
export interface PushReceivedNotification {
  data?: Record<string, string>;
}

/** A notification tap — mirrors ActionPerformed.notification. */
export interface PushActionPerformed {
  notification: PushReceivedNotification;
}

type PushListenerEvent =
  | 'registration'
  | 'registrationError'
  | 'pushNotificationReceived'
  | 'pushNotificationActionPerformed';

export interface PushNotificationsPlugin {
  checkPermissions(): Promise<PushPermissionStatus>;
  requestPermissions(): Promise<PushPermissionStatus>;
  register(): Promise<void>;
  addListener(
    event: 'registration',
    fn: (token: PushRegistrationToken) => void,
  ): Promise<unknown> | unknown;
  addListener(
    event: 'registrationError',
    fn: (err: { error: string }) => void,
  ): Promise<unknown> | unknown;
  addListener(
    event: 'pushNotificationReceived',
    fn: (notification: PushReceivedNotification) => void,
  ): Promise<unknown> | unknown;
  addListener(
    event: 'pushNotificationActionPerformed',
    fn: (action: PushActionPerformed) => void,
  ): Promise<unknown> | unknown;
  addListener(
    event: PushListenerEvent,
    fn: (arg: never) => void,
  ): Promise<unknown> | unknown;
}

/**
 * `@capacitor/local-notifications`-style plugin used to present the on-device,
 * content-free notification composed after sync (§4). Injected by the native
 * shell; feature-detected like the others.
 */
export interface LocalNotificationsPlugin {
  schedule(options: {
    notifications: Array<{
      id: number;
      title: string;
      body: string;
      channelId?: string;
      extra?: Record<string, string>;
    }>;
  }): Promise<unknown>;
}

/** Launcher unread-badge plugin. `set` with 0 clears the badge. */
export interface BadgePlugin {
  set(options: { count: number }): Promise<unknown> | unknown;
}

/**
 * Secure key/value storage backed by EncryptedSharedPreferences on Android.
 * The native side lands in #71; this is the contract the frontend will call.
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
    PushNotifications?: PushNotificationsPlugin;
    LocalNotifications?: LocalNotificationsPlugin;
    Badge?: BadgePlugin;
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

/**
 * The native platform string (`'android'`, `'ios'`, `'web'`) as reported by the
 * Capacitor bridge, or undefined when not running under Capacitor. Push is
 * Android-only for #177, so callers gate on `=== 'android'`.
 */
export function getCapacitorPlatform(): string | undefined {
  const cap = capacitorGlobal();
  return typeof cap?.getPlatform === 'function' ? cap.getPlatform() : undefined;
}

/** The MatouBackend plugin, or undefined outside the native shell. */
export function getMatouBackendPlugin(): MatouBackendPlugin | undefined {
  return capacitorGlobal()?.Plugins?.MatouBackend;
}

/** The push-notifications plugin, or undefined when the shell didn't register it. */
export function getPushNotificationsPlugin(): PushNotificationsPlugin | undefined {
  return capacitorGlobal()?.Plugins?.PushNotifications;
}

/** The local-notifications plugin used to present the composed notification. */
export function getLocalNotificationsPlugin(): LocalNotificationsPlugin | undefined {
  return capacitorGlobal()?.Plugins?.LocalNotifications;
}

/** The launcher-badge plugin, or undefined when unavailable. */
export function getBadgePlugin(): BadgePlugin | undefined {
  return capacitorGlobal()?.Plugins?.Badge;
}
