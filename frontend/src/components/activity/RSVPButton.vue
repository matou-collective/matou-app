<template>
  <div class="rsvp-btn-group">
    <button
      class="rsvp-btn"
      :class="{ active: currentStatus === 'going' }"
      @click.stop="handleRsvp('going')"
    >
      Going{{ counts.going ? ` (${counts.going})` : '' }}
    </button>
    <button
      class="rsvp-btn"
      :class="{ active: currentStatus === 'maybe' }"
      @click.stop="handleRsvp('maybe')"
    >
      Maybe{{ counts.maybe ? ` (${counts.maybe})` : '' }}
    </button>
    <button
      class="rsvp-btn decline"
      :class="{ active: currentStatus === 'not_going' }"
      @click.stop="handleRsvp('not_going')"
    >
      Can't go
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useActivityStore } from 'stores/activity';

const props = defineProps<{ noticeId: string }>();
const activityStore = useActivityStore();
const currentStatus = ref<string>('');

const counts = computed(() => activityStore.getRsvpCounts(props.noticeId));

async function handleRsvp(status: 'going' | 'maybe' | 'not_going') {
  currentStatus.value = status;
  await activityStore.handleRsvp(props.noticeId, status);
}

onMounted(() => {
  activityStore.loadRsvps(props.noticeId);
});
</script>

<style scoped>
.rsvp-btn-group {
  display: flex;
  gap: 0.25rem;
}

.rsvp-btn {
  font-size: 0.7rem;
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--matou-border, #e5e7eb);
  border-radius: var(--matou-radius, 6px);
  background: transparent;
  cursor: pointer;
  color: var(--matou-muted-foreground);
  transition: all 0.15s;
}

.rsvp-btn:hover {
  border-color: var(--matou-primary);
  color: var(--matou-primary);
}

.rsvp-btn.active {
  background: var(--matou-primary);
  color: white;
  border-color: var(--matou-primary);
}

.rsvp-btn.decline.active {
  background: #ef4444;
  border-color: #ef4444;
}
</style>
