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

export const useNotificationsStore = defineStore('notifications', () => {
  const notifications = ref<AppNotification[]>([]);
  const unreadCount = computed(() => notifications.value.filter(n => !n.read).length);

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
  };
});
