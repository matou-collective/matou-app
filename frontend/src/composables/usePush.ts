/**
 * Push-notification lifecycle + receipt handling (Android/FCM).
 *
 * Implements the frontend contract of docs/architecture/08-push-notifications.md
 * (§4–§8) against the Capacitor plugin surface, with the plugin injected by the
 * native shell as `window.Capacitor.Plugins.*` (we never bundle @capacitor/*;
 * same doctrine as lib/capacitor.ts).
 *
 * Web/Electron are no-ops: push is Android-only for #177.
 *
 * Responsibilities:
 *  - permission AFTER onboarding, never during (§7) — the system dialog is only
 *    ever raised by requestPermissionAndRegister(), which onboarding completion
 *    and the settings toggle call; every automatic path (restored session, app
 *    start) goes through registerIfPermitted(), which never prompts;
 *  - obtain the FCM token → POST /api/v1/push/register; re-register on rotation
 *    and on every app start so the relay's TTL never prunes a live device;
 *  - deregister on logout / identity switch (§7);
 *  - receipt handler: data payload `{t:"m",c,k,v}` → sync the one channel,
 *    compose a content-free local notification on the Android channel matching
 *    the §3 importance tier, coalesce bursts, recompute the badge (§4–§5);
 *  - deep-link on tap → /chat?c=<channelId> (§6).
 *
 * All visible-notification behaviour is gated by the notifications-store `push`
 * preferences (§7).
 */

import { computed, watch } from 'vue';
import type { Router } from 'vue-router';
import { useNotificationsStore } from 'stores/notifications';
import { useChatStore } from 'stores/chat';
import { useIdentityStore } from 'stores/identity';
import { useOnboardingStore } from 'stores/onboarding';
import { createLogger } from 'src/lib/logging';
import { isCapacitor } from 'src/lib/platform';
import {
  getCapacitorPlatform,
  getMatouBackendPlugin,
  getPushNotificationsPlugin,
  getLocalNotificationsPlugin,
  getBadgePlugin,
  type PushNotificationsPlugin,
} from 'src/lib/capacitor';
import { registerPushToken, deregisterPushToken, type PushRegisterResult } from 'src/lib/api/push';

const log = createLogger('Push');

/** Data-only FCM payload shape (§4). */
export interface PushDataPayload {
  t?: string; // payload type — "m" = new message
  c?: string; // opaque channel id the recipient already possesses
  k?: string; // coarse kind — "dm" | "ch"
  v?: string; // schema version
}

/** Coarse message kind carried by the payload's `k` field (§4). */
export type MessageKind = 'dm' | 'ch';

/**
 * Android notification channels registered natively by the Capacitor shell
 * (MatouNotificationChannels.java). Android 8+ silently DROPS a notification
 * posted to a channel id that was never created, so these two strings must stay
 * in lockstep with the native constants. DMs get the high-importance channel
 * (the §3 "instant" tier); channel traffic gets the quieter default one.
 */
export const ANDROID_CHANNEL_DM = 'matou_dm';
export const ANDROID_CHANNEL_GROUP = 'matou_channel';

/** The visible notification composed on-device after sync. */
export interface ComposedNotification {
  channelId: string;
  title: string;
  /** Drives which Android notification channel it is posted on (§3). */
  kind: MessageKind;
}

/**
 * Outcome of a permission/registration attempt.
 *  - `deferred`  — not attempted: onboarding is still in progress (§7).
 *  - `disabled`  — the user opted out via the global push toggle (§7).
 */
export type PermissionOutcome =
  | 'granted'
  | 'denied'
  | 'unsupported'
  | 'unavailable'
  | 'deferred'
  | 'disabled';

/** Window (ms) within which a burst of messages in one channel coalesces. */
const COALESCE_WINDOW_MS = 3000;

/** Leading-edge burst state for one channel (§5). */
interface CoalesceState {
  timer: ReturnType<typeof setTimeout>;
  /** Title presented on the leading edge — a trailing update only fires if it changed. */
  presentedTitle: string;
  /** Latest notification seen during the window, presented on the trailing edge. */
  pending: ComposedNotification | null;
}

// --- Module state (app-lifetime singletons) ---------------------------------
let router: Router | null = null;
let currentToken: string | null = null;
/** AID whose token was registered this launch — dedupes the automatic paths. */
let registeredAid: string | null = null;
let listenersRegistered = false;
const coalesceStates = new Map<string, CoalesceState>();

/** Wire the router used for deep-links. Called from the push boot file. */
export function setPushRouter(r: Router): void {
  router = r;
}

/** True only on the Android Capacitor shell — the one platform push targets. */
export function isPushPlatform(): boolean {
  return isCapacitor() && getCapacitorPlatform() === 'android';
}

/** The AID of the active session, or null when signed out. */
function currentAid(): string | null {
  return useIdentityStore().aidPrefix ?? null;
}

/**
 * Whether the user is past onboarding, the point from which §7 permits a
 * permission prompt and an automatic registration.
 *
 * Two completion shapes exist: a new member reaches the `main` screen, while a
 * returning member is routed splash → welcome-overlay → `/dashboard` without
 * ever passing through `main` (see OnboardingPage `handleContinue`), so being
 * inside the dashboard counts as complete too.
 */
export function isOnboardingComplete(): boolean {
  if (useOnboardingStore().currentScreen === 'main') return true;
  const path = router?.currentRoute.value.path ?? null;
  return path !== null && path.startsWith('/dashboard');
}

/**
 * Register the plugin event listeners + the lifecycle watchers exactly once.
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

  // Refresh the token whenever an onboarded identity becomes active — which
  // includes app start, where the session is restored before (or racing) this
  // boot file, so the null → AID transition alone cannot be relied on. Without
  // it an already-onboarded user never re-registers, the relay's TTL prunes the
  // token and push dies silently (§7). `immediate` covers the already-restored
  // case; registerIfPermitted never prompts, so this cannot fire a dialog.
  const eligible = computed(() => identity.aidPrefix !== null && isOnboardingComplete());
  watch(
    eligible,
    (isEligible) => {
      if (isEligible) void registerIfPermitted();
    },
    { immediate: true },
  );
}

/** Shared tail of both registration paths: remember the AID, ask for a token. */
async function startRegistration(plugin: PushNotificationsPlugin): Promise<PermissionOutcome> {
  registeredAid = currentAid();
  // Fires the `registration` event → handleRegistrationToken → backend register.
  await plugin.register();
  return 'granted';
}

/**
 * Onboarding-completion / settings-toggle hook (§7): request permission —
 * showing the system dialog when needed — obtain the token, register.
 * Idempotent and a no-op off Android.
 *
 * This is the ONLY function that may raise the permission dialog, and its
 * callers are exactly the post-onboarding ones (useOnboarding.completeOnboarding,
 * OnboardingPage, the settings toggle). Automatic paths use
 * registerIfPermitted() instead.
 */
export async function requestPermissionAndRegister(): Promise<PermissionOutcome> {
  if (!isPushPlatform()) return 'unsupported';
  const plugin = getPushNotificationsPlugin();
  if (!plugin) return 'unavailable';

  ensurePushListeners();

  const aid = currentAid();
  if (aid !== null && aid === registeredAid) return 'granted'; // already registered this launch

  let perm = await plugin.checkPermissions();
  if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') {
    perm = await plugin.requestPermissions();
  }
  if (perm.receive !== 'granted') {
    log.info('Push permission not granted: %s', perm.receive);
    return 'denied';
  }

  return startRegistration(plugin);
}

/**
 * Re-register the device without ever showing the permission dialog: used by
 * every automatic path (app start with a restored session, an identity becoming
 * active). Returns `deferred` while onboarding is still running — the AID is
 * created mid-flow (ProfileFormScreen), long before §7 allows a prompt — and
 * `denied` when permission was never granted, since asking for it here is
 * exactly what §7 forbids.
 */
export async function registerIfPermitted(): Promise<PermissionOutcome> {
  if (!isPushPlatform()) return 'unsupported';
  const plugin = getPushNotificationsPlugin();
  if (!plugin) return 'unavailable';
  if (!isOnboardingComplete()) {
    log.info('Skipping push registration — onboarding still in progress (§7)');
    return 'deferred';
  }
  if (!useNotificationsStore().pushEnabled) return 'disabled';

  const aid = currentAid();
  if (aid !== null && aid === registeredAid) return 'granted'; // already registered this launch

  ensurePushListeners();

  const perm = await plugin.checkPermissions();
  if (perm.receive !== 'granted') {
    log.info('Not re-registering: push permission is %s (never prompting here)', perm.receive);
    return 'denied';
  }

  return startRegistration(plugin);
}

/** Store the token and register it with the backend (§7 — grant + rotation). */
export async function handleRegistrationToken(token: string): Promise<void> {
  const rotated = currentToken !== null && currentToken !== token;
  currentToken = token;
  const notifStore = useNotificationsStore();
  if (!notifStore.pushEnabled) return; // globally opted out — don't register
  log.info('%s FCM token → backend', rotated ? 'Rotated' : 'New');
  const result = await registerPushToken(token);
  if (!result.success) {
    // Silence here is how push dies unnoticed: no token at the relay means no
    // doorbell, with nothing in the log to say so.
    log.error('Push token registration failed: %s', result.error ?? 'unknown error');
  }
}

/**
 * Deregister the current token (logout / identity switch / opt-out).
 *
 * MUST run while the KERI-signed session is still valid: under
 * MATOU_REQUIRE_SIGNED_AUTH the backend 401s once the session token is gone,
 * and the relay would keep waking a device that no longer holds the AID (§7).
 * The failure is logged rather than discarded, and returned so callers can act.
 */
export async function deregisterPush(): Promise<PushRegisterResult> {
  const token = currentToken;
  currentToken = null;
  registeredAid = null;
  if (!token && !isPushPlatform()) {
    return { success: true }; // nothing was ever registered from this platform
  }
  const result = await deregisterPushToken(token ?? undefined);
  if (!result.success) {
    log.error(
      'Push deregistration failed (%s) — the relay may keep waking this device',
      result.error ?? 'unknown error',
    );
  }
  return result;
}

/**
 * React to a change of the active identity.
 *
 * Logout deregisters (unless the token was already released while the session
 * was still valid — see stores/identity `disconnect`), and a switch deregisters
 * the old mapping then registers the new one. A `null → AID` transition
 * deliberately does NOT register here: that is a first-time member creating
 * their AID mid-onboarding, and prompting there is what §7 forbids. The
 * eligibility watcher in ensurePushListeners picks it up once onboarding
 * completes, without a prompt.
 */
export async function handleIdentityChange(
  newAid: string | null,
  oldAid: string | null,
): Promise<void> {
  if (newAid === oldAid) return;
  if (oldAid && currentToken !== null) {
    await deregisterPush();
  }
  if (newAid && oldAid && isPushPlatform()) {
    // Identity switch: permission was granted for the previous identity, so
    // this cannot surface a dialog mid-onboarding.
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
  // `k` selects the Android channel, and with it the §3 importance tier.
  const kind: MessageKind = data.k === 'dm' ? 'dm' : 'ch';

  const synced = await syncChannel(channelId);

  // Badge reflects reality regardless of per-channel mute / global toggle.
  recomputeBadge();

  const notifStore = useNotificationsStore();
  if (!notifStore.shouldNotifyForChannel(channelId)) return null;

  // Content-free default: resolve the name locally, fall back to generic text
  // if sync failed or the channel is unknown (§4).
  const channelName = synced ? resolveChannelName(channelId) : null;
  const title = channelName ? `New message in ${channelName}` : 'New messages';
  const composed: ComposedNotification = { channelId, title, kind };

  presentCoalesced(composed);
  return composed;
}

/**
 * Present the composed notification, coalescing a burst in one channel (§5).
 *
 * Leading edge: the first message of a burst rings immediately — a trailing-only
 * debounce delays every notification by the whole window, and a WebView that
 * Android suspends right after the wake may never run the timer at all, so the
 * doorbell would simply never ring. Later messages inside the window are folded
 * into one trailing update, emitted only when it would actually say something
 * new (same notification id, so it replaces rather than stacks).
 */
function presentCoalesced(notif: ComposedNotification): void {
  const state = coalesceStates.get(notif.channelId);
  if (state) {
    state.pending = notif;
    return;
  }
  presentLocalNotification(notif);
  coalesceStates.set(notif.channelId, {
    timer: setTimeout(() => closeCoalesceWindow(notif.channelId), COALESCE_WINDOW_MS),
    presentedTitle: notif.title,
    pending: null,
  });
}

/** End of a burst window: emit the trailing update if it changed anything. */
function closeCoalesceWindow(channelId: string): void {
  const state = coalesceStates.get(channelId);
  coalesceStates.delete(channelId);
  if (!state?.pending) return;
  if (state.pending.title === state.presentedTitle) return; // nothing new to say
  presentLocalNotification(state.pending);
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
        channelId: notif.kind === 'dm' ? ANDROID_CHANNEL_DM : ANDROID_CHANNEL_GROUP,
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
  registeredAid = null;
  listenersRegistered = false;
  coalesceStates.forEach((s) => clearTimeout(s.timer));
  coalesceStates.clear();
}

/** Ergonomic accessor for components/composables. */
export function usePush() {
  return {
    isPushPlatform,
    ensurePushListeners,
    requestPermissionAndRegister,
    registerIfPermitted,
    deregisterPush,
    applyPushEnabled,
    handlePushReceipt,
    handlePushTap,
    recomputeBadge,
  };
}
