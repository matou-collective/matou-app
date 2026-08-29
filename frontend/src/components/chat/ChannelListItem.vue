<template>
  <button
    class="channel-item"
    :class="{ active, archived: channel.isArchived, unread: displayUnreadCount > 0 }"
    @click="$emit('click')"
  >
    <span class="channel-icon">{{ channel.icon || '#' }}</span>
    <span class="channel-content">
      <span class="channel-name">{{ channel.name }}</span>
      <span v-if="channel.description" class="channel-description">{{
        channel.description
      }}</span>
    </span>
    <span v-if="channel.isArchived" class="archived-badge">Archived</span>
    <span v-if="displayUnreadCount > 0" class="unread-badge">{{ displayUnreadCount }}</span>
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Channel } from 'src/lib/api/chat';

const props = defineProps<{
  channel: Channel;
  active: boolean;
  unreadCount?: number;
}>();

defineEmits<{
  (e: 'click'): void;
}>();

const displayUnreadCount = computed(() => props.unreadCount ?? 0);
</script>

<style lang="scss" scoped>
.channel-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
  min-height: 40px;
  padding: 0.5rem 0.75rem;
  border-radius: 0 10px 10px 0;
  background: transparent;
  border: none;
  cursor: pointer;
  text-align: left;
  color: var(--matou-foreground);
  font-size: 1rem;
  transition: all 0.15s ease;

  &:hover {
    background-color: var(--matou-sidebar-accent);
  }

  &.active {
    background-color: var(--matou-sidebar-accent);
    color: var(--matou-sidebar-primary);
    border-left: 3px solid var(--matou-sidebar-primary);
    padding-left: calc(0.75rem - 3px);

    .channel-icon {
      opacity: 1;
    }
  }

  &.archived {
    opacity: 0.6;
  }

  &.unread {
    .channel-name {
      font-weight: 700;
    }
  }
}

.channel-icon {
  font-size: 1rem;
  opacity: 0.8;
  flex-shrink: 0;
}

// Name + description stack. min-width:0 lets the children ellipsize instead of
// forcing the row to overflow.
.channel-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.channel-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 1rem;
  font-weight: 500;
  line-height: 1.3;
}

.channel-description {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.75rem;
  line-height: 1.3;
  color: var(--matou-muted-foreground);
}

.archived-badge {
  flex-shrink: 0;
  font-size: 0.65rem;
  padding: 0.125rem 0.375rem;
  background-color: var(--matou-muted);
  color: var(--matou-muted-foreground);
  border-radius: 9999px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.unread-badge {
  flex-shrink: 0;
  min-width: 18px;
  height: 18px;
  padding: 0 0.375rem;
  background-color: var(--matou-destructive);
  color: white;
  border-radius: 9999px;
  font-size: 0.7rem;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
}

// Single-pane mobile chat (matches the ≤767px breakpoint used by
// useIsMobile / DashboardLayout). Larger tap target and roomier text so the
// channel list is comfortable to scan on a phone; the description keeps its
// secondary treatment.
@media (max-width: 767px) {
  .channel-item {
    min-height: 56px;
    padding: 0.75rem 1rem;

    &.active {
      padding-left: calc(1rem - 3px);
    }
  }

  .channel-description {
    font-size: 0.8125rem;
  }
}
</style>
