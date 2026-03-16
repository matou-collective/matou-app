<template>
  <div class="contribution-compact" @click="$emit('view-detail', contribution)">
    <div class="compact-left">
      <ContributionStatusBadge :status="contribution.status" />
      <ContributionTypeBadge :type="contribution.contribution_type" />
      <ContributionPriorityBadge :priority="contribution.priority" />
    </div>

    <div class="compact-title">{{ contribution.title }}</div>

    <!-- Description preview (2-line clamp) -->
    <div v-if="contribution.description" class="compact-description">
      {{ contribution.description }}
    </div>

    <!-- Metadata row: hours + ID -->
    <div class="compact-meta">
      <span v-if="contribution.estimated_hours" class="meta-item">
        <q-icon name="schedule" size="14px" /> {{ contribution.estimated_hours }}h
      </span>
      <span class="meta-item meta-id">ID: {{ contribution.id.slice(0, 12) }}</span>
    </div>

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

      <!-- Share/Offer quick actions (lead only, after plan sign-off, if confirmed) -->
      <template v-if="isPlanSignedOff && isLead && isConfirmed">
        <q-btn flat dense size="sm" label="Share" icon="share" @click.stop="emit('share', contribution)" />
        <q-btn flat dense size="sm" label="Offer" icon="person_add" @click.stop="emit('offer', contribution)" />
      </template>

      <ChevronRight class="nav-icon" />
    </div>

    <!-- Sub-contribution preview -->
    <div v-if="childContributions.length > 0" class="sub-preview">
      <div class="sub-preview-header">
        <q-icon name="warning" size="14px" color="warning" />
        Sub-Contributions ({{ childContributions.length }})
      </div>
      <div
        v-for="child in childContributions.slice(0, 3)"
        :key="child.id"
        class="sub-preview-item"
        @click.stop="emit('view-detail', child)"
      >
        <span class="sub-preview-title">{{ child.title }}</span>
        <ContributionStatusBadge :status="child.status" size="sm" />
      </div>
      <div v-if="childContributions.length > 3" class="sub-preview-more">
        + {{ childContributions.length - 3 }} more
      </div>
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
  (e: 'share', contribution: Contribution): void;
  (e: 'offer', contribution: Contribution): void;
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

const isLead = computed(() =>
  ['community_admin', 'project_lead'].includes(props.userRole ?? ''),
);

const isConfirmed = computed(() =>
  !['created', 'pending_approval'].includes(props.contribution.status),
);

const childContributions = computed(() => {
  const childIds = props.contribution.child_contributions ?? [];
  if (!childIds.length || !props.allContributions?.length) return [];
  return props.allContributions.filter(c => childIds.includes(c.id));
});
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

.compact-description {
  font-size: 0.8rem;
  color: $grey-7;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  margin: 0.25rem 0;
  width: 100%;
}

.compact-meta {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  font-size: 0.75rem;
  color: $grey-6;
  margin: 0.25rem 0;
  width: 100%;

  .meta-item {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }

  .meta-id {
    margin-left: auto;
  }
}

.sub-preview {
  border-top: 1px solid $separator-color;
  padding-top: 0.5rem;
  margin-top: 0.5rem;
  width: 100%;

  .sub-preview-header {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.75rem;
    font-weight: 600;
    margin-bottom: 0.25rem;
  }

  .sub-preview-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.25rem 0.5rem;
    background: rgba(0, 0, 0, 0.02);
    border-radius: 4px;
    margin-bottom: 0.25rem;
    font-size: 0.75rem;
    cursor: pointer;

    &:hover {
      background: rgba(0, 0, 0, 0.05);
    }
  }

  .sub-preview-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
    margin-right: 0.5rem;
  }

  .sub-preview-more {
    font-size: 0.7rem;
    color: $grey-6;
    padding-left: 0.5rem;
  }
}
</style>
