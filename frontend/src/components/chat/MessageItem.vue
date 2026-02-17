<template>
  <div
    class="message-item"
    :class="{ 'own-message': isOwnMessage, deleted: message.deletedAt }"
  >
    <!-- Avatar (others only) -->
    <div v-if="!isOwnMessage" class="message-avatar">
      <img v-if="avatarUrl" :src="avatarUrl" class="avatar-img" :alt="displayName" />
      <span v-else class="avatar-initials">{{ initials }}</span>
    </div>

    <!-- Content -->
    <div class="message-content">
      <!-- Sender name above bubble (others only) -->
      <span v-if="!isOwnMessage" class="sender-name">{{ displayName }}</span>

      <!-- Message bubble -->
      <div class="message-bubble">
        <!-- Reply-to indicator -->
        <div v-if="message.replyTo && replyToMessage" class="reply-to-indicator">
          <div class="reply-to-bar"></div>
          <div class="reply-to-body">
            <span class="reply-to-name">{{ replyToDisplayName }}</span>
            <span class="reply-to-text">{{ replyToTruncated }}</span>
          </div>
        </div>

        <div v-if="message.deletedAt" class="deleted-message">
          <em>This message was deleted</em>
        </div>
        <template v-else>
          <div class="message-body" v-html="renderedContent"></div>

          <!-- Attachments -->
          <div v-if="message.attachments?.length" class="message-attachments">
            <AttachmentPreview
              v-for="(attachment, idx) in message.attachments"
              :key="idx"
              :attachment="attachment"
            />
          </div>
        </template>

        <!-- Inline timestamp -->
        <span class="message-meta">
          <span v-if="message.editedAt" class="edited-badge">edited</span>
          <span class="message-time">{{ formatTime(message.sentAt) }}</span>
        </span>
      </div>

      <!-- Reactions (outside bubble) -->
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
import { getFileUrl } from 'src/lib/api/client';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import MessageReactions from './MessageReactions.vue';
import EmojiPicker from './EmojiPicker.vue';
import AttachmentPreview from './AttachmentPreview.vue';

const props = defineProps<{
  message: ChatMessage;
  isOwnMessage: boolean;
  senderProfile?: { displayName: string; avatar: string };
  replyToMessage?: ChatMessage;
  replyToProfile?: { displayName: string; avatar: string };
}>();

const emit = defineEmits<{
  (e: 'reply'): void;
  (e: 'edit'): void;
  (e: 'delete'): void;
  (e: 'react', emoji: string): void;
}>();

const showEmojiPicker = ref(false);

const displayName = computed(() => props.senderProfile?.displayName || props.message.senderName);

const replyToDisplayName = computed(() =>
  props.replyToProfile?.displayName || props.replyToMessage?.senderName || '',
);

const replyToTruncated = computed(() => {
  const content = props.replyToMessage?.content || '';
  return content.length > 80 ? content.substring(0, 80) + '...' : content;
});

const avatarUrl = computed(() => {
  const ref = props.senderProfile?.avatar;
  if (!ref) return '';
  if (ref.startsWith('http') || ref.startsWith('data:')) return ref;
  return getFileUrl(ref);
});

const initials = computed(() => {
  const name = displayName.value;
  const parts = name.split(' ');
  if (parts.length >= 2) {
    return `${parts[0].charAt(0)}${parts[1].charAt(0)}`.toUpperCase();
  }
  return name.substring(0, 2).toUpperCase();
});

const renderedContent = computed(() => {
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

  if (diffMins < 1) return 'now';
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;

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
  align-items: flex-end;
  gap: 0.5rem;
  padding: 0.125rem 0.75rem;
  max-width: 100%;

  &:hover {
    .message-actions {
      opacity: 1;
    }
  }

  &.deleted {
    opacity: 0.6;
  }

  &.own-message {
    justify-content: flex-end;

    .message-content {
      align-items: flex-end;
    }

    .message-bubble {
      background-color: var(--matou-primary);
      color: white;
      border-radius: 1.125rem 1.125rem 0.25rem 1.125rem;

      .message-body {
        color: white;

        :deep(a) {
          color: white;
          text-decoration: underline;
        }

        :deep(code) {
          background-color: rgba(255, 255, 255, 0.2);
          color: white;
        }

        :deep(pre) {
          background-color: rgba(255, 255, 255, 0.15);

          code {
            color: white;
          }
        }
      }

      .message-meta {
        color: rgba(255, 255, 255, 0.7);
      }

      .deleted-message {
        color: rgba(255, 255, 255, 0.7);
      }

      .reply-to-bar {
        background-color: rgba(255, 255, 255, 0.5);
      }

      .reply-to-name {
        color: rgba(255, 255, 255, 0.85);
      }

      .reply-to-text {
        color: rgba(255, 255, 255, 0.6);
      }
    }

    .message-actions {
      right: auto;
      left: -0.5rem;
      transform: translateX(-100%);
    }
  }
}

.message-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--matou-primary), var(--matou-accent));
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.avatar-img {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  object-fit: cover;
}

.avatar-initials {
  color: white;
  font-size: 0.7rem;
  font-weight: 600;
}

.message-content {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  max-width: 75%;
  position: relative;
}

.sender-name {
  font-weight: 600;
  font-size: 0.75rem;
  color: var(--matou-primary);
  margin-bottom: 0.125rem;
  padding-left: 0.75rem;
}

.message-bubble {
  padding: 0.5rem 0.75rem;
  background-color: var(--matou-secondary);
  border-radius: 1.125rem 1.125rem 1.125rem 0.25rem;
  position: relative;
  max-width: 100%;
}

.reply-to-indicator {
  display: flex;
  gap: 0.375rem;
  padding: 0.25rem 0;
  margin-bottom: 0.25rem;
  cursor: pointer;
  border-radius: 0.375rem;
}

.reply-to-bar {
  width: 2px;
  border-radius: 1px;
  background-color: var(--matou-primary);
  flex-shrink: 0;
}

.reply-to-body {
  display: flex;
  flex-direction: column;
  gap: 0.0625rem;
  min-width: 0;
}

.reply-to-name {
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--matou-primary);
}

.reply-to-text {
  font-size: 0.6875rem;
  color: var(--matou-muted-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.message-body {
  font-size: 0.875rem;
  color: var(--matou-foreground);
  line-height: 1.45;
  word-wrap: break-word;

  :deep(p) {
    margin: 0;
    display: inline;
  }

  :deep(p + p) {
    display: block;
    margin-top: 0.375rem;
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
    margin: 0.375rem 0;

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
    margin: 0.375rem 0;
    padding-left: 1.5rem;
  }
}

.message-meta {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  float: right;
  margin-left: 0.5rem;
  margin-top: 0.25rem;
  font-size: 0.6875rem;
  color: var(--matou-muted-foreground);
  white-space: nowrap;
}

.edited-badge {
  font-style: italic;
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
  margin-top: 0.375rem;
}

.message-actions {
  position: absolute;
  top: 50%;
  right: -0.5rem;
  transform: translateX(100%) translateY(-50%);
  display: flex;
  gap: 0.125rem;
  padding: 0.25rem;
  background-color: var(--matou-card);
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius);
  opacity: 0;
  transition: opacity 0.15s ease;
  z-index: 1;
}

.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
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
