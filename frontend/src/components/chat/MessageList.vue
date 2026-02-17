<template>
  <div class="message-list" ref="containerRef">
    <!-- Load more button -->
    <div v-if="hasMore && !loading" class="load-more">
      <button class="load-more-btn" @click="$emit('loadMore')">
        Load older messages
      </button>
    </div>

    <!-- Loading indicator -->
    <div v-if="loading" class="loading-messages">
      <div class="loading-spinner"></div>
      <p>Loading messages...</p>
    </div>

    <!-- Messages -->
    <div class="messages">
      <template v-for="item in displayMessages" :key="item.id">
        <div
          v-if="item.type === 'divider'"
          class="new-messages-divider"
        >
          <span class="divider-line"></span>
          <span class="divider-text">{{ item.count }} new message{{ item.count !== 1 ? 's' : '' }}</span>
          <span class="divider-line"></span>
        </div>
        <MessageItem
          v-else
          :message="item"
          :isOwnMessage="item.senderAid === currentUserAid"
          :senderProfile="profilesByAid[item.senderAid]"
          :replyToMessage="item.replyTo ? messagesById[item.replyTo] : undefined"
          :replyToProfile="item.replyTo && messagesById[item.replyTo] ? profilesByAid[messagesById[item.replyTo].senderAid] : undefined"
          @reply="$emit('reply', item as ChatMessage)"
          @edit="$emit('edit', item as ChatMessage)"
          @delete="$emit('delete', item as ChatMessage)"
          @react="(emoji: string) => $emit('react', (item as ChatMessage).id, emoji)"
        />
      </template>
    </div>

    <!-- Empty state -->
    <div v-if="!loading && messages.length === 0" class="empty-state">
      <MessageSquare class="empty-icon" />
      <p>No messages yet</p>
      <span>Be the first to send a message!</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import { MessageSquare } from 'lucide-vue-next';
import type { ChatMessage } from 'src/lib/api/chat';
import { useIdentityStore } from 'stores/identity';
import { useProfilesStore } from 'stores/profiles';
import MessageItem from './MessageItem.vue';

const props = defineProps<{
  messages: ChatMessage[];
  loading: boolean;
  hasMore: boolean;
  lastReadAt?: string;
}>();

defineEmits<{
  (e: 'loadMore'): void;
  (e: 'reply', message: ChatMessage): void;
  (e: 'edit', message: ChatMessage): void;
  (e: 'delete', message: ChatMessage): void;
  (e: 'react', messageId: string, emoji: string): void;
}>();

const containerRef = ref<HTMLElement | null>(null);
const identityStore = useIdentityStore();
const profilesStore = useProfilesStore();

const currentUserAid = computed(() => identityStore.aidPrefix || '');
const profilesByAid = computed(() => profilesStore.profilesByAid);

const messagesById = computed(() => {
  const map: Record<string, ChatMessage> = {};
  for (const m of props.messages) {
    map[m.id] = m;
  }
  return map;
});

interface NewMessagesDivider {
  type: 'divider';
  count: number;
  id: string;
}

type DisplayItem = (ChatMessage & { type?: undefined }) | NewMessagesDivider;

// Messages come sorted newest first, so reverse for display (oldest at top)
const displayMessages = computed((): DisplayItem[] => {
  const reversed = [...props.messages].reverse();
  if (!props.lastReadAt || reversed.length === 0) {
    return reversed;
  }

  // Find the first message newer than lastReadAt
  const dividerIndex = reversed.findIndex(m => m.sentAt > props.lastReadAt!);
  if (dividerIndex <= 0) {
    // No unread messages or all are unread — no divider needed
    return reversed;
  }

  const unreadCount = reversed.length - dividerIndex;
  const items: DisplayItem[] = [...reversed];
  items.splice(dividerIndex, 0, {
    type: 'divider',
    count: unreadCount,
    id: 'new-messages-divider',
  });
  return items;
});

let initialScrollDone = false;

// Auto-scroll to bottom when new messages arrive
watch(() => props.messages.length, async (newLen, oldLen) => {
  await nextTick();
  if (!containerRef.value) return;

  // On initial load (or channel switch), scroll to divider if present
  const dividerEl = containerRef.value.querySelector('.new-messages-divider');
  if (!initialScrollDone && dividerEl) {
    dividerEl.scrollIntoView({ block: 'center' });
    initialScrollDone = true;
    return;
  }

  // For new messages, scroll to bottom
  if (!initialScrollDone || (oldLen !== undefined && newLen > oldLen)) {
    containerRef.value.scrollTop = containerRef.value.scrollHeight;
    initialScrollDone = true;
  }
}, { immediate: true });

// Reset when channel changes (lastReadAt or messages replaced entirely)
watch(() => props.lastReadAt, () => {
  initialScrollDone = false;
});
watch(() => props.messages, () => {
  initialScrollDone = false;
});
</script>

<style lang="scss" scoped>
.message-list {
  flex: 1;
  overflow-y: auto;
  padding: 1rem;
  display: flex;
  flex-direction: column;
}

.load-more {
  display: flex;
  justify-content: center;
  padding: 1rem 0;
}

.load-more-btn {
  padding: 0.5rem 1rem;
  font-size: 0.875rem;
  color: var(--matou-primary);
  background: transparent;
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius);
  cursor: pointer;
  transition: all 0.15s ease;

  &:hover {
    background-color: var(--matou-secondary);
  }
}

.loading-messages {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 2rem;
  color: var(--matou-muted-foreground);

  p {
    margin: 0.5rem 0 0;
    font-size: 0.875rem;
  }
}

.loading-spinner {
  width: 24px;
  height: 24px;
  border: 2px solid var(--matou-border);
  border-top-color: var(--matou-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.messages {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  flex: 1;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  flex: 1;
  color: var(--matou-muted-foreground);
  text-align: center;

  p {
    margin: 1rem 0 0.25rem;
    font-size: 1rem;
    font-weight: 500;
    color: var(--matou-foreground);
  }

  span {
    font-size: 0.875rem;
  }
}

.empty-icon {
  width: 48px;
  height: 48px;
  opacity: 0.5;
}

.new-messages-divider {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 0;
}

.divider-line {
  flex: 1;
  height: 1px;
  background-color: var(--matou-destructive);
}

.divider-text {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--matou-destructive);
  white-space: nowrap;
}
</style>
