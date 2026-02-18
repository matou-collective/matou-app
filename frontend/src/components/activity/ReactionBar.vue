<template>
  <div class="reaction-bar">
    <button
      v-for="summary in summaries"
      :key="summary.emoji"
      class="reaction-pill"
      :class="{ active: summary.userReacted }"
      @click.stop="handleToggle(summary.emoji)"
    >
      <span class="reaction-emoji">{{ summary.emoji }}</span>
      <span class="reaction-count">{{ summary.count }}</span>
    </button>
    <div class="reaction-picker-wrapper">
      <button class="reaction-add" @click.stop="showPicker = !showPicker">+</button>
      <div v-if="showPicker" class="reaction-picker">
        <button
          v-for="emoji in availableEmojis"
          :key="emoji"
          class="picker-emoji"
          @click.stop="handlePick(emoji)"
        >
          {{ emoji }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useActivityStore } from 'stores/activity';

const props = defineProps<{ noticeId: string }>();
const activityStore = useActivityStore();

const showPicker = ref(false);
const availableEmojis = ['👍', '❤️', '✨', '🎉'];

const summaries = computed(() => activityStore.getReactionSummaries(props.noticeId));

async function handleToggle(emoji: string) {
  await activityStore.handleToggleReaction(props.noticeId, emoji);
}

async function handlePick(emoji: string) {
  showPicker.value = false;
  await activityStore.handleToggleReaction(props.noticeId, emoji);
}

onMounted(() => {
  activityStore.loadReactions(props.noticeId);
});
</script>

<style scoped>
.reaction-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
  align-items: center;
}

.reaction-pill {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.2rem 0.5rem;
  border: 1px solid var(--matou-border, #e5e7eb);
  border-radius: 9999px;
  background: transparent;
  cursor: pointer;
  font-size: 0.9rem;
  transition: all 0.15s;
}

.reaction-pill:hover {
  border-color: var(--matou-primary);
}

.reaction-pill.active {
  border-color: var(--matou-primary);
  background: rgba(0, 100, 0, 0.06);
}

.reaction-emoji {
  font-size: 1rem;
}

.reaction-count {
  font-size: 0.85rem;
  color: var(--matou-muted-foreground);
}

.reaction-picker-wrapper {
  position: relative;
}

.reaction-add {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  border: 1px dashed var(--matou-border, #e5e7eb);
  border-radius: 9999px;
  background: transparent;
  cursor: pointer;
  color: var(--matou-muted-foreground);
  font-size: 1rem;
  transition: all 0.15s;
}

.reaction-add:hover {
  border-color: var(--matou-primary);
  color: var(--matou-primary);
}

.reaction-picker {
  position: absolute;
  bottom: calc(100% + 0.375rem);
  left: 0;
  display: flex;
  gap: 0.25rem;
  padding: 0.375rem;
  background: var(--matou-card, white);
  border: 1px solid var(--matou-border, #e5e7eb);
  border-radius: var(--matou-radius, 8px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
  z-index: 10;
}

.picker-emoji {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 2.25rem;
  height: 2.25rem;
  border: none;
  border-radius: var(--matou-radius, 6px);
  background: transparent;
  cursor: pointer;
  font-size: 1.25rem;
  transition: background 0.15s;
}

.picker-emoji:hover {
  background: var(--matou-background, #f4f4f5);
}
</style>
