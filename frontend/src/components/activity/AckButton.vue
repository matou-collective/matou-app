<template>
  <button
    class="ack-btn"
    :class="{ acked: isAcked }"
    :disabled="isAcked"
    @click.stop="handleAck"
  >
    <CheckCircle :size="16" class="ack-icon" />
    {{ isAcked ? 'Acknowledged' : 'Acknowledge' }}
  </button>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { CheckCircle } from 'lucide-vue-next';
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
  width: 30%;
  align-self: flex-end;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.375rem;
  font-size: 0.85rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--matou-border, #e5e7eb);
  border-radius: var(--matou-radius, 6px);
  background: white;
  cursor: pointer;
  color: var(--matou-muted-foreground);
  transition: all 0.15s;
}

.ack-btn:disabled:not(.acked) {
  opacity: 0.5;
  cursor: not-allowed;
}

.ack-icon {
  flex-shrink: 0;
}

.ack-btn:hover:not(:disabled) {
  border-color: var(--matou-primary);
  color: var(--matou-primary);
}

.ack-btn.acked {
  background: var(--matou-primary);
  color: white;
  border-color: var(--matou-primary);
  cursor: default;
}
</style>
