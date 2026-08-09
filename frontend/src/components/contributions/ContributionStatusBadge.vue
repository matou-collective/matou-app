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
@import 'src/css/contribution-status.scss';

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

  @include contribution-status-badge;
}
</style>
