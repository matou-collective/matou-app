<template>
  <div class="activity-page">
    <!-- Header -->
    <div class="activity-header">
      <div class="activity-header-text">
        <h2 class="activity-title">Activity Feed</h2>
        <p class="activity-subtitle">Community notices and updates</p>
      </div>
      <button v-if="isSteward" class="create-btn" @click="showCreateDialog = true">
        + Create Notice
      </button>
    </div>

    <!-- Filter pills -->
    <div class="filter-row">
      <button
        v-for="f in filters"
        :key="f.value"
        class="filter-pill"
        :class="{ active: activityStore.activeFilter === f.value }"
        @click="activityStore.setFilter(f.value)"
      >
        {{ f.label }}
      </button>
    </div>

    <!-- Feed container -->
    <div class="feed-container">
      <!-- Drafts section (steward only) -->
      <template v-if="isSteward && activityStore.draftNotices.length > 0">
        <div class="feed-divider">Drafts</div>
        <FeedCard
          v-for="notice in activityStore.draftNotices"
          :key="notice.id"
          :notice="notice"
          :is-steward="isSteward"
        />
      </template>

      <!-- Published feed -->
      <FeedCard
        v-for="notice in activityStore.filteredFeed"
        :key="notice.id"
        :notice="notice"
        :is-steward="isSteward"
      />

      <!-- Empty state -->
      <div
        v-if="activityStore.filteredFeed.length === 0 && !activityStore.loading"
        class="empty-state"
      >
        <p>No notices to show</p>
      </div>

      <!-- Loading state -->
      <div v-if="activityStore.loading && activityStore.notices.length === 0" class="loading-state">
        <p>Loading...</p>
      </div>
    </div>

    <!-- Create Notice Dialog -->
    <CreateNoticeDialog
      v-if="showCreateDialog"
      @close="showCreateDialog = false"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue';
import { useActivityStore } from 'stores/activity';
import { useAdminAccess } from 'src/composables/useAdminAccess';
import { useBackendEvents } from 'src/composables/useBackendEvents';
import FeedCard from 'src/components/activity/FeedCard.vue';
import CreateNoticeDialog from 'src/components/activity/CreateNoticeDialog.vue';

const activityStore = useActivityStore();
const { isSteward, checkAdminStatus } = useAdminAccess();
const { lastEvent, connect: connectSSE, disconnect: disconnectSSE } = useBackendEvents();

const showCreateDialog = ref(false);

const filters = [
  { label: 'All', value: 'all' as const },
  { label: 'Events', value: 'event' as const },
  { label: 'Announcements', value: 'announcement' as const },
  { label: 'Updates', value: 'update' as const },
];

watch(lastEvent, (event) => {
  if (event && (event.type === 'notice_created' || event.type === 'notice_published' || event.type === 'notice_archived')) {
    activityStore.loadNotices();
  }
});

onMounted(async () => {
  await checkAdminStatus();
  activityStore.refreshAll();
  connectSSE();
  activityStore.startPolling(15_000);
});

onUnmounted(() => {
  disconnectSSE();
  activityStore.stopPolling();
});
</script>

<style scoped>
.activity-page {
  flex: 1;
  background: var(--matou-background, #f4f4f5);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  padding: 1.5rem 2rem;
  padding-top: 60px;
}

.activity-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  max-width: 56rem;
  width: 100%;
  margin: 0 auto;
}

.activity-title {
  font-size: 1.4rem;
  font-weight: 600;
  margin: 0;
  color: var(--matou-foreground);
}

.activity-subtitle {
  font-size: 0.8rem;
  color: var(--matou-muted-foreground);
  margin: 0.25rem 0 0;
}

.create-btn {
  padding: 0.5rem 1rem;
  background: var(--matou-primary);
  color: white;
  border: none;
  border-radius: var(--matou-radius, 6px);
  font-size: 0.85rem;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition: opacity 0.15s;
}

.create-btn:hover {
  opacity: 0.9;
}

.filter-row {
  display: flex;
  gap: 0.5rem;
  max-width: 56rem;
  width: 100%;
  margin: 1rem auto 0;
}

.filter-pill {
  padding: 0.375rem 0.75rem;
  border: 1px solid var(--matou-border, #e5e7eb);
  border-radius: 9999px;
  background: transparent;
  font-size: 0.8rem;
  color: var(--matou-muted-foreground);
  cursor: pointer;
  transition: all 0.15s;
}

.filter-pill:hover {
  border-color: var(--matou-primary);
  color: var(--matou-primary);
}

.filter-pill.active {
  background: var(--matou-primary);
  color: white;
  border-color: var(--matou-primary);
}

.feed-container {
  max-width: 56rem;
  width: 100%;
  margin: 1rem auto 0;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.feed-divider {
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--matou-muted-foreground);
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--matou-border, #e5e7eb);
}

.empty-state,
.loading-state {
  text-align: center;
  padding: 3rem 1rem;
  color: var(--matou-muted-foreground);
}
</style>
