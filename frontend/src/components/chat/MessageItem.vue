<template>
  <div
    class="message-item"
    :class="{ 'own-message': isOwnMessage, deleted: message.deletedAt }"
  >
    <!-- Avatar -->
    <div class="message-avatar">
      <span class="avatar-initials">{{ initials }}</span>
    </div>

    <!-- Content -->
    <div class="message-content">
      <div class="message-header">
        <span class="sender-name">{{ message.senderName }}</span>
        <span class="message-time">{{ formatTime(message.sentAt) }}</span>
        <span v-if="message.editedAt" class="edited-badge">(edited)</span>
      </div>

      <div v-if="message.deletedAt" class="deleted-message">
        <em>This message was deleted</em>
      </div>
      <div v-else class="message-body" v-html="renderedContent"></div>

      <!-- Attachments -->
      <div v-if="message.attachments?.length" class="message-attachments">
        <AttachmentPreview
          v-for="(attachment, idx) in message.attachments"
          :key="idx"
          :attachment="attachment"
        />
      </div>

      <!-- Reactions -->
      <MessageReactions
        v-if="message.reactions?.length && !message.deletedAt"
        :reactions="message.reactions"
        @toggle="(emoji) => $emit('react', emoji)"
      />

      <!-- Actions (on hover) -->
      <div v-if="!message.deletedAt" class="message-actions">
        <button class="action-btn" @click="showEmojiPicker = !showEmojiPicker" title="React">
          <Smile class="icon" />
        </button>
        <button class="action-btn" @click="$emit('reply')" title="Reply">
          <Reply class="icon" />
        </button>
        <template v-if="isOwnMessage">
          <button class="action-btn" @click="$emit('edit')" title="Edit">
            <Pencil class="icon" />
          </button>
          <button class="action-btn delete-btn" @click="$emit('delete')" title="Delete">
            <Trash2 class="icon" />
          </button>
        </template>
      </div>

      <!-- Emoji Picker -->
      <EmojiPicker
        v-if="showEmojiPicker"
        @select="handleEmojiSelect"
        @close="showEmojiPicker = false"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { Smile, Reply, Pencil, Trash2 } from 'lucide-vue-next';
import type { ChatMessage } from 'src/lib/api/chat';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import MessageReactions from './MessageReactions.vue';
import EmojiPicker from './EmojiPicker.vue';
import AttachmentPreview from './AttachmentPreview.vue';

const props = defineProps<{
  message: ChatMessage;
  isOwnMessage: boolean;
}>();

const emit = defineEmits<{
  (e: 'reply'): void;
  (e: 'edit'): void;
  (e: 'delete'): void;
  (e: 'react', emoji: string): void;
}>();

const showEmojiPicker = ref(false);

const initials = computed(() => {
  const name = props.message.senderName;
  const parts = name.split(' ');
  if (parts.length >= 2) {
    return `${parts[0].charAt(0)}${parts[1].charAt(0)}`.toUpperCase();
  }
  return name.substring(0, 2).toUpperCase();
});

const renderedContent = computed(() => {
  // Parse markdown and sanitize
  const html = marked.parse(props.message.content, { breaks: true });
  return DOMPurify.sanitize(html as string);
});

function formatTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString();
}

function handleEmojiSelect(emoji: string) {
  emit('react', emoji);
  showEmojiPicker.value = false;
}
</script>

<style lang="scss" scoped>
.message-item {
  display: flex;
  gap: 0.75rem;
  padding: 0.5rem 0.75rem;
  border-radius: var(--matou-radius);
  transition: background-color 0.15s ease;

  &:hover {
    background-color: var(--matou-secondary);

    .message-actions {
      opacity: 1;
    }
  }

  &.deleted {
    opacity: 0.6;
  }
}

.message-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--matou-primary), var(--matou-accent));
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.avatar-initials {
  color: white;
  font-size: 0.75rem;
  font-weight: 600;
}

.message-content {
  flex: 1;
  min-width: 0;
  position: relative;
}

.message-header {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  margin-bottom: 0.25rem;
}

.sender-name {
  font-weight: 600;
  font-size: 0.875rem;
  color: var(--matou-foreground);
}

.message-time {
  font-size: 0.75rem;
  color: var(--matou-muted-foreground);
}

.edited-badge {
  font-size: 0.7rem;
  color: var(--matou-muted-foreground);
  font-style: italic;
}

.message-body {
  font-size: 0.875rem;
  color: var(--matou-foreground);
  line-height: 1.5;

  :deep(p) {
    margin: 0;
  }

  :deep(p + p) {
    margin-top: 0.5rem;
  }

  :deep(code) {
    background-color: var(--matou-muted);
    padding: 0.125rem 0.25rem;
    border-radius: 0.25rem;
    font-family: monospace;
    font-size: 0.8125rem;
  }

  :deep(pre) {
    background-color: var(--matou-muted);
    padding: 0.75rem;
    border-radius: var(--matou-radius);
    overflow-x: auto;
    margin: 0.5rem 0;

    code {
      background: none;
      padding: 0;
    }
  }

  :deep(a) {
    color: var(--matou-primary);
    text-decoration: underline;
  }

  :deep(ul), :deep(ol) {
    margin: 0.5rem 0;
    padding-left: 1.5rem;
  }
}

.deleted-message {
  font-size: 0.875rem;
  color: var(--matou-muted-foreground);
  font-style: italic;
}

.message-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.5rem;
}

.message-actions {
  position: absolute;
  top: -0.25rem;
  right: 0;
  display: flex;
  gap: 0.25rem;
  padding: 0.25rem;
  background-color: var(--matou-card);
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius);
  opacity: 0;
  transition: opacity 0.15s ease;
}

.action-btn {
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

  &.delete-btn:hover {
    color: var(--matou-destructive);
  }

  .icon {
    width: 14px;
    height: 14px;
  }
}
</style>
