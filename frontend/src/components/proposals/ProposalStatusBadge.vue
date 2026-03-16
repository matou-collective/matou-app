<template>
  <span class="proposal-status-badge" :class="status">{{ label }}</span>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  status: string;
}>();

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  endorsing: 'Endorsing',
  in_review: 'In Review',
  signed_off: 'Signed Off',
  voting_process: 'Voting',
  approved: 'Approved',
  rejected: 'Rejected',
  completed: 'Completed',
};

const label = computed(() => {
  return (
    STATUS_LABELS[props.status] ??
    props.status.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())
  );
});
</script>

<style scoped lang="scss">
.proposal-status-badge {
  display: inline-block;
  font-size: 0.75rem;
  font-weight: 500;
  padding: 3px 10px;
  border-radius: 12px;
  text-transform: capitalize;
  white-space: nowrap;

  // Default (fallback)
  background: var(--matou-muted);
  color: var(--matou-muted-foreground);

  &.draft {
    background: #f3f4f6;
    color: #6b7280;
  }

  &.submitted {
    background: #fef3c7;
    color: #d97706;
  }

  &.endorsing {
    background: #fce7f3;
    color: #db2777;
  }

  &.in_review {
    background: #dbeafe;
    color: #2563eb;
  }

  &.signed_off {
    background: #d1fae5;
    color: #059669;
  }

  &.voting_process {
    background: #e0e7ff;
    color: #4f46e5;
  }

  &.approved {
    background: #d1fae5;
    color: #059669;
  }

  &.rejected {
    background: #fee2e2;
    color: #dc2626;
  }

  &.completed {
    background: #d1fae5;
    color: #059669;
  }
}
</style>
