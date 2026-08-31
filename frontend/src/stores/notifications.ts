import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { createLogger } from 'src/lib/logging';

const log = createLogger('NotificationsStore');

export interface AppNotification {
  id: string;
  type: string;
  recipient_id: string;
  title: string;
  message: string;
  entity_id: string;
  entity_type: string;
  read: boolean;
  created_at: string;
}

/**
 * Push-notification preferences (docs/architecture/08-push-notifications.md §7).
 * `enabled` is the global toggle that drives register/deregister; `mutedChannels`
 * suppresses the visible notification for specific channels. Persisted to
 * localStorage so the choice survives restarts.
 */
export interface PushPreferences {
  enabled: boolean;
  mutedChannels: string[];
}

const PUSH_PREFS_KEY = 'matou:pushPrefs';

function loadPushPrefs(): PushPreferences {
  const fallback: PushPreferences = { enabled: true, mutedChannels: [] };
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(PUSH_PREFS_KEY) : null;
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<PushPreferences>;
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : true,
      mutedChannels: Array.isArray(parsed.mutedChannels)
        ? parsed.mutedChannels.filter((c): c is string => typeof c === 'string')
        : [],
    };
  } catch {
    return fallback;
  }
}

export const useNotificationsStore = defineStore('notifications', () => {
  const notifications = ref<AppNotification[]>([]);
  const unreadCount = computed(() => notifications.value.filter(n => !n.read).length);

  // --- Push preferences -----------------------------------------------------
  const push = ref<PushPreferences>(loadPushPrefs());

  function persistPushPrefs() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(PUSH_PREFS_KEY, JSON.stringify(push.value));
      }
    } catch {
      // Best-effort persistence; a full/blocked localStorage must not crash the app.
    }
  }

  const pushEnabled = computed(() => push.value.enabled);

  function setPushEnabled(enabled: boolean) {
    push.value.enabled = enabled;
    persistPushPrefs();
  }

  function isChannelMuted(channelId: string): boolean {
    return push.value.mutedChannels.includes(channelId);
  }

  function setChannelMuted(channelId: string, muted: boolean) {
    const already = push.value.mutedChannels.includes(channelId);
    if (muted && !already) {
      push.value.mutedChannels.push(channelId);
    } else if (!muted && already) {
      push.value.mutedChannels = push.value.mutedChannels.filter(c => c !== channelId);
    }
    persistPushPrefs();
  }

  function toggleChannelMute(channelId: string) {
    setChannelMuted(channelId, !isChannelMuted(channelId));
  }

  /**
   * Whether a received push for `channelId` should produce a visible
   * notification: only when push is globally enabled and the channel isn't muted.
   */
  function shouldNotifyForChannel(channelId: string): boolean {
    return push.value.enabled && !isChannelMuted(channelId);
  }

  function addNotification(notif: AppNotification) {
    notifications.value.unshift(notif);
    log.info('Notification received: %s', notif.type);

    // Electron / browser native notification
    if (window.Notification && Notification.permission === 'granted') {
      new Notification(notif.title, { body: notif.message });
    }
  }

  function markRead(id: string) {
    const notif = notifications.value.find(n => n.id === id);
    if (notif) notif.read = true;
  }

  function markAllRead() {
    notifications.value.forEach(n => {
      n.read = true;
    });
  }

  function clear() {
    notifications.value = [];
  }

  return {
    notifications,
    unreadCount,
    addNotification,
    markRead,
    markAllRead,
    clear,

    // Push preferences
    push,
    pushEnabled,
    setPushEnabled,
    isChannelMuted,
    setChannelMuted,
    toggleChannelMute,
    shouldNotifyForChannel,
  };
});
