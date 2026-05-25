<template>
  <span class="type-badge" :class="type">{{ label }}</span>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  type: string;
}>();

const TYPE_LABELS: Record<string, string> = {
  research_knowledge: 'Research',
  coordination_operations: 'Ops',
  art_design: 'Design',
  discussion_community_input: 'Community',
  coding_technical_dev: 'Technical',
  cultural_oversight: 'Cultural',
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

  &.research_knowledge {
    background: rgba(99, 102, 241, 0.1);
    color: #4f46e5;
  }

  &.coordination_operations {
    background: rgba(245, 158, 11, 0.1);
    color: #b45309;
  }

  &.art_design {
    background: rgba(236, 72, 153, 0.1);
    color: #db2777;
  }

  &.discussion_community_input {
    background: rgba(30, 95, 116, 0.08);
    color: var(--matou-chart-1, #1e5f74);
  }

  &.coding_technical_dev {
    background: rgba(30, 95, 116, 0.1);
    color: var(--matou-primary, #1e5f74);
  }

  &.cultural_oversight {
    background: rgba(74, 157, 156, 0.1);
    color: var(--matou-accent, #4a9d9c);
  }
}
</style>
