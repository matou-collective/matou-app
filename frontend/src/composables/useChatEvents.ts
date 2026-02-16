/**
 * Composable for handling chat-specific SSE events from the backend.
 * Connects to the event stream and updates the chat store in real-time.
 */
import { ref, onMounted, onUnmounted } from 'vue';
import { Notify } from 'quasar';
import { useRouter } from 'vue-router';
import { BACKEND_URL } from 'src/lib/api/client';
import { useChatStore } from 'stores/chat';

export type ChatEventType =
  | 'chat:message:new'
  | 'chat:message:edit'
  | 'chat:message:delete'
  | 'chat:reaction:add'
  | 'chat:reaction:remove'
  | 'chat:channel:new'
  | 'chat:channel:update';

export interface ChatEvent {
  type: ChatEventType;
  data: Record<string, unknown>;
}

export function useChatEvents() {
  const connected = ref(false);
  const lastEvent = ref<ChatEvent | null>(null);
  let eventSource: EventSource | null = null;
  let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

  function connect() {
    if (eventSource) return;

    const chatStore = useChatStore();
    const router = useRouter();
    const url = `${BACKEND_URL}/api/v1/events`;
    eventSource = new EventSource(url);

    eventSource.addEventListener('connected', () => {
      connected.value = true;
      console.log('[ChatEvents] Connected to SSE stream');
    });

    // Message events
    eventSource.addEventListener('chat:message:new', (event) => {
      const data = JSON.parse(event.data);
      lastEvent.value = { type: 'chat:message:new', data };
      chatStore.handleNewMessage(data);
      console.log('[ChatEvents] New message:', data.messageId);

      // Toast notification for messages in non-active channels
      if (data.channelId !== chatStore.currentChannelId) {
        const channel = chatStore.channels.find(c => c.id === data.channelId);
        const channelName = channel?.name ?? 'Unknown';
        const contentPreview = data.content?.substring(0, 80) ?? '';
        Notify.create({
          message: `${data.senderName}: ${contentPreview}`,
          caption: `#${channelName}`,
          position: 'top-right',
          timeout: 5000,
          color: 'primary',
          actions: [
            {
              label: 'View',
              color: 'white',
              handler: () => {
                router.push({ name: 'chat' });
                chatStore.selectChannel(data.channelId);
              },
            },
            { label: 'Dismiss', color: 'white' },
          ],
        });
      }
    });

    eventSource.addEventListener('chat:message:edit', (event) => {
      const data = JSON.parse(event.data);
      lastEvent.value = { type: 'chat:message:edit', data };
      chatStore.handleEditMessage(data);
      console.log('[ChatEvents] Message edited:', data.messageId);
    });

    eventSource.addEventListener('chat:message:delete', (event) => {
      const data = JSON.parse(event.data);
      lastEvent.value = { type: 'chat:message:delete', data };
      chatStore.handleDeleteMessage(data);
      console.log('[ChatEvents] Message deleted:', data.messageId);
    });

    // Reaction events
    eventSource.addEventListener('chat:reaction:add', (event) => {
      const data = JSON.parse(event.data);
      lastEvent.value = { type: 'chat:reaction:add', data };
      // Reload messages to get updated reactions
      if (chatStore.currentChannelId) {
        chatStore.loadMessages(chatStore.currentChannelId);
      }
      console.log('[ChatEvents] Reaction added:', data.emoji, 'on', data.messageId);
    });

    eventSource.addEventListener('chat:reaction:remove', (event) => {
      const data = JSON.parse(event.data);
      lastEvent.value = { type: 'chat:reaction:remove', data };
      // Reload messages to get updated reactions
      if (chatStore.currentChannelId) {
        chatStore.loadMessages(chatStore.currentChannelId);
      }
      console.log('[ChatEvents] Reaction removed:', data.emoji, 'from', data.messageId);
    });

    // Channel events
    eventSource.addEventListener('chat:channel:new', (event) => {
      const data = JSON.parse(event.data);
      lastEvent.value = { type: 'chat:channel:new', data };
      chatStore.handleNewChannel(data);
      console.log('[ChatEvents] New channel:', data.channelId);
    });

    eventSource.addEventListener('chat:channel:update', (event) => {
      const data = JSON.parse(event.data);
      lastEvent.value = { type: 'chat:channel:update', data };
      chatStore.handleUpdateChannel(data);
      console.log('[ChatEvents] Channel updated:', data.channelId);
    });

    eventSource.onerror = () => {
      connected.value = false;
      eventSource?.close();
      eventSource = null;

      // Reconnect after delay
      reconnectTimeout = setTimeout(() => {
        console.log('[ChatEvents] Reconnecting...');
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

  // Auto-connect and disconnect with component lifecycle
  onMounted(() => {
    connect();
  });

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
