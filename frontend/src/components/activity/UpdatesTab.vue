<template>
  <div class="updates-tab">
    <h3 class="tab-title">Current Updates</h3>
    <div v-if="activityStore.loading" class="loading-state">
      <p>Loading...</p>
    </div>
    <div v-else-if="activityStore.currentUpdates.length === 0" class="empty-state">
      <Bell :size="48" />
      <p>No current updates</p>
    </div>
    <div v-else class="notice-list">
      <NoticeCard
        v-for="notice in activityStore.currentUpdates"
        :key="notice.id"
        :notice="notice"
        @click="selectedNotice = notice"
      />
    </div>

    <NoticeDetailDialog
      v-if="selectedNotice"
      :notice="selectedNotice"
      @close="selectedNotice = null"
    />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { Bell } from 'lucide-vue-next';
import { useActivityStore } from 'stores/activity';
import type { Notice } from 'src/lib/api/client';
import NoticeCard from './NoticeCard.vue';
import NoticeDetailDialog from './NoticeDetailDialog.vue';

const activityStore = useActivityStore();
const selectedNotice = ref<Notice | null>(null);
</script>

<style scoped>
.tab-title {
  font-size: 1.1rem;
  font-weight: 600;
  margin: 0 0 1rem;
  color: var(--matou-foreground);
}

.loading-state,
.empty-state {
  text-align: center;
  padding: 3rem 1rem;
  color: var(--matou-muted-foreground);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
}

.notice-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
</style>
