<template>
  <div class="upcoming-tab">
    <h3 class="tab-title">Upcoming Events</h3>
    <div v-if="activityStore.loading" class="loading-state">
      <p>Loading...</p>
    </div>
    <div v-else-if="activityStore.upcomingEvents.length === 0" class="empty-state">
      <Calendar :size="48" />
      <p>No upcoming events</p>
    </div>
    <div v-else class="notice-list">
      <NoticeCard
        v-for="notice in activityStore.upcomingEvents"
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
import { Calendar } from 'lucide-vue-next';
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
