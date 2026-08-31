/**
 * Frontend push-notification lifecycle + receipt handling (#249, refs #177).
 *
 * Covers the contract of docs/architecture/08-push-notifications.md §4–§8 with
 * the Capacitor plugins mocked (injected as window.Capacitor.Plugins.*, the same
 * pattern as platform.test.ts / secure-storage.test.ts — no @capacitor/* import,
 * no device):
 *  - permission is requested only when onboarding completes, never during;
 *  - register on grant, re-register on token rotation, deregister on logout/switch;
 *  - preference gating (global toggle + per-channel mute) drives the visible
 *    notification;
 *  - payload → content-free notification composition (name vs generic fallback);
 *  - launcher badge recompute;
 *  - /chat?c= deep-link on tap.
 *
 * The tests/scripts vitest env is `node` (no jsdom/window), so window is installed
 * by hand. stores/chat and stores/identity are mocked to keep their heavy KERI/
 * any-sync transitive imports out of the unit test; the notifications store is real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

// --- Backend API: spy on register/deregister -------------------------------
const registerPushToken = vi.fn(async () => ({ success: true }));
const deregisterPushToken = vi.fn(async () => ({ success: true }));
vi.mock('src/lib/api/push', () => ({
  registerPushToken: (t: string) => registerPushToken(t),
  deregisterPushToken: (t?: string) => deregisterPushToken(t),
}));

// --- Chat store: lightweight fake ------------------------------------------
const chatStoreMock: {
  channels: Array<{ id: string; name: string; isArchived?: boolean }>;
  totalUnreadCount: number;
} = { channels: [], totalUnreadCount: 0 };
vi.mock('stores/chat', () => ({
  useChatStore: () => chatStoreMock,
}));

// --- Identity store: lightweight fake --------------------------------------
const identityStoreMock: { aidPrefix: string | null } = { aidPrefix: null };
vi.mock('stores/identity', () => ({
  useIdentityStore: () => identityStoreMock,
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
  opts: { platform?: string; native?: boolean } & FakePlugins = {},
) {
  const { platform = 'android', native = true } = opts;
  const Plugins: Record<string, unknown> = {};
  if (opts.push) Plugins.PushNotifications = opts.push;
  if (opts.syncChannel) Plugins.MatouBackend = { syncChannel: opts.syncChannel };
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

async function loadPush() {
  return import('../../src/composables/usePush');
}

describe('usePush (#249)', () => {
  beforeEach(async () => {
    vi.resetModules();
    setActivePinia(createPinia());
    registerPushToken.mockClear();
    deregisterPushToken.mockClear();
    chatStoreMock.channels = [];
    chatStoreMock.totalUnreadCount = 0;
    identityStoreMock.aidPrefix = null;
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
      await Promise.resolve();
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
      for (let i = 0; i < 6; i++) await Promise.resolve();
      expect(fake.requestPermissions).toHaveBeenCalledTimes(1);
    });
  });

  describe('token lifecycle (§7)', () => {
    it('re-registers on FCM token rotation', async () => {
      const fake = makePush('granted');
      installCapacitor({ push: fake });
      const push = await loadPush();
      await push.requestPermissionAndRegister();

      fake.emit('registration', { value: 'token-a' });
      await Promise.resolve();
      fake.emit('registration', { value: 'token-b' });
      await Promise.resolve();

      expect(registerPushToken).toHaveBeenNthCalledWith(1, 'token-a');
      expect(registerPushToken).toHaveBeenNthCalledWith(2, 'token-b');
    });

    it('deregisters the current token', async () => {
      const fake = makePush('granted');
      installCapacitor({ push: fake });
      const push = await loadPush();
      await push.requestPermissionAndRegister();
      fake.emit('registration', { value: 'token-a' });
      await Promise.resolve();

      await push.deregisterPush();
      expect(deregisterPushToken).toHaveBeenCalledWith('token-a');
    });

    it('deregisters on logout and re-registers on identity switch', async () => {
      const fake = makePush('granted');
      installCapacitor({ push: fake });
      const push = await loadPush();
      await push.requestPermissionAndRegister();
      fake.emit('registration', { value: 'token-a' });
      await Promise.resolve();

      // Logout: aid → null.
      await push.handleIdentityChange(null, 'aid-old');
      expect(deregisterPushToken).toHaveBeenCalledTimes(1);

      // Switch: old → new. Deregisters the old, then re-registers for the new.
      deregisterPushToken.mockClear();
      fake.requestPermissions.mockClear();
      await push.handleIdentityChange('aid-new', 'aid-old');
      expect(deregisterPushToken).toHaveBeenCalledTimes(1);
      expect(fake.register).toHaveBeenCalled();
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
      expect(composed).toEqual({ channelId: 'chan-1', title: 'New message in general' });
    });

    it('falls back to a generic notification when sync fails', async () => {
      const syncChannel = vi.fn(async () => {
        throw new Error('offline');
      });
      installCapacitor({ syncChannel });
      const push = await loadPush();

      const composed = await push.handlePushReceipt({ t: 'm', c: 'chan-1' });
      expect(composed).toEqual({ channelId: 'chan-1', title: 'New messages' });
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

    it('coalesces a burst in one channel into a single notification', async () => {
      vi.useFakeTimers();
      try {
        const syncChannel = vi.fn(async () => undefined);
        const schedule = vi.fn(async () => undefined);
        installCapacitor({ syncChannel, schedule });
        const push = await loadPush();

        await push.handlePushReceipt({ t: 'm', c: 'chan-1' });
        await push.handlePushReceipt({ t: 'm', c: 'chan-1' });
        await push.handlePushReceipt({ t: 'm', c: 'chan-1' });
        expect(schedule).not.toHaveBeenCalled(); // debounced
        vi.runAllTimers();
        expect(schedule).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('deep-link on tap (§6)', () => {
    it('routes /chat?c=<channelId> on notification tap', async () => {
      installCapacitor({});
      const push = await loadPush();
      const routerPush = vi.fn();
      push.setPushRouter({ push: routerPush } as never);

      push.handlePushTap({ t: 'm', c: 'chan-42' });
      expect(routerPush).toHaveBeenCalledWith({ name: 'chat', query: { c: 'chan-42' } });
    });

    it('does nothing when the payload has no channel id', async () => {
      installCapacitor({});
      const push = await loadPush();
      const routerPush = vi.fn();
      push.setPushRouter({ push: routerPush } as never);

      push.handlePushTap({ t: 'm' });
      expect(routerPush).not.toHaveBeenCalled();
    });
  });
});
