<template>
  <button
    class="ack-btn"
    :class="{ acked: isAcked }"
    :disabled="isAcked"
    @click.stop="handleAck"
  >
    {{ isAcked ? 'Acknowledged' : 'Acknowledge' }}
  </button>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useActivityStore } from 'stores/activity';
import { useIdentityStore } from 'stores/identity';

const props = defineProps<{ noticeId: string }>();
const activityStore = useActivityStore();
const identityStore = useIdentityStore();

const isAcked = computed(() => {
  const userId = identityStore.currentAID?.prefix ?? '';
  return activityStore.hasAcked(props.noticeId, userId);
});

async function handleAck() {
  await activityStore.handleAck(props.noticeId);
}

onMounted(() => {
  activityStore.loadAcks(props.noticeId);
});
</script>

<style scoped>
.ack-btn {
  font-size: 0.7rem;
  padding: 0.25rem 0.5rem;
  border: 1px solid var(--matou-border, #e5e7eb);
  border-radius: var(--matou-radius, 6px);
  background: transparent;
  cursor: pointer;
  color: var(--matou-muted-foreground);
  transition: all 0.15s;
}

.ack-btn:hover:not(:disabled) {
  border-color: var(--matou-primary);
  color: var(--matou-primary);
}

.ack-btn.acked {
  background: #d1fae5;
  color: #065f46;
  border-color: #a7f3d0;
  cursor: default;
}
</style>
