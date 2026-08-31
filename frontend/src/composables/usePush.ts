/**
 * Push-notification lifecycle + receipt handling (Android/FCM).
 *
 * Implements the frontend contract of docs/architecture/08-push-notifications.md
 * (§4–§8) against the Capacitor plugin surface, with the plugin injected by the
 * native shell as `window.Capacitor.Plugins.*` (we never bundle @capacitor/*;
 * same doctrine as lib/capacitor.ts). Firebase/plugin wiring lands in the
 * Capacitor slice (#177 task 3) — nothing here depends on a device.
 *
 * Web/Electron are no-ops: push is Android-only for #177.
 *
 * Responsibilities:
 *  - permission AFTER onboarding, never during (§7) — driven by useOnboarding;
 *  - obtain the FCM token → POST /api/v1/push/register; re-register on rotation;
 *  - deregister on logout / identity switch (§7);
 *  - receipt handler: data payload `{t:"m",c,k,v}` → sync the one channel,
 *    compose a content-free local notification, coalesce bursts, recompute the
 *    launcher badge (§4–§5);
 *  - deep-link on tap → /chat?c=<channelId> (§6).
 *
 * All visible-notification behaviour is gated by the notifications-store `push`
 * preferences (§7).
 */

import { watch } from 'vue';
import type { Router } from 'vue-router';
import { useNotificationsStore } from 'stores/notifications';
import { useChatStore } from 'stores/chat';
import { useIdentityStore } from 'stores/identity';
import { createLogger } from 'src/lib/logging';
import { isCapacitor } from 'src/lib/platform';
import {
  getCapacitorPlatform,
  getMatouBackendPlugin,
  getPushNotificationsPlugin,
  getLocalNotificationsPlugin,
  getBadgePlugin,
} from 'src/lib/capacitor';
import { registerPushToken, deregisterPushToken } from 'src/lib/api/push';

const log = createLogger('Push');

/** Data-only FCM payload shape (§4). */
export interface PushDataPayload {
  t?: string; // payload type — "m" = new message
  c?: string; // opaque channel id the recipient already possesses
  k?: string; // coarse kind — "dm" | "ch"
  v?: string; // schema version
}

/** The visible notification composed on-device after sync. */
export interface ComposedNotification {
  channelId: string;
  title: string;
}

/** Outcome of a permission/registration attempt. */
export type PermissionOutcome = 'granted' | 'denied' | 'unsupported' | 'unavailable';

/** Window (ms) within which a burst of messages in one channel coalesces. */
const COALESCE_WINDOW_MS = 3000;

// --- Module state (app-lifetime singletons) ---------------------------------
let router: Router | null = null;
let currentToken: string | null = null;
let listenersRegistered = false;
const coalesceTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Wire the router used for deep-links. Called from the push boot file. */
export function setPushRouter(r: Router): void {
  router = r;
}

/** True only on the Android Capacitor shell — the one platform push targets. */
export function isPushPlatform(): boolean {
  return isCapacitor() && getCapacitorPlatform() === 'android';
}

/**
 * Register the plugin event listeners + the identity watcher exactly once.
 * Safe to call repeatedly (from onboarding completion or the boot file).
 */
export function ensurePushListeners(): void {
  if (listenersRegistered) return;
  const plugin = getPushNotificationsPlugin();
  if (!plugin) return; // no native plugin yet (pre-slice-3 shell / non-Android)
  listenersRegistered = true;

  void plugin.addListener('registration', (token) => {
    void handleRegistrationToken(token.value);
  });
  void plugin.addListener('registrationError', (err) => {
    log.error('FCM registration error: %s', err.error);
  });
  void plugin.addListener('pushNotificationReceived', (notification) => {
    void handlePushReceipt(notification.data as PushDataPayload | undefined);
  });
  void plugin.addListener('pushNotificationActionPerformed', (action) => {
    handlePushTap(action.notification.data as PushDataPayload | undefined);
  });

  // Deregister on logout, deregister+re-register on identity switch (§7).
  const identity = useIdentityStore();
  watch(
    () => identity.aidPrefix,
    (newAid, oldAid) => {
      void handleIdentityChange(newAid ?? null, oldAid ?? null);
    },
  );
}

/**
 * Onboarding-completion hook (§7): request permission (never during
 * onboarding), obtain the token, register. Idempotent and a no-op off Android.
 */
export async function requestPermissionAndRegister(): Promise<PermissionOutcome> {
  if (!isPushPlatform()) return 'unsupported';
  const plugin = getPushNotificationsPlugin();
  if (!plugin) return 'unavailable';

  ensurePushListeners();

  let perm = await plugin.checkPermissions();
  if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') {
    perm = await plugin.requestPermissions();
  }
  if (perm.receive !== 'granted') {
    log.info('Push permission not granted: %s', perm.receive);
    return 'denied';
  }

  // Fires the `registration` event → handleRegistrationToken → backend register.
  await plugin.register();
  return 'granted';
}

/** Store the token and register it with the backend (§7 — grant + rotation). */
export async function handleRegistrationToken(token: string): Promise<void> {
  const rotated = currentToken !== null && currentToken !== token;
  currentToken = token;
  const notifStore = useNotificationsStore();
  if (!notifStore.pushEnabled) return; // globally opted out — don't register
  log.info('%s FCM token → backend', rotated ? 'Rotated' : 'New');
  await registerPushToken(token);
}

/** Deregister the current token (logout / identity switch / opt-out). */
export async function deregisterPush(): Promise<void> {
  const token = currentToken;
  currentToken = null;
  await deregisterPushToken(token ?? undefined);
}

/**
 * Re-register or deregister when the active identity changes. Logout (no new
 * AID) deregisters; a switch deregisters the old mapping then registers the new.
 */
export async function handleIdentityChange(
  newAid: string | null,
  oldAid: string | null,
): Promise<void> {
  if (newAid === oldAid) return;
  if (oldAid) {
    await deregisterPush();
  }
  if (newAid && isPushPlatform()) {
    await requestPermissionAndRegister();
  }
}

/**
 * Called when the global push toggle flips in settings: register the current
 * token when enabled, deregister when disabled (§7 — the toggle drives
 * register/deregister).
 */
export async function applyPushEnabled(enabled: boolean): Promise<void> {
  // The preference itself is persisted by the store; the register/deregister
  // side effect only makes sense on the Android push platform.
  if (!isPushPlatform()) return;
  if (enabled) {
    await requestPermissionAndRegister();
  } else {
    await deregisterPush();
  }
}

/**
 * Wake the embedded backend to sync one channel tree (§5), via the MatouBackend
 * plugin when present. Returns whether the sync completed.
 */
async function syncChannel(channelId: string): Promise<boolean> {
  const backend = getMatouBackendPlugin();
  if (!backend?.syncChannel) return false;
  try {
    await backend.syncChannel({ channelId });
    return true;
  } catch (err) {
    log.error('Channel sync failed for %s: %o', channelId, err);
    return false;
  }
}

/** Resolve a channel's display name from local state, or null if unknown. */
function resolveChannelName(channelId: string): string | null {
  const chatStore = useChatStore();
  return chatStore.channels.find((c) => c.id === channelId)?.name ?? null;
}

/** Recompute the launcher unread badge from local state (§4). */
export function recomputeBadge(): void {
  const badge = getBadgePlugin();
  if (!badge) return;
  const chatStore = useChatStore();
  void Promise.resolve(badge.set({ count: chatStore.totalUnreadCount }));
}

/**
 * Handle a received data push (foreground or background, §4–§5): sync the one
 * channel, recompute the badge, and — when the channel isn't muted and push is
 * enabled — compose and present a content-free local notification. Returns the
 * composed notification (or null when nothing visible is produced).
 */
export async function handlePushReceipt(
  data: PushDataPayload | undefined,
): Promise<ComposedNotification | null> {
  if (!data || data.t !== 'm' || !data.c) return null;
  const channelId = data.c;

  const synced = await syncChannel(channelId);

  // Badge reflects reality regardless of per-channel mute / global toggle.
  recomputeBadge();

  const notifStore = useNotificationsStore();
  if (!notifStore.shouldNotifyForChannel(channelId)) return null;

  // Content-free default: resolve the name locally, fall back to generic text
  // if sync failed or the channel is unknown (§4).
  const channelName = synced ? resolveChannelName(channelId) : null;
  const title = channelName ? `New message in ${channelName}` : 'New messages';
  const composed: ComposedNotification = { channelId, title };

  presentCoalesced(composed);
  return composed;
}

/**
 * Present the composed notification, coalescing a burst in one channel into a
 * single visible notification (§5) via a short debounce.
 */
function presentCoalesced(notif: ComposedNotification): void {
  const existing = coalesceTimers.get(notif.channelId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    coalesceTimers.delete(notif.channelId);
    presentLocalNotification(notif);
  }, COALESCE_WINDOW_MS);
  coalesceTimers.set(notif.channelId, timer);
}

/** Emit the on-device notification via the native local-notifications plugin. */
function presentLocalNotification(notif: ComposedNotification): void {
  const local = getLocalNotificationsPlugin();
  if (!local) return;
  // Stable per-channel id so the coalesced update replaces rather than stacks.
  const id = hashChannelId(notif.channelId);
  void local.schedule({
    notifications: [
      {
        id,
        title: notif.title,
        body: '',
        channelId: 'messages',
        extra: { c: notif.channelId },
      },
    ],
  });
}

/** Deterministic small positive int id from a channel id (for notification id). */
function hashChannelId(channelId: string): number {
  let h = 0;
  for (let i = 0; i < channelId.length; i++) {
    h = (h * 31 + channelId.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % 2147483647;
}

/** Deep-link a notification tap to the target channel (§6): /chat?c=<id>. */
export function handlePushTap(data: PushDataPayload | undefined): void {
  const channelId = data?.c;
  if (!channelId || !router) return;
  void router.push({ name: 'chat', query: { c: channelId } });
}

/** Reset module state — test-only seam. */
export function __resetPushForTest(): void {
  router = null;
  currentToken = null;
  listenersRegistered = false;
  coalesceTimers.forEach((t) => clearTimeout(t));
  coalesceTimers.clear();
}

/** Ergonomic accessor for components/composables. */
export function usePush() {
  return {
    isPushPlatform,
    ensurePushListeners,
    requestPermissionAndRegister,
    deregisterPush,
    applyPushEnabled,
    handlePushReceipt,
    handlePushTap,
    recomputeBadge,
  };
}
