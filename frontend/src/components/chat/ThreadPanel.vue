<template>
  <aside class="thread-panel" :class="{ 'thread-panel--overlay': overlay }">
    <header class="thread-header">
      <h3>Thread</h3>
      <button class="close-btn" @click="$emit('close')" title="Close thread">
        <X class="icon" />
      </button>
    </header>

    <div class="thread-content">
      <div v-if="loading" class="loading-state">
        <div class="loading-spinner"></div>
        <p>Loading thread...</p>
      </div>

      <template v-else>
        <div v-if="replies.length === 0" class="empty-state">
          <p>No replies yet</p>
        </div>

        <div v-else class="replies-list">
          <div
            v-for="reply in replies"
            :key="reply.id"
            class="reply-item"
          >
            <UserAvatar :aid="reply.senderAid ?? undefined" :name="reply.senderName ?? undefined" :size="28" />
            <div class="reply-content">
              <div class="reply-header">
                <span class="sender-name">{{ reply.senderName }}</span>
                <span class="reply-time">{{ formatTime(reply.sentAt) }}</span>
              </div>
              <p class="reply-text">{{ mentionsToPlainText(reply.content) }}</p>
            </div>
          </div>
        </div>
      </template>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { ref, onMounted, watch } from 'vue';
import { X } from 'lucide-vue-next';
import { useChatStore } from 'stores/chat';
import type { ChatMessage } from 'src/lib/api/chat';
import UserAvatar from 'components/profiles/UserAvatar.vue';
import { mentionsToPlainText } from 'src/lib/mentions';

const props = withDefaults(
  defineProps<{
    messageId: string;
    // On mobile the thread renders as a full-screen overlay instead of a
    // fixed-width side panel.
    overlay?: boolean;
  }>(),
  { overlay: false },
);

defineEmits<{
  (e: 'close'): void;
}>();

const chatStore = useChatStore();
const replies = ref<ChatMessage[]>([]);
const loading = ref(false);

async function loadReplies() {
  loading.value = true;
  try {
    replies.value = await chatStore.loadThread(props.messageId);
  } finally {
    loading.value = false;
  }
}

function formatTime(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleString();
}

onMounted(() => {
  loadReplies();
});

watch(() => props.messageId, () => {
  loadReplies();
});
</script>

<style lang="scss" scoped>
.thread-panel {
  width: 320px;
  background-color: var(--matou-card);
  border-left: 1px solid var(--matou-border);
  display: flex;
  flex-direction: column;
}

// Mobile: promote the thread to a full-screen overlay that sits above the
// bottom navigation (which will be introduced later in Phase 1). A high
// z-index keeps it over both the chat panes and any bottom nav.
.thread-panel--overlay {
  position: fixed;
  inset: 0;
  width: 100%;
  border-left: none;
  z-index: 50;
}

.thread-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--matou-border);

  h3 {
    margin: 0;
    font-size: 0.875rem;
    font-weight: 600;
  }
}

.close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--matou-radius);
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--matou-muted-foreground);
  transition: all 0.15s ease;

  &:hover {
    background-color: var(--matou-secondary);
    color: var(--matou-foreground);
  }

  .icon {
    width: 16px;
    height: 16px;
  }
}

.thread-content {
  flex: 1;
  overflow-y: auto;
  padding: 1rem;
}

.loading-state,
.empty-state {
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

.replies-list {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.reply-item {
  display: flex;
  gap: 0.5rem;
}

.reply-content {
  flex: 1;
  min-width: 0;
}

.reply-header {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
}

.sender-name {
  font-weight: 600;
  font-size: 0.8125rem;
  color: var(--matou-foreground);
}

.reply-time {
  font-size: 0.7rem;
  color: var(--matou-muted-foreground);
}

.reply-text {
  margin: 0.25rem 0 0;
  font-size: 0.8125rem;
  color: var(--matou-foreground);
  line-height: 1.4;
}
</style>
