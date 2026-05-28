<template>
  <div>
    <q-input
      v-model="search"
      outlined
      dense
      :placeholder="placeholder"
      class="q-mb-sm"
    >
      <template #prepend>
        <q-icon name="search" />
      </template>
    </q-input>
    <div class="member-picker-list">
      <div
        v-for="m in filtered"
        :key="m.id"
        class="member-picker-row"
        :class="{ selected: modelValue === m.id }"
        @click="onSelect(m)"
      >
        <div class="member-picker-name">{{ m.name }}</div>
        <q-icon
          v-if="modelValue === m.id"
          name="check_circle"
          color="primary"
          size="18px"
        />
      </div>
      <div v-if="filtered.length === 0" class="member-picker-empty">
        {{ emptyText }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';

export interface MemberOption {
  id: string;
  name: string;
}

interface Props {
  modelValue: string;
  members: MemberOption[];
  placeholder?: string;
  emptyText?: string;
  /** When true, re-clicking the selected row clears the selection. */
  allowToggle?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  placeholder: 'Search members...',
  emptyText: 'No members found',
  allowToggle: false,
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
  (e: 'select', member: MemberOption): void;
}>();

const search = ref('');

const filtered = computed<MemberOption[]>(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return props.members;
  return props.members.filter((m) => m.name.toLowerCase().includes(q));
});

function onSelect(m: MemberOption) {
  if (props.allowToggle && props.modelValue === m.id) {
    emit('update:modelValue', '');
  } else {
    emit('update:modelValue', m.id);
  }
  emit('select', m);
}
</script>

<style scoped lang="scss">
.member-picker-list {
  max-height: 240px;
  overflow-y: auto;
}

.member-picker-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius-sm, 8px);
  cursor: pointer;
  transition: all 0.12s ease;
  margin-bottom: 4px;

  &:hover {
    border-color: var(--matou-accent);
    background: var(--matou-secondary);
  }

  &.selected {
    border-color: var(--matou-primary);
    background: rgba(30, 95, 116, 0.06);
  }
}

.member-picker-name {
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--matou-foreground);
}

.member-picker-empty {
  text-align: center;
  padding: 16px;
  color: var(--matou-muted-foreground);
  font-size: 0.85rem;
}
</style>
