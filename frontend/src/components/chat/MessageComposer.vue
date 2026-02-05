<template>
  <div class="message-composer">
    <!-- Reply Preview -->
    <ReplyPreview
      v-if="replyTo"
      :message="replyTo"
      @cancel="$emit('cancelReply')"
    />

    <!-- Input Area -->
    <div class="composer-input-area">
      <textarea
        ref="textareaRef"
        v-model="content"
        class="message-input"
        :placeholder="placeholder"
        rows="1"
        :disabled="sending"
        @keydown="handleKeydown"
        @input="autoResize"
      ></textarea>

      <button
        class="send-btn"
        :disabled="!canSend || sending"
        @click="handleSend"
        :title="sending ? 'Sending...' : 'Send message'"
      >
        <Loader2 v-if="sending" class="icon spin" />
        <Send v-else class="icon" />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, onMounted } from 'vue';
import { Send, Loader2 } from 'lucide-vue-next';
import type { ChatMessage } from 'src/lib/api/chat';
import ReplyPreview from './ReplyPreview.vue';

const props = defineProps<{
  channelId: string;
  replyTo: ChatMessage | null;
  sending: boolean;
}>();

const emit = defineEmits<{
  (e: 'send', content: string): void;
  (e: 'cancelReply'): void;
}>();

const content = ref('');
const textareaRef = ref<HTMLTextAreaElement | null>(null);

const placeholder = computed(() => {
  if (props.replyTo) {
    return `Reply to ${props.replyTo.senderName}...`;
  }
  return 'Type a message...';
});

const canSend = computed(() => content.value.trim().length > 0);

function handleKeydown(e: KeyboardEvent) {
  // Send on Enter (without Shift)
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (canSend.value && !props.sending) {
      handleSend();
    }
  }
}

function handleSend() {
  if (!canSend.value || props.sending) return;

  emit('send', content.value.trim());
  content.value = '';

  // Reset textarea height
  nextTick(() => {
    if (textareaRef.value) {
      textareaRef.value.style.height = 'auto';
    }
  });
}

function autoResize() {
  if (!textareaRef.value) return;

  textareaRef.value.style.height = 'auto';
  const maxHeight = 200;
  const scrollHeight = textareaRef.value.scrollHeight;
  textareaRef.value.style.height = `${Math.min(scrollHeight, maxHeight)}px`;
}

onMounted(() => {
  textareaRef.value?.focus();
});
</script>

<style lang="scss" scoped>
.message-composer {
  border-top: 1px solid var(--matou-border);
  background-color: var(--matou-card);
  padding: 0.75rem 1rem;
}

.composer-input-area {
  display: flex;
  align-items: flex-end;
  gap: 0.5rem;
}

.message-input {
  flex: 1;
  padding: 0.625rem 0.75rem;
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius);
  background-color: var(--matou-background);
  color: var(--matou-foreground);
  font-size: 0.875rem;
  font-family: inherit;
  line-height: 1.5;
  resize: none;
  outline: none;
  transition: border-color 0.15s ease;

  &:focus {
    border-color: var(--matou-primary);
  }

  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  &::placeholder {
    color: var(--matou-muted-foreground);
  }
}

.send-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: var(--matou-radius);
  background-color: var(--matou-primary);
  border: none;
  cursor: pointer;
  color: white;
  transition: all 0.15s ease;
  flex-shrink: 0;

  &:hover:not(:disabled) {
    opacity: 0.9;
  }

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .icon {
    width: 18px;
    height: 18px;
  }

  .spin {
    animation: spin 1s linear infinite;
  }
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
