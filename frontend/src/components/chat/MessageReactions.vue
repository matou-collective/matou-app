<template>
  <div class="message-reactions">
    <button
      v-for="reaction in reactions"
      :key="reaction.emoji"
      class="reaction-btn"
      :class="{ 'has-reacted': reaction.hasReacted }"
      @click="$emit('toggle', reaction.emoji)"
      :title="reactionTooltip(reaction)"
    >
      <span class="emoji">{{ reaction.emoji }}</span>
      <span class="count">{{ reaction.count }}</span>
    </button>
  </div>
</template>

<script setup lang="ts">
import type { MessageReaction } from 'src/lib/api/chat';

defineProps<{
  reactions: MessageReaction[];
}>();

defineEmits<{
  (e: 'toggle', emoji: string): void;
}>();

function reactionTooltip(reaction: MessageReaction): string {
  if (reaction.count === 1) {
    return reaction.hasReacted ? 'You reacted' : '1 person reacted';
  }
  if (reaction.hasReacted) {
    return `You and ${reaction.count - 1} others reacted`;
  }
  return `${reaction.count} people reacted`;
}
</script>

<style lang="scss" scoped>
.message-reactions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  margin-top: 0.375rem;
}

.reaction-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.125rem 0.375rem;
  border: 1px solid var(--matou-border);
  border-radius: 9999px;
  background-color: var(--matou-background);
  cursor: pointer;
  font-size: 0.75rem;
  transition: all 0.15s ease;

  &:hover {
    background-color: var(--matou-secondary);
    border-color: var(--matou-muted-foreground);
  }

  &.has-reacted {
    background-color: rgba(30, 95, 116, 0.1);
    border-color: var(--matou-primary);
  }
}

.emoji {
  font-size: 0.875rem;
  line-height: 1;
}

.count {
  color: var(--matou-muted-foreground);
  font-weight: 500;
}

.has-reacted .count {
  color: var(--matou-primary);
}
</style>
