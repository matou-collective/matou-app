/**
 * Composable for notifications with SSE integration and Electron native notification support.
 * Listens to backend SSE events and routes contribution/proposal events into the store.
 */
import { onMounted, watch } from 'vue';
import { useNotificationsStore, type AppNotification } from 'stores/notifications';
import { useBackendEvents } from './useBackendEvents';
import { createLogger } from 'src/lib/logging';

const log = createLogger('Notifications');

const NOTIFICATION_EVENTS = [
  'proposal:submitted',
  'proposal:endorsed',
  'proposal:approved',
  'project:created',
  'contribution:assigned',
  'contribution:needs_review',
  'contribution:approved',
  'contribution:declined',
  'decision_plan:submitted',
  'decision_plan:signed_off',
];

export function useNotifications() {
  const store = useNotificationsStore();
  const { lastEvent, connect } = useBackendEvents();

  function requestPermission() {
    if (window.Notification && Notification.permission === 'default') {
      Notification.requestPermission().then(perm => {
        log.info('Notification permission: %s', perm);
      });
    }
  }

  function handleEvent(event: { type: string; data: Record<string, string> }) {
    if (!NOTIFICATION_EVENTS.includes(event.type)) return;

    const notif: AppNotification = {
      id: `notif_${Date.now()}`,
      type: event.type,
      recipient_id: event.data.recipient_id || '',
      title: formatTitle(event.type),
      message: event.data.message || formatMessage(event.type, event.data),
      entity_id: event.data.entity_id || '',
      entity_type: event.data.entity_type || '',
      read: false,
      created_at: new Date().toISOString(),
    };
    store.addNotification(notif);
  }

  onMounted(() => {
    requestPermission();
    connect();
  });

  // Watch for new SSE events and route them to the store
  watch(lastEvent, (event) => {
    if (event) handleEvent(event);
  });

  return {
    handleEvent,
    ...store,
  };
}

function formatTitle(type: string): string {
  const titles: Record<string, string> = {
    'proposal:submitted': 'Proposal Submitted',
    'proposal:endorsed': 'Proposal Endorsed',
    'proposal:approved': 'Proposal Approved',
    'project:created': 'Project Created',
    'contribution:assigned': 'Contribution Assigned',
    'contribution:needs_review': 'Contribution Ready for Review',
    'contribution:approved': 'Contribution Approved',
    'contribution:declined': 'Contribution Declined',
    'decision_plan:submitted': 'Decision Plan Submitted',
    'decision_plan:signed_off': 'Decision Plan Signed Off',
  };
  return titles[type] || 'Notification';
}

function formatMessage(type: string, data: Record<string, string>): string {
  return data.title ? `${formatTitle(type)}: ${data.title}` : formatTitle(type);
}
