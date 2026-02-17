<template>
  <div class="rsvp-block">
    <div class="rsvp-going-summary">
      <Users :size="18" class="rsvp-summary-icon" />
      <span>{{ counts.going }} going</span>
    </div>
    <div class="rsvp-btn-group">
      <button
        class="rsvp-btn going"
        :class="{ active: currentStatus === 'going' }"
        @click.stop="handleRsvp('going')"
      >
        <CheckCircle :size="16" class="rsvp-icon" />
        Going
      </button>
    <button
      class="rsvp-btn"
      :class="{ active: currentStatus === 'maybe' }"
      @click.stop="handleRsvp('maybe')"
    >
      <HelpCircle :size="16" class="rsvp-icon" />
      Maybe{{ counts.maybe ? ` (${counts.maybe})` : '' }}
    </button>
    <button
      class="rsvp-btn decline"
      :class="{ active: currentStatus === 'not_going' }"
      @click.stop="handleRsvp('not_going')"
    >
      <XCircle :size="16" class="rsvp-icon" />
      Can't go
    </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { CheckCircle, HelpCircle, Users, XCircle } from 'lucide-vue-next';
import { useActivityStore } from 'stores/activity';
import { useIdentityStore } from 'stores/identity';

const props = defineProps<{ noticeId: string }>();
const activityStore = useActivityStore();
const identityStore = useIdentityStore();

const counts = computed(() => activityStore.getRsvpCounts(props.noticeId));

const currentStatus = computed(() => {
  const userId = identityStore.currentAID?.prefix ?? '';
  if (!userId) return '';
  const rsvpData = activityStore.rsvpsByNotice[props.noticeId];
  const myRsvp = rsvpData?.rsvps?.find(r => r.userId === userId);
  return myRsvp?.status ?? '';
});

async function handleRsvp(status: 'going' | 'maybe' | 'not_going') {
  await activityStore.handleRsvp(props.noticeId, status);
}

onMounted(() => {
  activityStore.loadRsvps(props.noticeId);
});
</script>

<style scoped>
.rsvp-block {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  width: 100%;
}

.rsvp-going-summary {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.85rem;
  color: var(--matou-muted-foreground);
}

.rsvp-summary-icon {
  flex-shrink: 0;
  color: var(--matou-muted-foreground);
}

.rsvp-btn-group {
  display: flex;
  gap: 0.5rem;
  width: 100%;
}

.rsvp-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.375rem;
  font-size: 0.85rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--matou-border, #e5e7eb);
  border-radius: var(--matou-radius, 6px);
  background: transparent;
  cursor: pointer;
  color: var(--matou-muted-foreground);
  transition: all 0.15s;
}

.rsvp-icon {
  flex-shrink: 0;
}

.rsvp-btn:hover {
  border-color: var(--matou-primary);
  color: var(--matou-primary);
}

.rsvp-btn.going {
  border-color: var(--matou-primary);
  color: var(--matou-primary);
}

.rsvp-btn.going:hover {
  background: color-mix(in srgb, var(--matou-primary) 12%, transparent);
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
