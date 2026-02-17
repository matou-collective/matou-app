<template>
  <div class="message-composer">
    <!-- Reply Preview -->
    <ReplyPreview
      v-if="replyTo"
      :message="replyTo"
      @cancel="$emit('cancelReply')"
    />

    <!-- Attachment Uploader -->
    <AttachmentUploader
      v-show="showUploader"
      ref="uploaderRef"
      @change="pendingFileCount = $event"
      @error="(msg: string) => console.error('[Attachment]', msg)"
    />

    <!-- Input Area -->
    <div class="composer-input-area">
      <button
        class="attach-btn"
        @click="showUploader = !showUploader"
        title="Attach files"
      >
        <Paperclip class="icon" />
      </button>

      <textarea
        ref="textareaRef"
        v-model="content"
        class="message-input"
        :placeholder="placeholder"
        rows="1"
        @keydown="handleKeydown"
        @input="autoResize"
      ></textarea>

      <button
        class="send-btn"
        :disabled="!canSend || sending || uploading"
        @click="handleSend"
        :title="sending || uploading ? 'Sending...' : 'Send message'"
      >
        <Loader2 v-if="sending || uploading" class="icon spin" />
        <Send v-else class="icon" />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, onMounted } from 'vue';
import { Send, Loader2, Paperclip } from 'lucide-vue-next';
import type { ChatMessage, AttachmentRef } from 'src/lib/api/chat';
import { useProfilesStore } from 'stores/profiles';
import ReplyPreview from './ReplyPreview.vue';
import AttachmentUploader from './AttachmentUploader.vue';

const props = defineProps<{
  channelId: string;
  replyTo: ChatMessage | null;
  sending: boolean;
}>();

const emit = defineEmits<{
  (e: 'send', content: string, attachments: AttachmentRef[]): void;
  (e: 'cancelReply'): void;
}>();

const content = ref('');
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const uploaderRef = ref<InstanceType<typeof AttachmentUploader> | null>(null);
const showUploader = ref(false);
const uploading = ref(false);
const pendingFileCount = ref(0);
const profilesStore = useProfilesStore();

const placeholder = computed(() => {
  if (props.replyTo) {
    const profile = profilesStore.profilesByAid[props.replyTo.senderAid];
    const name = profile?.displayName || props.replyTo.senderName;
    return `Reply to ${name}...`;
  }
  return 'Type a message...';
});

const canSend = computed(() => {
  return content.value.trim().length > 0 || pendingFileCount.value > 0;
});

function handleKeydown(e: KeyboardEvent) {
  // Send on Enter (without Shift)
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (canSend.value && !props.sending && !uploading.value) {
      handleSend();
    }
  }
}

async function handleSend() {
  if (!canSend.value || props.sending || uploading.value) return;

  let attachments: AttachmentRef[] = [];
  if (pendingFileCount.value > 0) {
    uploading.value = true;
    try {
      attachments = await uploaderRef.value!.uploadAll();
    } finally {
      uploading.value = false;
    }
  }

  emit('send', content.value.trim(), attachments);
  content.value = '';
  showUploader.value = false;

  nextTick(() => {
    if (textareaRef.value) {
      textareaRef.value.style.height = 'auto';
      textareaRef.value.focus();
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

function focus() {
  textareaRef.value?.focus();
}

onMounted(() => {
  focus();
});

defineExpose({ focus });
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

.attach-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: var(--matou-radius);
  background: transparent;
  border: 1px solid var(--matou-border);
  cursor: pointer;
  color: var(--matou-muted-foreground);
  transition: all 0.15s ease;
  flex-shrink: 0;

  &:hover {
    color: var(--matou-foreground);
    border-color: var(--matou-primary);
  }

  .icon {
    width: 18px;
    height: 18px;
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
