<template>
  <q-dialog :model-value="modelValue" @update:model-value="$emit('update:modelValue', $event)">
    <q-card class="assign-role-dialog">
      <q-card-section class="row items-center q-pb-none">
        <div class="dialog-title">
          <component :is="roleIcon" class="title-icon" :class="roleIconClass" />
          <span>Assign {{ roleLabel }}</span>
        </div>
        <q-space />
        <q-btn icon="close" flat round dense v-close-popup />
      </q-card-section>

      <q-card-section>
        <q-input
          v-model="search"
          placeholder="Search members..."
          outlined
          dense
          clearable
          class="q-mb-md"
        >
          <template #prepend>
            <q-icon name="search" />
          </template>
        </q-input>

        <div class="members-list">
          <div v-if="filteredMembers.length === 0" class="empty-members">
            <span>No members found</span>
          </div>

          <div
            v-for="member in filteredMembers"
            :key="member.id"
            class="member-item"
            :class="{ selected: selectedId === member.id }"
            @click="selectedId = member.id"
          >
            <div class="member-avatar">{{ member.name.charAt(0).toUpperCase() }}</div>
            <div class="member-info">
              <div class="member-name">{{ member.name }}</div>
              <div class="member-role">{{ member.role }}</div>
            </div>
            <q-icon v-if="selectedId === member.id" name="check_circle" class="check-icon" />
          </div>
        </div>
      </q-card-section>

      <q-card-actions align="right" class="q-px-md q-pb-md">
        <q-btn flat no-caps label="Cancel" v-close-popup />
        <q-btn
          no-caps
          :label="`Assign ${roleLabel}`"
          color="primary"
          :disable="!selectedId"
          :loading="isSubmitting"
          @click="handleAssign"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { Shield, Users } from 'lucide-vue-next';

interface Member {
  id: string;
  name: string;
  role: string;
}

interface Props {
  modelValue: boolean;
  role: 'lead' | 'steward';
  members?: Member[];
  isSubmitting?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  members: () => [],
  isSubmitting: false,
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
  (e: 'assign', userId: string): void;
}>();

const search = ref('');
const selectedId = ref<string | null>(null);

const roleLabel = computed(() => (props.role === 'lead' ? 'Project Lead' : 'Project Steward'));

const roleIcon = computed(() => (props.role === 'lead' ? Shield : Users));

const roleIconClass = computed(() =>
  props.role === 'lead' ? 'icon-lead' : 'icon-steward',
);

const filteredMembers = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return props.members;
  return props.members.filter(
    (m) => m.name.toLowerCase().includes(q) || m.role.toLowerCase().includes(q),
  );
});

function handleAssign() {
  if (!selectedId.value) return;
  emit('assign', selectedId.value);
}
</script>

<style scoped lang="scss">
.assign-role-dialog {
  min-width: 400px;
  max-width: 500px;
}

.dialog-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--matou-foreground);
}

.title-icon {
  width: 18px;
  height: 18px;

  &.icon-lead {
    color: var(--matou-chart-2, #4a9d9c);
  }

  &.icon-steward {
    color: var(--matou-accent, #4a9d9c);
  }
}

.members-list {
  max-height: 256px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.empty-members {
  text-align: center;
  padding: 24px;
  color: var(--matou-muted-foreground);
  font-size: 0.875rem;
}

.member-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--matou-radius-sm);
  cursor: pointer;
  transition: background 0.12s ease;
  border: 1px solid transparent;

  &:hover {
    background: var(--matou-secondary);
  }

  &.selected {
    background: rgba(74, 157, 156, 0.08);
    border-color: var(--matou-accent);
  }
}

.member-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--matou-primary);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.875rem;
  font-weight: 600;
  flex-shrink: 0;
}

.member-info {
  flex: 1;
  min-width: 0;
}

.member-name {
  font-size: 0.9rem;
  font-weight: 500;
  color: var(--matou-foreground);
}

.member-role {
  font-size: 0.75rem;
  color: var(--matou-muted-foreground);
  text-transform: capitalize;
}

.check-icon {
  color: var(--matou-accent);
  font-size: 18px;
}
</style>
