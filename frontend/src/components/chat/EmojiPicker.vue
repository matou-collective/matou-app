<template>
  <div class="emoji-picker" ref="pickerRef" v-click-outside="handleClickOutside">
    <div class="emoji-grid">
      <button
        v-for="emoji in commonEmojis"
        :key="emoji"
        class="emoji-btn"
        @click="$emit('select', emoji)"
        :title="emoji"
      >
        {{ emoji }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';

defineEmits<{
  (e: 'select', emoji: string): void;
  (e: 'close'): void;
}>();

const pickerRef = ref<HTMLElement | null>(null);

// Common reaction emojis
const commonEmojis = [
  '👍', '👎', '❤️', '😂', '😮', '😢', '😡', '🎉',
  '🔥', '👏', '🙌', '💯', '✅', '❌', '👀', '🤔',
  '💪', '🙏', '⭐', '💡', '🚀', '💬', '📌', '🎯',
];

function handleClickOutside(event: MouseEvent) {
  // The click-outside directive will handle this
}

// Custom click-outside directive
const vClickOutside = {
  mounted(el: HTMLElement, binding: { value: (event: MouseEvent) => void }) {
    (el as unknown as { _clickOutside: (event: MouseEvent) => void })._clickOutside = (event: MouseEvent) => {
      if (!(el === event.target || el.contains(event.target as Node))) {
        binding.value(event);
      }
    };
    document.addEventListener('click', (el as unknown as { _clickOutside: (event: MouseEvent) => void })._clickOutside);
  },
  unmounted(el: HTMLElement) {
    document.removeEventListener('click', (el as unknown as { _clickOutside: (event: MouseEvent) => void })._clickOutside);
  },
};
</script>

<style lang="scss" scoped>
.emoji-picker {
  position: absolute;
  top: 100%;
  left: 0;
  z-index: 100;
  background-color: var(--matou-card);
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  padding: 0.5rem;
  margin-top: 0.25rem;
}

.emoji-grid {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 0.25rem;
}

.emoji-btn {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  border-radius: var(--matou-radius);
  cursor: pointer;
  font-size: 1.125rem;
  transition: background-color 0.15s ease;

  &:hover {
    background-color: var(--matou-secondary);
  }
}
</style>
