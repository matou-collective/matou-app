/**
 * Composable for consuming Server-Sent Events from the backend.
 * Listens for credential and space events to trigger reactive UI updates.
 */
import { ref, onUnmounted } from 'vue';
import { BACKEND_URL } from 'src/lib/api/client';
import { useIdentityStore } from 'stores/identity';

export type BackendEventType =
  | 'credential:new'
  | 'credential:community'
  | 'space:joined'
  | 'identity:configured'
  | 'notice_created'
  | 'notice_published'
  | 'notice_archived'
  | 'notice_comment'
  | 'notice_reaction'
  | 'connected';

export interface BackendEvent {
  type: BackendEventType;
  data: Record<string, string>;
}

export function useBackendEvents() {
  const connected = ref(false);
  const lastEvent = ref<BackendEvent | null>(null);
  let eventSource: EventSource | null = null;
  let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

  function connect() {
    if (eventSource) return;

    const url = `${BACKEND_URL}/api/v1/events`;
    eventSource = new EventSource(url);

    eventSource.addEventListener('connected', () => {
      connected.value = true;
      console.log('[BackendEvents] Connected to SSE stream');
    });

    eventSource.addEventListener('credential:new', (event) => {
      const data = JSON.parse(event.data);
      lastEvent.value = { type: 'credential:new', data };
      console.log('[BackendEvents] New credential:', data.said);
    });

    eventSource.addEventListener('credential:community', (event) => {
      const data = JSON.parse(event.data);
      lastEvent.value = { type: 'credential:community', data };
      console.log('[BackendEvents] Community credential:', data.said);

      // Refresh community data in identity store
      const identityStore = useIdentityStore();
      identityStore.fetchUserSpaces().catch(() => {});
    });

    eventSource.addEventListener('space:joined', (event) => {
      const data = JSON.parse(event.data);
      lastEvent.value = { type: 'space:joined', data };
      console.log('[BackendEvents] Space joined:', data.spaceId);

      const identityStore = useIdentityStore();
      identityStore.fetchUserSpaces().catch(() => {});
    });

    eventSource.addEventListener('identity:configured', (event) => {
      const data = JSON.parse(event.data);
      lastEvent.value = { type: 'identity:configured', data };
      console.log('[BackendEvents] Identity configured:', data.aid);
    });

    eventSource.addEventListener('notice_created', (event) => {
      const data = JSON.parse(event.data);
      lastEvent.value = { type: 'notice_created', data };
      console.log('[BackendEvents] Notice created:', data.noticeId);
    });

    eventSource.addEventListener('notice_published', (event) => {
      const data = JSON.parse(event.data);
      lastEvent.value = { type: 'notice_published', data };
      console.log('[BackendEvents] Notice published:', data.noticeId);
    });

    eventSource.addEventListener('notice_archived', (event) => {
      const data = JSON.parse(event.data);
      lastEvent.value = { type: 'notice_archived', data };
      console.log('[BackendEvents] Notice archived:', data.noticeId);
    });

    eventSource.addEventListener('notice_comment', (event) => {
      const data = JSON.parse(event.data);
      lastEvent.value = { type: 'notice_comment', data };
      console.log('[BackendEvents] Notice comment:', data.noticeId);
    });

    eventSource.addEventListener('notice_reaction', (event) => {
      const data = JSON.parse(event.data);
      lastEvent.value = { type: 'notice_reaction', data };
      console.log('[BackendEvents] Notice reaction:', data.noticeId);
    });

    eventSource.onerror = () => {
      connected.value = false;
      eventSource?.close();
      eventSource = null;

      // Reconnect after delay
      reconnectTimeout = setTimeout(() => {
        console.log('[BackendEvents] Reconnecting...');
        connect();
      }, 5000);
    };
  }

  function disconnect() {
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    connected.value = false;
  }

  onUnmounted(() => {
    disconnect();
  });

  return {
    connected,
    lastEvent,
    connect,
    disconnect,
  };
}
