<template>
  <div class="contribution-compact" @click="$emit('view-detail', contribution)">
    <div class="compact-left">
      <ContributionStatusBadge :status="contribution.status" />
      <ContributionTypeBadge :type="contribution.contribution_type" />
      <ContributionPriorityBadge :priority="contribution.priority" />
    </div>

    <div class="compact-title">{{ contribution.title }}</div>

    <div class="compact-right">
      <span v-if="assignedName" class="assigned-chip">
        <UserCheck class="chip-icon" />
        {{ assignedName }}
      </span>
      <span v-else class="unassigned-chip">
        <UserPlus class="chip-icon" />
        Unassigned
      </span>

      <!-- Quick action buttons (visible based on role/status) -->
      <q-btn
        v-if="canConfirm && contribution.status === 'created'"
        flat
        dense
        no-caps
        size="sm"
        label="Confirm"
        color="primary"
        @click.stop="$emit('update', { ...contribution, _action: 'confirm' })"
      />

      <q-btn
        v-if="canAddChild"
        flat
        dense
        no-caps
        size="sm"
        icon="add"
        color="accent"
        @click.stop="$emit('create-child', contribution.id)"
      />

      <ChevronRight class="nav-icon" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { UserCheck, UserPlus, ChevronRight } from 'lucide-vue-next';
import type { Contribution, ProjectRole } from 'src/types/projects';
import ContributionStatusBadge from 'src/components/contributions/ContributionStatusBadge.vue';
import ContributionTypeBadge from './ContributionTypeBadge.vue';
import ContributionPriorityBadge from './ContributionPriorityBadge.vue';
import { useContributionWorkflow } from 'src/composables/useContributionWorkflow';

interface Props {
  contribution: Contribution;
  canConfirm?: boolean;
  isPlanSignedOff?: boolean;
  userRole?: string;
  currentUserId?: string;
  allContributions?: Contribution[];
}

const props = withDefaults(defineProps<Props>(), {
  canConfirm: false,
  isPlanSignedOff: false,
  userRole: 'member',
  currentUserId: '',
  allContributions: () => [],
});

const emit = defineEmits<{
  (e: 'view-detail', contribution: Contribution): void;
  (e: 'update', contribution: Contribution & { _action?: string }): void;
  (e: 'create-child', parentId: string): void;
}>();

const { canAddSubContribution } = useContributionWorkflow();

const assignedName = computed(
  () =>
    props.contribution.assigned_contributor_name ??
    props.contribution.assigned_contributor ??
    props.contribution.assigned_contributor_id ??
    null,
);

const canAddChild = computed(
  () =>
    !props.isPlanSignedOff &&
    canAddSubContribution(
      props.contribution,
      props.currentUserId,
      props.userRole as ProjectRole,
    ),
);
</script>

<style scoped lang="scss">
.contribution-compact {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: var(--matou-card);
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius-sm);
  cursor: pointer;
  transition: border-color 0.12s ease, box-shadow 0.12s ease;
  flex-wrap: wrap;

  &:hover {
    border-color: var(--matou-accent);
    box-shadow: 0 1px 6px rgba(0, 0, 0, 0.05);
  }
}

.compact-left {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  flex-shrink: 0;
}

.compact-title {
  flex: 1;
  font-size: 0.9rem;
  font-weight: 500;
  color: var(--matou-foreground);
  min-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.compact-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.assigned-chip,
.unassigned-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.75rem;
  padding: 2px 8px;
  border-radius: 10px;
  white-space: nowrap;
}

.assigned-chip {
  background: rgba(74, 157, 156, 0.1);
  color: var(--matou-accent);
}

.unassigned-chip {
  background: var(--matou-muted);
  color: var(--matou-muted-foreground);
}

.chip-icon {
  width: 12px;
  height: 12px;
}

.nav-icon {
  width: 16px;
  height: 16px;
  color: var(--matou-muted-foreground);
}
</style>
