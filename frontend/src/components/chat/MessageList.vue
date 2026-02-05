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
      <MessageItem
        v-for="message in displayMessages"
        :key="message.id"
        :message="message"
        :isOwnMessage="message.senderAid === currentUserAid"
        @reply="$emit('reply', message)"
        @edit="$emit('edit', message)"
        @delete="$emit('delete', message)"
        @react="(emoji) => $emit('react', message.id, emoji)"
      />
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
import MessageItem from './MessageItem.vue';

const props = defineProps<{
  messages: ChatMessage[];
  loading: boolean;
  hasMore: boolean;
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

const currentUserAid = computed(() => identityStore.aidPrefix || '');

// Messages come sorted newest first, so reverse for display (oldest at top)
const displayMessages = computed(() => {
  return [...props.messages].reverse();
});

// Auto-scroll to bottom when new messages arrive
watch(() => props.messages.length, async () => {
  await nextTick();
  if (containerRef.value) {
    containerRef.value.scrollTop = containerRef.value.scrollHeight;
  }
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
</style>
