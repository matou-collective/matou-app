<template>
  <span class="priority-badge" :class="priority">{{ label }}</span>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  priority: string;
}>();

const PRIORITY_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

const label = computed(
  () =>
    PRIORITY_LABELS[props.priority] ??
    props.priority.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase()),
);
</script>

<style scoped lang="scss">
.priority-badge {
  display: inline-block;
  font-size: 0.75rem;
  font-weight: 500;
  padding: 3px 10px;
  border-radius: 12px;
  text-transform: capitalize;
  white-space: nowrap;

  &.low {
    background: var(--matou-muted);
    color: var(--matou-muted-foreground);
  }

  &.medium {
    background: color-mix(in srgb, var(--matou-accent) 12%, transparent);
    color: var(--matou-chart-2);
  }

  &.high {
    background: color-mix(in srgb, var(--matou-primary) 10%, transparent);
    color: var(--matou-chart-1);
  }

  &.critical {
    background: rgba(200, 70, 58, 0.1);
    color: var(--matou-destructive);
  }

  &:not(.low):not(.medium):not(.high):not(.critical) {
    background: var(--matou-muted);
    color: var(--matou-muted-foreground);
  }
}
</style>
