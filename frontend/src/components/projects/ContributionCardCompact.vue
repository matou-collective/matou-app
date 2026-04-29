<template>
  <div class="contribution-compact" @click="$emit('view-detail', contribution)">
    <!-- Top row: title left, status + assignment right -->
    <div class="compact-header">
      <div class="compact-title">{{ contribution.title }}</div>
      <div class="compact-badges-right">
        <ContributionStatusBadge :status="contribution.status" />
        <div v-if="assignedAid" class="compact-avatar">
          <q-tooltip>Assigned to {{ assignedName }}</q-tooltip>
          <img v-if="assignedAvatar" :src="assignedAvatar" class="compact-avatar-img" />
          <span v-else class="compact-avatar-initials">{{ assignedInitials }}</span>
        </div>
      </div>
    </div>

    <!-- Description preview (2-line clamp) -->
    <div v-if="contribution.description" class="compact-description">
      {{ contribution.description }}
    </div>

    <!-- Bottom row: metadata left, actions right -->
    <div class="compact-footer">
      <div class="compact-meta">
        <ContributionTypeBadge :type="contribution.contribution_type" />
        <span v-if="contribution.estimated_hours" class="meta-item">
          <q-icon name="schedule" size="14px" /> {{ contribution.estimated_hours }}h
        </span>
        <span class="meta-item meta-id">ID: {{ contribution.id.slice(0, 12) }}</span>
      </div>

      <div class="compact-actions">
        <!-- Assign action (lead only, after plan sign-off, if confirmed/shared but not yet assigned) -->
        <q-btn
          v-if="isPlanSignedOff && isLead && canAssign"
          outline
          no-caps
          label="Assign"
          icon="person_add"
          color="primary"
          class="action-btn"
          @click.stop="emit('assign', contribution)"
        />

        <q-btn
          v-if="canConfirm && (contribution.status === 'created' || contribution.status === 'changed')"
          outline
          no-caps
          label="Confirm"
          color="primary"
          class="confirm-btn"
          @click.stop="$emit('update', { ...contribution, _action: 'confirm' })"
        />

        <template v-if="canEdit">
          <q-btn
            flat round dense size="sm"
            icon="edit"
            @click.stop="emit('edit', contribution)"
          >
            <q-tooltip>Edit Contribution</q-tooltip>
          </q-btn>
          <q-btn
            flat round dense size="sm"
            icon="delete"
            color="negative"
            @click.stop="emit('archive', contribution)"
          >
            <q-tooltip>Delete Contribution</q-tooltip>
          </q-btn>
        </template>
      </div>
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
import type { Contribution, ProjectRole } from 'src/types/projects';
import ContributionStatusBadge from 'src/components/contributions/ContributionStatusBadge.vue';
import ContributionTypeBadge from './ContributionTypeBadge.vue';
import { useProfilesStore } from 'stores/profiles';
import { getFileUrl } from 'src/lib/api/client';

interface Props {
  contribution: Contribution;
  canConfirm?: boolean;
  canEdit?: boolean;
  isPlanSignedOff?: boolean;
  userRole?: string;
  currentUserId?: string;
  allContributions?: Contribution[];
}

const props = withDefaults(defineProps<Props>(), {
  canConfirm: false,
  canEdit: false,
  isPlanSignedOff: false,
  userRole: 'member',
  currentUserId: '',
  allContributions: () => [],
});

const emit = defineEmits<{
  (e: 'view-detail', contribution: Contribution): void;
  (e: 'update', contribution: Contribution & { _action?: string }): void;
  (e: 'assign', contribution: Contribution): void;
  (e: 'edit', contribution: Contribution): void;
  (e: 'archive', contribution: Contribution): void;
}>();

const profilesStore = useProfilesStore();

const assignedAid = computed(() =>
  props.contribution.assigned_contributor_id ?? props.contribution.assigned_contributor ?? null,
);
const assignedProfile = computed(() =>
  assignedAid.value ? profilesStore.profilesByAid[assignedAid.value] : null,
);
const assignedName = computed(() => {
  if (!assignedAid.value) return null;
  return assignedProfile.value?.displayName
    ?? props.contribution.assigned_contributor_name
    ?? assignedAid.value.slice(0, 12) + '...';
});
const assignedAvatar = computed(() => {
  const avatar = assignedProfile.value?.avatar;
  if (!avatar) return null;
  return avatar.startsWith('http') ? avatar : getFileUrl(avatar);
});
const assignedInitials = computed(() => {
  const name = assignedName.value;
  if (!name) return '?';
  return name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
});


const isLead = computed(() =>
  ['community_admin', 'project_lead'].includes(props.userRole ?? ''),
);

const canAssign = computed(() =>
  ['confirmed', 'shared'].includes(props.contribution.status),
);

const childContributions = computed(() => {
  const childIds = props.contribution.child_contributions ?? [];
  if (!childIds.length || !props.allContributions?.length) return [];
  return props.allContributions.filter(c => childIds.includes(c.id));
});
</script>

<style scoped lang="scss">
.contribution-compact {
  position: relative;
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

.compact-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
}

.compact-badges-right {
  display: flex;
  align-items: center;
  gap: 6px;
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


.compact-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  overflow: hidden;
  flex-shrink: 0;
  background: var(--matou-primary);
  display: flex;
  align-items: center;
  justify-content: center;
}

.compact-avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.compact-avatar-initials {
  font-size: 0.7rem;
  font-weight: 600;
  color: white;
  letter-spacing: 0.03em;
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

.compact-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  margin-top: 4px;
}

.compact-meta {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  font-size: 0.75rem;
  color: $grey-6;

  .meta-item {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }
}

.compact-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.confirm-btn,
.action-btn {
  padding: 4px 20px;
  border-radius: var(--matou-radius-sm, 8px);
  font-size: 0.85rem;
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
