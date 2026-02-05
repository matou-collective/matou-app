<template>
  <header class="channel-header">
    <div class="channel-info">
      <span class="channel-icon">{{ channel.icon || '#' }}</span>
      <div class="channel-details">
        <h1 class="channel-name">{{ channel.name }}</h1>
        <p v-if="channel.description" class="channel-description">{{ channel.description }}</p>
      </div>
    </div>
    <div class="channel-actions">
      <button
        v-if="isAdmin"
        class="action-btn"
        @click="$emit('settings')"
        title="Channel settings"
      >
        <Settings class="icon" />
      </button>
    </div>
  </header>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Settings } from 'lucide-vue-next';
import type { Channel } from 'src/lib/api/chat';
import { useAdminAccess } from 'src/composables/useAdminAccess';

defineProps<{
  channel: Channel;
}>();

defineEmits<{
  (e: 'settings'): void;
}>();

const { isSteward } = useAdminAccess();
const isAdmin = computed(() => isSteward.value);
</script>

<style lang="scss" scoped>
.channel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--matou-border);
  background-color: var(--matou-card);
}

.channel-info {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-width: 0;
}

.channel-icon {
  font-size: 1.25rem;
  flex-shrink: 0;
}

.channel-details {
  min-width: 0;
}

.channel-name {
  font-size: 1rem;
  font-weight: 600;
  margin: 0;
  color: var(--matou-foreground);
}

.channel-description {
  font-size: 0.75rem;
  color: var(--matou-muted-foreground);
  margin: 0.125rem 0 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.channel-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
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
    width: 18px;
    height: 18px;
  }
}
</style>
