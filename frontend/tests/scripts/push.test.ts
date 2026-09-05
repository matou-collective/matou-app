/**
 * Frontend push-notification lifecycle + receipt handling (#249, refs #177).
 *
 * Covers the contract of docs/architecture/08-push-notifications.md §3–§8 with
 * the Capacitor plugins mocked (injected as window.Capacitor.Plugins.*, the same
 * pattern as platform.test.ts / secure-storage.test.ts — no @capacitor/* import,
 * no device):
 *  - permission is requested only when onboarding completes, never during —
 *    including the AID a first-time member creates mid-flow;
 *  - register on grant, re-register on token rotation and on app start,
 *    deregister on logout/switch — and deregister BEFORE the signed session is
 *    torn down, or the backend 401s the call;
 *  - the visible notification is posted on an Android channel the native shell
 *    actually registered (matou_dm / matou_channel), selected from the payload;
 *  - preference gating (global toggle + per-channel mute) drives the visible
 *    notification;
 *  - payload → content-free notification composition (name vs generic fallback);
 *  - launcher badge recompute;
 *  - /chat?c= deep-link on tap.
 *
 * The tests/scripts vitest env is `node` (no jsdom/window), so window is installed
 * by hand. stores/chat is mocked to keep its heavy any-sync imports out of the
 * unit test; the identity store is REAL (with its KERI/API/storage dependencies
 * mocked, as in backend-start-boot-guard.test.ts) so the lifecycle tests drive
 * the actual watcher wiring and the actual disconnect() teardown ordering, and
 * the notifications/onboarding stores are real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { nextTick, ref } from 'vue';
import type { AIDInfo } from 'src/lib/keri/client';

// --- Backend API: spy on register/deregister -------------------------------
const registerPushToken = vi.fn(async (): Promise<{ success: boolean; error?: string }> => ({
  success: true,
}));
const deregisterPushToken = vi.fn(async (): Promise<{ success: boolean; error?: string }> => ({
  success: true,
}));
const getRelayChallenge = vi.fn(async () => ({
  aid: 'aid-a',
  challenge: 'nonce',
  expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
}));
const postRelaySession = vi.fn(async () => ({
  expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
}));
vi.mock('src/lib/api/push', () => ({
  registerPushToken: (t: string) => registerPushToken(t),
  deregisterPushToken: (t?: string) => deregisterPushToken(t),
  getRelayChallenge: () => getRelayChallenge(),
  postRelaySession: (c: string, s: string) => postRelaySession(c, s),
}));

// --- Chat store: lightweight fake ------------------------------------------
const chatStoreMock: {
  channels: Array<{ id: string; name: string; isArchived?: boolean }>;
  totalUnreadCount: number;
} = { channels: [], totalUnreadCount: 0 };
vi.mock('stores/chat', () => ({
  useChatStore: () => chatStoreMock,
}));

// --- Identity-store dependencies: mocked so the REAL store is usable here ---
const setSessionToken = vi.fn();
vi.mock('src/lib/api/client', () => ({
  setSessionToken: (...args: unknown[]) => setSessionToken(...args),
  getUserSpaces: vi.fn(async () => ({})),
  verifyCommunityAccess: vi.fn(async () => ({ hasAccess: false })),
  joinCommunity: vi.fn(async () => ({})),
  getAuthChallenge: vi.fn(async () => ({ challenge: '', expiresAt: '' })),
  postAuthLogin: vi.fn(async () => ({ token: '', expiresAt: '' })),
  authHeaders: () => ({ 'Content-Type': 'application/json' }),
  BACKEND_URL: 'http://127.0.0.1:8080',
}));
const signChallenge = vi.fn(async () => 'sig');
vi.mock('src/lib/keri/client', () => ({
  KERIClient: class {},
  useKERIClient: () => ({
    setOrgAID: vi.fn(),
    getSignifyClient: () => null,
    signChallenge: (c: string, a: string) => signChallenge(c, a),
  }),
  initKeriConfig: vi.fn(),
}));
vi.mock('src/lib/secureStorage', () => ({
  secureStorage: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));
vi.mock('src/api/config', () => ({
  fetchOrgConfig: vi.fn(),
  getCachedConfig: vi.fn(() => null),
}));

// --- Capacitor plugin fakes ------------------------------------------------
type Listener = (arg: unknown) => void;

interface FakePush {
  listeners: Record<string, Listener>;
  checkPermissions: ReturnType<typeof vi.fn>;
  requestPermissions: ReturnType<typeof vi.fn>;
  register: ReturnType<typeof vi.fn>;
  addListener: ReturnType<typeof vi.fn>;
  emit(event: string, arg: unknown): void;
}

function makePush(initial: string): FakePush {
  const listeners: Record<string, Listener> = {};
  return {
    listeners,
    checkPermissions: vi.fn(async () => ({ receive: initial })),
    requestPermissions: vi.fn(async () => ({ receive: 'granted' })),
    register: vi.fn(async () => undefined),
    addListener: vi.fn((event: string, fn: Listener) => {
      listeners[event] = fn;
      return undefined;
    }),
    emit(event: string, arg: unknown) {
      listeners[event]?.(arg);
    },
  };
}

interface FakePlugins {
  push?: FakePush;
  syncChannel?: ReturnType<typeof vi.fn>;
  schedule?: ReturnType<typeof vi.fn>;
  badgeSet?: ReturnType<typeof vi.fn>;
}

function installCapacitor(
  opts: {
    platform?: string;
    native?: boolean;
    /** MatouBackend.isPushAvailable() result — the Firebase-present signal (#384). */
    pushAvailable?: boolean;
    /** Omit isPushAvailable entirely — a shell that predates the check (#384). */
    omitPushAvailability?: boolean;
  } & FakePlugins = {},
) {
  const { platform = 'android', native = true, pushAvailable = true } = opts;
  const Plugins: Record<string, unknown> = {};
  if (opts.push) Plugins.PushNotifications = opts.push;
  // The MatouBackend plugin carries both syncChannel and the push-availability
  // check; ship it whenever either is exercised.
  const matouBackend: Record<string, unknown> = {};
  if (opts.syncChannel) matouBackend.syncChannel = opts.syncChannel;
  if (opts.push && !opts.omitPushAvailability) {
    matouBackend.isPushAvailable = vi.fn(async () => ({ available: pushAvailable }));
  }
  if (Object.keys(matouBackend).length > 0) Plugins.MatouBackend = matouBackend;
  if (opts.schedule) Plugins.LocalNotifications = { schedule: opts.schedule };
  if (opts.badgeSet) Plugins.Badge = { set: opts.badgeSet };
  (globalThis as unknown as { window: unknown }).window = {
    Capacitor: {
      isNativePlatform: () => native,
      getPlatform: () => platform,
      Plugins,
    },
  };
}

function installBrowser() {
  (globalThis as unknown as { window: unknown }).window = {};
}

/** A router stub complete enough for both setPushRouter consumers. */
function makeRouter(path = '/') {
  return {
    push: vi.fn(),
    currentRoute: ref({ path }),
  };
}

async function loadPush() {
  return import('../../src/composables/usePush');
}

/** Let the pre-flush watchers and the promise chains they start settle. */
async function settle() {
  for (let i = 0; i < 8; i++) {
    await nextTick();
    await Promise.resolve();
  }
}

function aidInfo(prefix: string): AIDInfo {
  return { prefix } as AIDInfo;
}

/** The real identity store, from the same module registry as usePush. */
async function identityStore() {
  const { useIdentityStore } = await import('../../src/stores/identity');
  return useIdentityStore();
}

async function onboardingStore() {
  const { useOnboardingStore } = await import('../../src/stores/onboarding');
  return useOnboardingStore();
}

/** Drive a granted registration with a live token, as a real device would. */
async function registerWithToken(fake: FakePush, token = 'token-a') {
  const push = await loadPush();
  await push.requestPermissionAndRegister();
  fake.emit('registration', { value: token });
  await settle();
  return push;
}

describe('usePush (#249)', () => {
  beforeEach(async () => {
    vi.resetModules();
    setActivePinia(createPinia());
    registerPushToken.mockClear();
    registerPushToken.mockResolvedValue({ success: true });
    deregisterPushToken.mockClear();
    deregisterPushToken.mockResolvedValue({ success: true });
    getRelayChallenge.mockClear();
    postRelaySession.mockClear();
    signChallenge.mockClear();
    setSessionToken.mockClear();
    chatStoreMock.channels = [];
    chatStoreMock.totalUnreadCount = 0;
    const push = await loadPush();
    push.__resetPushForTest();
  });

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
    vi.restoreAllMocks();
  });

  describe('permission after onboarding (§7)', () => {
    it('is a no-op off the Android platform (web/Electron)', async () => {
      installBrowser();
      const push = await loadPush();
      expect(await push.requestPermissionAndRegister()).toBe('unsupported');
      expect(registerPushToken).not.toHaveBeenCalled();
    });

    it('requests permission and registers the token on grant', async () => {
      const fake = makePush('prompt');
      installCapacitor({ push: fake });
      const push = await loadPush();

      const outcome = await push.requestPermissionAndRegister();
      expect(outcome).toBe('granted');
      expect(fake.requestPermissions).toHaveBeenCalledTimes(1);
      expect(fake.register).toHaveBeenCalledTimes(1);

      // The plugin then fires the registration event with the FCM token.
      fake.emit('registration', { value: 'fcm-token-1' });
      await settle();
      expect(registerPushToken).toHaveBeenCalledWith('fcm-token-1');
    });

    it('does not re-prompt when permission is already granted', async () => {
      const fake = makePush('granted');
      installCapacitor({ push: fake });
      const push = await loadPush();

      expect(await push.requestPermissionAndRegister()).toBe('granted');
      expect(fake.requestPermissions).not.toHaveBeenCalled();
      expect(fake.register).toHaveBeenCalledTimes(1);
    });

    it('does not register when the user denies permission', async () => {
      const fake = makePush('prompt');
      fake.requestPermissions.mockResolvedValue({ receive: 'denied' });
      installCapacitor({ push: fake });
      const push = await loadPush();

      expect(await push.requestPermissionAndRegister()).toBe('denied');
      expect(fake.register).not.toHaveBeenCalled();
      expect(registerPushToken).not.toHaveBeenCalled();
    });

    it('is invoked when onboarding completes, not before', async () => {
      const fake = makePush('prompt');
      installCapacitor({ push: fake });
      // useOnboarding calls requestPermissionAndRegister() from completeOnboarding.
      const { useOnboarding } = await import('../../src/composables/useOnboarding');
      const onboarding = useOnboarding();
      expect(fake.requestPermissions).not.toHaveBeenCalled();

      onboarding.completeOnboarding();
      await settle();
      expect(fake.requestPermissions).toHaveBeenCalledTimes(1);
    });

    it('does NOT prompt when the AID is created mid-onboarding (§7)', async () => {
      // A first-time member creates their AID on the profile-form screen
      // (ProfileFormScreen), long before onboarding completes. The lifecycle
      // watchers must not turn that null → AID transition into a system dialog.
      const fake = makePush('prompt');
      installCapacitor({ push: fake });
      const push = await loadPush();
      push.ensurePushListeners();

      const onboarding = await onboardingStore();
      onboarding.navigateTo('profile-form');
      const identity = await identityStore();
      identity.currentAID = aidInfo('EAID-new-member');
      await settle();

      expect(fake.requestPermissions).not.toHaveBeenCalled();
      expect(fake.register).not.toHaveBeenCalled();
      expect(registerPushToken).not.toHaveBeenCalled();
      expect(await push.registerIfPermitted()).toBe('deferred');
    });

    it('prompts once onboarding completes, for the AID created mid-flow', async () => {
      const fake = makePush('prompt');
      installCapacitor({ push: fake });
      const push = await loadPush();
      push.ensurePushListeners();

      const identity = await identityStore();
      identity.currentAID = aidInfo('EAID-new-member');
      await settle();
      expect(fake.requestPermissions).not.toHaveBeenCalled();

      const { useOnboarding } = await import('../../src/composables/useOnboarding');
      useOnboarding().completeOnboarding();
      await settle();

      expect(fake.requestPermissions).toHaveBeenCalledTimes(1);
      expect(fake.register).toHaveBeenCalledTimes(1);
    });
  });

  describe('Firebase availability gate (#384)', () => {
    it('never calls register() on a config-less build (Firebase unavailable)', async () => {
      // The push plugin is compiled in, but no google-services.json was baked,
      // so the default FirebaseApp never initialised. Calling native register()
      // would throw a fatal IllegalStateException and kill the process — the JS
      // must short-circuit to 'unavailable' before ever reaching it.
      const fake = makePush('granted');
      installCapacitor({ push: fake, pushAvailable: false });
      const push = await loadPush();

      expect(await push.requestPermissionAndRegister()).toBe('unavailable');
      expect(await push.registerIfPermitted()).toBe('unavailable');
      expect(fake.requestPermissions).not.toHaveBeenCalled();
      expect(fake.register).not.toHaveBeenCalled();
      expect(registerPushToken).not.toHaveBeenCalled();
    });

    it('fails safe to unavailable when the bridge check is absent', async () => {
      // A shell built before MatouBackend.isPushAvailable landed must degrade to
      // unavailable rather than assume push is safe to register.
      const fake = makePush('granted');
      installCapacitor({ push: fake, omitPushAvailability: true });
      const push = await loadPush();

      expect(await push.requestPermissionAndRegister()).toBe('unavailable');
      expect(await push.registerIfPermitted()).toBe('unavailable');
      expect(fake.register).not.toHaveBeenCalled();
    });

    it('the app-start watcher does not register on a config-less build', async () => {
      // The identity-active watcher (boot session-restore) funnels through
      // registerIfPermitted; it too must no-op rather than crash (#384).
      const fake = makePush('granted');
      installCapacitor({ push: fake, pushAvailable: false });
      const identity = await identityStore();
      identity.currentAID = aidInfo('EAID-returning');
      (await onboardingStore()).navigateTo('main');

      const push = await loadPush();
      push.ensurePushListeners();
      await settle();

      expect(fake.register).not.toHaveBeenCalled();
      expect(registerPushToken).not.toHaveBeenCalled();
    });

    it('registers as before when Firebase is available', async () => {
      const fake = makePush('granted');
      installCapacitor({ push: fake, pushAvailable: true });
      const push = await loadPush();

      expect(await push.requestPermissionAndRegister()).toBe('granted');
      expect(fake.register).toHaveBeenCalledTimes(1);
    });
  });

  describe('app-start re-registration (§7)', () => {
    it('refreshes the token at start when onboarding is complete and permission granted', async () => {
      // Boot restores the identity before the push boot file runs, so there is
      // no null → AID transition to react to; without an explicit refresh the
      // relay's TTL prunes the token and push dies silently.
      const fake = makePush('granted');
      installCapacitor({ push: fake });
      const identity = await identityStore();
      identity.currentAID = aidInfo('EAID-returning');
      (await onboardingStore()).navigateTo('main');

      const push = await loadPush();
      push.ensurePushListeners(); // what boot/push.ts does
      await settle();

      expect(fake.register).toHaveBeenCalledTimes(1);
      expect(fake.requestPermissions).not.toHaveBeenCalled(); // never prompts here

      fake.emit('registration', { value: 'token-refreshed' });
      await settle();
      expect(registerPushToken).toHaveBeenCalledWith('token-refreshed');
    });

    it('refreshes for a returning member who lands straight in the dashboard', async () => {
      // The returning path is splash → welcome-overlay → /dashboard and never
      // passes through the 'main' screen, so the dashboard route is the
      // completion signal for this shape of onboarding.
      const fake = makePush('granted');
      installCapacitor({ push: fake });
      const push = await loadPush();
      const router = makeRouter('/');
      push.setPushRouter(router as never);
      push.ensurePushListeners();

      const identity = await identityStore();
      identity.currentAID = aidInfo('EAID-returning');
      await settle();
      // Still on the onboarding route — nothing may be registered yet.
      expect(fake.register).not.toHaveBeenCalled();

      router.currentRoute.value = { path: '/dashboard' };
      await settle();

      expect(fake.register).toHaveBeenCalledTimes(1);
      expect(fake.requestPermissions).not.toHaveBeenCalled();
    });

    it('does not prompt at start when permission was never granted', async () => {
      const fake = makePush('prompt');
      installCapacitor({ push: fake });
      const identity = await identityStore();
      identity.currentAID = aidInfo('EAID-returning');
      (await onboardingStore()).navigateTo('main');

      const push = await loadPush();
      push.ensurePushListeners();
      await settle();

      expect(fake.requestPermissions).not.toHaveBeenCalled();
      expect(fake.register).not.toHaveBeenCalled();
      expect(await push.registerIfPermitted()).toBe('denied');
    });

    it('does not re-register at start when push is globally disabled', async () => {
      const fake = makePush('granted');
      installCapacitor({ push: fake });
      const { useNotificationsStore } = await import('../../src/stores/notifications');
      useNotificationsStore().setPushEnabled(false);
      const identity = await identityStore();
      identity.currentAID = aidInfo('EAID-returning');
      (await onboardingStore()).navigateTo('main');

      const push = await loadPush();
      push.ensurePushListeners();
      await settle();

      expect(fake.register).not.toHaveBeenCalled();
      expect(await push.registerIfPermitted()).toBe('disabled');
    });

    it('logs a failed backend registration instead of swallowing it', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      registerPushToken.mockResolvedValue({ success: false, error: 'HTTP 401' });
      const fake = makePush('granted');
      installCapacitor({ push: fake });
      const push = await loadPush();

      await push.requestPermissionAndRegister();
      fake.emit('registration', { value: 'token-a' });
      await settle();

      expect(errorSpy).toHaveBeenCalled();
      expect(errorSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
        'Push token registration failed',
      );
    });
  });

  describe('token lifecycle (§7)', () => {
    it('re-registers on FCM token rotation', async () => {
      const fake = makePush('granted');
      installCapacitor({ push: fake });
      const push = await loadPush();
      await push.requestPermissionAndRegister();

      fake.emit('registration', { value: 'token-a' });
      await settle();
      fake.emit('registration', { value: 'token-b' });
      await settle();

      expect(registerPushToken).toHaveBeenNthCalledWith(1, 'token-a');
      expect(registerPushToken).toHaveBeenNthCalledWith(2, 'token-b');
    });

    it('deregisters the current token', async () => {
      const fake = makePush('granted');
      installCapacitor({ push: fake });
      const push = await registerWithToken(fake);

      await push.deregisterPush();
      expect(deregisterPushToken).toHaveBeenCalledWith('token-a');
    });

    it('deregisters via the identity watcher when the AID is cleared', async () => {
      const fake = makePush('granted');
      installCapacitor({ push: fake });
      const push = await registerWithToken(fake);
      push.ensurePushListeners();

      const identity = await identityStore();
      identity.currentAID = aidInfo('EAID-a');
      await settle();
      deregisterPushToken.mockClear();

      identity.currentAID = null; // logout that bypasses disconnect()
      await settle();

      expect(deregisterPushToken).toHaveBeenCalledTimes(1);
      expect(deregisterPushToken).toHaveBeenCalledWith('token-a');
    });

    it('re-registers on an identity switch driven through the store', async () => {
      const fake = makePush('granted');
      installCapacitor({ push: fake });
      const push = await registerWithToken(fake);
      push.ensurePushListeners();

      const identity = await identityStore();
      identity.currentAID = aidInfo('EAID-old');
      await settle();
      deregisterPushToken.mockClear();
      fake.register.mockClear();

      identity.currentAID = aidInfo('EAID-new');
      await settle();

      expect(deregisterPushToken).toHaveBeenCalledTimes(1);
      expect(fake.register).toHaveBeenCalledTimes(1);
    });

    it('deregisters BEFORE disconnect() tears the signed session down', async () => {
      // POST /push/deregister is authenticated: once setSessionToken(null) has
      // run the backend 401s it and the relay keeps waking this device (§7).
      const fake = makePush('granted');
      installCapacitor({ push: fake });
      const push = await registerWithToken(fake);
      push.ensurePushListeners();

      const identity = await identityStore();
      identity.currentAID = aidInfo('EAID-old');
      await settle();
      deregisterPushToken.mockClear();
      setSessionToken.mockClear();

      await identity.disconnect();
      await settle();

      expect(deregisterPushToken).toHaveBeenCalledWith('token-a');
      expect(setSessionToken).toHaveBeenCalledWith(null);
      expect(deregisterPushToken.mock.invocationCallOrder[0]).toBeLessThan(
        setSessionToken.mock.invocationCallOrder[0]!,
      );
      // And the identity watcher must not fire a second, now-unauthenticated call.
      expect(deregisterPushToken).toHaveBeenCalledTimes(1);
    });

    it('surfaces a failed deregistration instead of discarding it', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      deregisterPushToken.mockResolvedValue({ success: false, error: 'HTTP 401' });
      const fake = makePush('granted');
      installCapacitor({ push: fake });
      const push = await registerWithToken(fake);

      const result = await push.deregisterPush();
      expect(result).toEqual({ success: false, error: 'HTTP 401' });
      expect(errorSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
        'Push deregistration failed',
      );
    });

    it('does not register the token when push is globally disabled', async () => {
      const fake = makePush('granted');
      installCapacitor({ push: fake });
      const push = await loadPush();
      const { useNotificationsStore } = await import('../../src/stores/notifications');
      useNotificationsStore().setPushEnabled(false);

      await push.handleRegistrationToken('token-a');
      expect(registerPushToken).not.toHaveBeenCalled();
    });
  });

  describe('Android notification channel (§3–§4)', () => {
    beforeEach(() => {
      chatStoreMock.channels = [{ id: 'chan-1', name: 'general' }];
    });

    it('posts a DM on the high-importance matou_dm channel', async () => {
      const syncChannel = vi.fn(async () => undefined);
      const schedule = vi.fn(async () => undefined);
      installCapacitor({ syncChannel, schedule });
      const push = await loadPush();

      const composed = await push.handlePushReceipt({ t: 'm', c: 'chan-1', k: 'dm', v: '1' });
      expect(composed?.kind).toBe('dm');
      // Android 8+ silently drops notifications posted to an unregistered
      // channel id — this must match MatouNotificationChannels.DM.
      expect(schedule.mock.calls[0]?.[0].notifications[0].channelId).toBe('matou_dm');
    });

    it('posts a channel message on the default-importance matou_channel', async () => {
      const syncChannel = vi.fn(async () => undefined);
      const schedule = vi.fn(async () => undefined);
      installCapacitor({ syncChannel, schedule });
      const push = await loadPush();

      const composed = await push.handlePushReceipt({ t: 'm', c: 'chan-1', k: 'ch', v: '1' });
      expect(composed?.kind).toBe('ch');
      expect(schedule.mock.calls[0]?.[0].notifications[0].channelId).toBe('matou_channel');
    });

    it('treats an unknown/absent kind as a channel message', async () => {
      const syncChannel = vi.fn(async () => undefined);
      const schedule = vi.fn(async () => undefined);
      installCapacitor({ syncChannel, schedule });
      const push = await loadPush();

      await push.handlePushReceipt({ t: 'm', c: 'chan-1' });
      expect(schedule.mock.calls[0]?.[0].notifications[0].channelId).toBe('matou_channel');
    });
  });

  describe('receipt handler + preference gating (§4–§7)', () => {
    beforeEach(() => {
      chatStoreMock.channels = [{ id: 'chan-1', name: 'general' }];
      chatStoreMock.totalUnreadCount = 3;
    });

    it('composes "New message in {channelName}" after a successful sync', async () => {
      const syncChannel = vi.fn(async () => undefined);
      const schedule = vi.fn(async () => undefined);
      installCapacitor({ syncChannel, schedule });
      const push = await loadPush();

      const composed = await push.handlePushReceipt({ t: 'm', c: 'chan-1', k: 'ch', v: '1' });
      expect(syncChannel).toHaveBeenCalledWith({ channelId: 'chan-1' });
      expect(composed).toEqual({ channelId: 'chan-1', title: 'New message in general', kind: 'ch' });
    });

    it('falls back to a generic notification when sync fails', async () => {
      const syncChannel = vi.fn(async () => {
        throw new Error('offline');
      });
      installCapacitor({ syncChannel });
      const push = await loadPush();

      const composed = await push.handlePushReceipt({ t: 'm', c: 'chan-1' });
      expect(composed).toEqual({ channelId: 'chan-1', title: 'New messages', kind: 'ch' });
    });

    it('ignores non-message payloads', async () => {
      installCapacitor({});
      const push = await loadPush();
      expect(await push.handlePushReceipt({ t: 'x', c: 'chan-1' })).toBeNull();
      expect(await push.handlePushReceipt(undefined)).toBeNull();
      expect(await push.handlePushReceipt({ t: 'm' })).toBeNull();
    });

    it('suppresses the visible notification when push is globally disabled', async () => {
      const syncChannel = vi.fn(async () => undefined);
      installCapacitor({ syncChannel });
      const push = await loadPush();
      const { useNotificationsStore } = await import('../../src/stores/notifications');
      useNotificationsStore().setPushEnabled(false);

      const composed = await push.handlePushReceipt({ t: 'm', c: 'chan-1' });
      expect(composed).toBeNull();
      // But it still synced the channel to keep local state fresh.
      expect(syncChannel).toHaveBeenCalled();
    });

    it('suppresses the visible notification for a muted channel', async () => {
      const syncChannel = vi.fn(async () => undefined);
      installCapacitor({ syncChannel });
      const push = await loadPush();
      const { useNotificationsStore } = await import('../../src/stores/notifications');
      useNotificationsStore().toggleChannelMute('chan-1');

      expect(await push.handlePushReceipt({ t: 'm', c: 'chan-1' })).toBeNull();
    });

    it('recomputes the launcher badge from local unread state', async () => {
      const syncChannel = vi.fn(async () => undefined);
      const badgeSet = vi.fn(async () => undefined);
      installCapacitor({ syncChannel, badgeSet });
      const push = await loadPush();

      await push.handlePushReceipt({ t: 'm', c: 'chan-1' });
      expect(badgeSet).toHaveBeenCalledWith({ count: 3 });
    });

    it('rings on the leading edge and coalesces the rest of the burst (§5)', async () => {
      vi.useFakeTimers();
      try {
        const syncChannel = vi.fn(async () => undefined);
        const schedule = vi.fn(async () => undefined);
        installCapacitor({ syncChannel, schedule });
        const push = await loadPush();

        await push.handlePushReceipt({ t: 'm', c: 'chan-1' });
        // Trailing-edge-only debouncing delays every notification by the whole
        // window, and a WebView Android suspends may never run the timer.
        expect(schedule).toHaveBeenCalledTimes(1);

        await push.handlePushReceipt({ t: 'm', c: 'chan-1' });
        await push.handlePushReceipt({ t: 'm', c: 'chan-1' });
        expect(schedule).toHaveBeenCalledTimes(1); // folded into the first

        vi.runAllTimers();
        // Nothing new to say (same composed title) — no redundant re-post.
        expect(schedule).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('emits one trailing update when the burst changes what the notification says', async () => {
      vi.useFakeTimers();
      try {
        const syncChannel = vi.fn(async () => undefined);
        const schedule = vi.fn(async () => undefined);
        chatStoreMock.channels = [];
        installCapacitor({ syncChannel, schedule });
        const push = await loadPush();

        // First wake: the channel is not known locally yet → generic title.
        await push.handlePushReceipt({ t: 'm', c: 'chan-1' });
        expect(schedule).toHaveBeenCalledTimes(1);

        // The sync lands, so the next message in the window can name it.
        chatStoreMock.channels = [{ id: 'chan-1', name: 'general' }];
        await push.handlePushReceipt({ t: 'm', c: 'chan-1' });
        vi.runAllTimers();

        expect(schedule).toHaveBeenCalledTimes(2);
        const first = schedule.mock.calls[0]?.[0].notifications[0];
        const second = schedule.mock.calls[1]?.[0].notifications[0];
        expect(first.title).toBe('New messages');
        expect(second.title).toBe('New message in general');
        expect(second.id).toBe(first.id); // replaces rather than stacks
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('deep-link on tap (§6)', () => {
    it('routes /chat?c=<channelId> on notification tap', async () => {
      installCapacitor({});
      const push = await loadPush();
      const router = makeRouter();
      push.setPushRouter(router as never);

      push.handlePushTap({ t: 'm', c: 'chan-42' });
      expect(router.push).toHaveBeenCalledWith({ name: 'chat', query: { c: 'chan-42' } });
    });

    it('does nothing when the payload has no channel id', async () => {
      installCapacitor({});
      const push = await loadPush();
      const router = makeRouter();
      push.setPushRouter(router as never);

      push.handlePushTap({ t: 'm' });
      expect(router.push).not.toHaveBeenCalled();
    });
  });
});
