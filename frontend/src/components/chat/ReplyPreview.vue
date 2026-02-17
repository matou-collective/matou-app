<template>
  <div class="reply-preview">
    <div class="reply-indicator"></div>
    <div class="reply-content">
      <span class="reply-label">Replying to <strong>{{ replyToName }}</strong></span>
      <p class="reply-text">{{ truncatedContent }}</p>
    </div>
    <button class="cancel-btn" @click="$emit('cancel')" title="Cancel reply">
      <X class="icon" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { X } from 'lucide-vue-next';
import type { ChatMessage } from 'src/lib/api/chat';
import { useProfilesStore } from 'stores/profiles';

const props = defineProps<{
  message: ChatMessage;
}>();

defineEmits<{
  (e: 'cancel'): void;
}>();

const profilesStore = useProfilesStore();

const replyToName = computed(() => {
  const profile = profilesStore.profilesByAid[props.message.senderAid];
  return profile?.displayName || props.message.senderName;
});

const truncatedContent = computed(() => {
  const content = props.message.content;
  if (content.length > 100) {
    return content.substring(0, 100) + '...';
  }
  return content;
});
</script>

<style lang="scss" scoped>
.reply-preview {
  display: flex;
  align-items: stretch;
  gap: 0.5rem;
  padding: 0.5rem;
  margin-bottom: 0.5rem;
  background-color: var(--matou-secondary);
  border-radius: var(--matou-radius);
}

.reply-indicator {
  width: 3px;
  background-color: var(--matou-primary);
  border-radius: 2px;
}

.reply-content {
  flex: 1;
  min-width: 0;
}

.reply-label {
  font-size: 0.75rem;
  color: var(--matou-muted-foreground);

  strong {
    color: var(--matou-foreground);
  }
}

.reply-text {
  margin: 0.25rem 0 0;
  font-size: 0.8125rem;
  color: var(--matou-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cancel-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: var(--matou-radius);
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--matou-muted-foreground);
  transition: all 0.15s ease;
  align-self: flex-start;

  &:hover {
    background-color: var(--matou-muted);
    color: var(--matou-foreground);
  }

  .icon {
    width: 14px;
    height: 14px;
  }
}
</style>
