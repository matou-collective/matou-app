<template>
  <span class="type-badge" :class="type">{{ label }}</span>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  type: string;
}>();

const TYPE_LABELS: Record<string, string> = {
  governance: 'Governance',
  technical: 'Technical',
  cultural: 'Cultural',
  community: 'Community',
};

const label = computed(
  () =>
    TYPE_LABELS[props.type] ??
    props.type.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase()),
);
</script>

<style scoped lang="scss">
.type-badge {
  display: inline-block;
  font-size: 0.75rem;
  font-weight: 500;
  padding: 3px 10px;
  border-radius: 12px;
  text-transform: capitalize;
  white-space: nowrap;

  // chart-2 = #4a9d9c (var(--matou-chart-2))
  &.governance {
    background: rgba(74, 157, 156, 0.12);
    color: var(--matou-chart-2, #4a9d9c);
  }

  // primary = #1e5f74
  &.technical {
    background: rgba(30, 95, 116, 0.1);
    color: var(--matou-primary, #1e5f74);
  }

  // accent = #4a9d9c
  &.cultural {
    background: rgba(74, 157, 156, 0.1);
    color: var(--matou-accent, #4a9d9c);
  }

  // chart-1 = #1e5f74 (same as primary in light mode)
  &.community {
    background: rgba(30, 95, 116, 0.08);
    color: var(--matou-chart-1, #1e5f74);
  }

  // Fallback for unknown types
  &:not(.governance):not(.technical):not(.cultural):not(.community) {
    background: var(--matou-muted);
    color: var(--matou-muted-foreground);
  }
}
</style>
