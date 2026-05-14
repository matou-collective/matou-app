<template>
  <span class="status-badge" :class="status">{{ label }}</span>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  status: string;
}>();

const STATUS_LABELS: Record<string, string> = {
  created: 'Created',
  confirmed: 'Confirmed',
  shared: 'Shared',
  offered: 'Offered',
  assigned: 'Assigned',
  changed: 'Changes Requested',
  in_progress: 'In Progress',
  needs_review: 'Needs Review',
  approved: 'Approved',
  incomplete: 'Incomplete',
  declined: 'Declined',
  signed_off: 'Signed Off',
  rewarded: 'Rewarded',
  archived: 'Archived',
  cancelled: 'Cancelled',
  rejected: 'Rejected',
};

const label = computed(
  () =>
    STATUS_LABELS[props.status] ??
    props.status.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase()),
);
</script>

<style scoped lang="scss">
.status-badge {
  display: inline-block;
  font-size: 0.75rem;
  font-weight: 500;
  padding: 3px 10px;
  border-radius: 12px;
  text-transform: capitalize;
  white-space: nowrap;
  background: var(--matou-muted);
  color: var(--matou-muted-foreground);

  &.created {
    background: var(--matou-muted);
    color: var(--matou-muted-foreground);
  }

  // accent/10 + accent text
  &.confirmed,
  &.shared,
  &.assigned,
  &.approved,
  &.signed_off,
  &.rewarded {
    background: rgba(74, 157, 156, 0.12);
    color: var(--matou-accent, #4a9d9c);
  }

  // primary/10 + primary text
  &.offered {
    background: rgba(30, 95, 116, 0.1);
    color: var(--matou-primary, #1e5f74);
  }

  // chart-1/10 + chart-1 text
  &.needs_review,
  &.incomplete,
  &.changed,
  &.in_progress {
    background: rgba(30, 95, 116, 0.08);
    color: var(--matou-chart-1, #1e5f74);
  }

  // destructive/10 + destructive text
  &.declined,
  &.rejected {
    background: rgba(200, 70, 58, 0.1);
    color: var(--matou-destructive, #c8463a);
  }

  &.archived,
  &.cancelled {
    background: var(--matou-muted);
    color: var(--matou-muted-foreground);
    opacity: 0.7;
  }
}
</style>
