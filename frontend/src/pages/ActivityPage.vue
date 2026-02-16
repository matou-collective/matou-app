<template>
  <div class="activity-page">
    <div class="activity-body">
      <!-- Activity sidebar -->
      <aside class="activity-sidebar">
        <div class="activity-sidebar-header">
          <h2 class="activity-sidebar-title">Activity</h2>
          <p class="activity-sidebar-subtitle">Community notices, events, and updates</p>
        </div>
        <nav class="activity-sidebar-nav">
          <button
            class="activity-nav-item"
            :class="{ active: activeTab === 'upcoming' }"
            @click="activeTab = 'upcoming'"
          >
            <span class="activity-nav-text">
              <span class="activity-nav-label">Upcoming Events</span>
              <span class="activity-nav-badge">{{ activityStore.upcomingEvents.length }}</span>
            </span>
          </button>
          <button
            class="activity-nav-item"
            :class="{ active: activeTab === 'updates' }"
            @click="activeTab = 'updates'"
          >
            <span class="activity-nav-text">
              <span class="activity-nav-label">Updates</span>
              <span class="activity-nav-badge">{{ activityStore.currentUpdates.length }}</span>
            </span>
          </button>
          <button
            class="activity-nav-item"
            :class="{ active: activeTab === 'past' }"
            @click="activeTab = 'past'"
          >
            <span class="activity-nav-text">
              <span class="activity-nav-label">Past</span>
              <span class="activity-nav-badge">{{ activityStore.pastNotices.length }}</span>
            </span>
          </button>
          <button
            v-if="isSteward"
            class="activity-nav-item"
            :class="{ active: activeTab === 'drafts' }"
            @click="activeTab = 'drafts'"
          >
            <span class="activity-nav-text">
              <span class="activity-nav-label">Drafts</span>
              <span class="activity-nav-badge">{{ activityStore.draftNotices.length }}</span>
            </span>
          </button>
        </nav>

        <div v-if="isSteward" class="activity-sidebar-actions">
          <button class="create-notice-btn" @click="showCreateDialog = true">
            + Create Notice
          </button>
        </div>
      </aside>

      <!-- Tab content -->
      <div class="tab-content">
        <UpcomingTab v-if="activeTab === 'upcoming'" />
        <UpdatesTab v-if="activeTab === 'updates'" />
        <PastTab v-if="activeTab === 'past'" />
        <div v-if="activeTab === 'drafts' && isSteward" class="drafts-tab">
          <h3 class="tab-title">Draft Notices</h3>
          <div v-if="activityStore.draftNotices.length === 0" class="empty-state">
            <p>No draft notices</p>
          </div>
          <div v-else class="notice-list">
            <NoticeCard
              v-for="notice in activityStore.draftNotices"
              :key="notice.id"
              :notice="notice"
              @click="selectedNotice = notice"
            />
          </div>
        </div>
      </div>
    </div>

    <!-- Create Notice Dialog -->
    <CreateNoticeDialog
      v-if="showCreateDialog"
      @close="showCreateDialog = false"
    />

    <!-- Notice Detail Dialog -->
    <NoticeDetailDialog
      v-if="selectedNotice"
      :notice="selectedNotice"
      @close="selectedNotice = null"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useActivityStore } from 'stores/activity';
import { useAdminAccess } from 'src/composables/useAdminAccess';
import type { Notice } from 'src/lib/api/client';
import UpcomingTab from 'src/components/activity/UpcomingTab.vue';
import UpdatesTab from 'src/components/activity/UpdatesTab.vue';
import PastTab from 'src/components/activity/PastTab.vue';
import NoticeCard from 'src/components/activity/NoticeCard.vue';
import CreateNoticeDialog from 'src/components/activity/CreateNoticeDialog.vue';
import NoticeDetailDialog from 'src/components/activity/NoticeDetailDialog.vue';

const activityStore = useActivityStore();
const { isSteward } = useAdminAccess();

const activeTab = ref<'upcoming' | 'updates' | 'past' | 'drafts'>('upcoming');
const showCreateDialog = ref(false);
const selectedNotice = ref<Notice | null>(null);

onMounted(() => {
  activityStore.refreshAll();
});
</script>

<style scoped>
.activity-page {
  flex: 1;
  background: var(--matou-background, #f4f4f5);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.activity-body {
  flex: 1;
  min-height: 0;
  margin-left: 220px;
}

.activity-sidebar {
  position: fixed;
  top: 0;
  bottom: 0;
  left: 240px;
  width: 220px;
  height: 100%;
  padding-top: 40px;
  border-right: 1px solid var(--matou-sidebar-border);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}

.activity-sidebar-header {
  padding: 1.25rem 1rem;
}

.activity-sidebar-title {
  font-weight: 600;
  font-size: 1.2rem;
  color: var(--matou-sidebar-foreground);
  margin: 0;
  line-height: 1.3;
}

.activity-sidebar-subtitle {
  font-size: 0.7rem;
  color: var(--matou-muted-foreground);
  margin: 0.25rem 0 0;
  line-height: 1.3;
}

.activity-sidebar-nav {
  padding: 1rem 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.activity-nav-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.625rem 0.75rem;
  font-size: 1rem;
  font-weight: 500;
  color: var(--matou-sidebar-foreground);
  background: transparent;
  border: none;
  cursor: pointer;
  width: 100%;
  text-align: left;
  transition: all 0.15s ease;
}

.activity-nav-item:hover {
  background-color: var(--matou-sidebar-accent);
}

.activity-nav-item.active {
  background-color: var(--matou-sidebar-accent);
  color: var(--matou-sidebar-primary);
  border-left: 3px solid var(--matou-sidebar-primary);
  margin-left: 0;
  padding-left: calc(0.75rem - 3px);
}

.activity-nav-text {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
}

.activity-nav-badge {
  font-size: 0.7rem;
  color: var(--matou-muted-foreground);
  font-weight: 400;
}

.activity-nav-item.active .activity-nav-badge {
  color: var(--matou-sidebar-primary);
}

.activity-sidebar-actions {
  padding: 1rem;
  margin-top: auto;
}

.create-notice-btn {
  width: 100%;
  padding: 0.5rem;
  background: var(--matou-primary);
  color: white;
  border: none;
  border-radius: var(--matou-radius, 6px);
  font-size: 0.85rem;
  font-weight: 500;
  cursor: pointer;
  transition: opacity 0.15s;
}

.create-notice-btn:hover {
  opacity: 0.9;
}

.tab-content {
  flex: 1;
  padding: 1.5rem 2rem;
  padding-top: 60px;
  width: 100%;
  overflow-y: auto;
}

.tab-title {
  font-size: 1.1rem;
  font-weight: 600;
  margin: 0 0 1rem;
  color: var(--matou-foreground);
}

.empty-state {
  text-align: center;
  padding: 3rem 1rem;
  color: var(--matou-muted-foreground);
}

.notice-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
</style>
