<template>
  <aside class="channel-sidebar">
    <div class="sidebar-header">
      <h2 class="sidebar-title">Channels</h2>
      <button
        v-if="isAdmin"
        class="create-btn"
        @click="$emit('create')"
        title="Create channel"
      >
        <Plus class="icon" />
      </button>
    </div>

    <div class="channel-list" v-if="!loading">
      <ChannelListItem
        v-for="channel in channels"
        :key="channel.id"
        :channel="channel"
        :active="channel.id === currentChannelId"
        @click="$emit('select', channel.id)"
      />

      <div v-if="channels.length === 0" class="empty-state">
        <MessageSquare class="empty-icon" />
        <p>No channels yet</p>
      </div>
    </div>

    <div v-else class="loading-state">
      <div class="loading-spinner"></div>
      <p>Loading channels...</p>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { Plus, MessageSquare } from 'lucide-vue-next';
import type { Channel } from 'src/lib/api/chat';
import { useAdminAccess } from 'src/composables/useAdminAccess';
import ChannelListItem from './ChannelListItem.vue';

defineProps<{
  channels: Channel[];
  currentChannelId: string | null;
  loading: boolean;
}>();

defineEmits<{
  (e: 'select', channelId: string): void;
  (e: 'create'): void;
}>();

const { isSteward, checkAdminStatus } = useAdminAccess();
const isAdmin = computed(() => isSteward.value);

onMounted(() => {
  checkAdminStatus();
});
</script>

<style lang="scss" scoped>
.channel-sidebar {
  width: 240px;
  background-color: var(--matou-sidebar);
  border-right: 1px solid var(--matou-border);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
}

.sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem;
  border-bottom: 1px solid var(--matou-border);
}

.sidebar-title {
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--matou-foreground);
  margin: 0;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.create-btn {
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

.channel-list {
  flex: 1;
  overflow-y: auto;
  padding: 0.5rem;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 2rem 1rem;
  color: var(--matou-muted-foreground);

  p {
    margin: 0.5rem 0 0;
    font-size: 0.875rem;
  }
}

.empty-icon {
  width: 32px;
  height: 32px;
  opacity: 0.5;
}

.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 2rem 1rem;
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
</style>
