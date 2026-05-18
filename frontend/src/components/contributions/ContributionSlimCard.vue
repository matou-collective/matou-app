<template>
  <div class="slim-card" :class="{ 'slim-card--overdue': showOverdueLine }" @click="$emit('click')">
    <div class="slim-card-row top">
      <span class="slim-card-title">{{ contribution.title }}</span>
      <ContributionStatusBadge :status="contribution.status" />
      <div v-if="assignedAid" class="slim-card-avatar">
        <q-tooltip>Assigned to {{ assignedName }}</q-tooltip>
        <img v-if="assignedAvatar" :src="assignedAvatar" class="slim-card-avatar-img" />
        <span v-else class="slim-card-avatar-initials">{{ assignedInitials }}</span>
      </div>
    </div>
    <div v-if="projectName" class="slim-card-project">{{ projectName }}</div>
    <div v-if="showOverdueLine && contribution.deadline" class="slim-card-overdue-line">
      <q-icon name="warning" size="14px" />
      Due {{ formatDate(contribution.deadline) }} · overdue
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Contribution } from 'src/lib/api/contributions';
import { useProfilesStore } from 'stores/profiles';
import { useProjectsStore } from 'stores/projects';
import { getFileUrl } from 'src/lib/api/client';
import { formatDate } from 'src/lib/formatDate';
import ContributionStatusBadge from './ContributionStatusBadge.vue';

interface Props {
  contribution: Contribution;
  showOverdueLine?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  showOverdueLine: false,
});

defineEmits<{ (e: 'click'): void }>();

const profilesStore = useProfilesStore();
const projectsStore = useProjectsStore();

const assignedAid = computed(() => {
  const c = props.contribution as typeof props.contribution & { assigned_contributor?: string };
  return c.assigned_contributor_id ?? c.assigned_contributor ?? null;
});

const assignedProfile = computed(() =>
  assignedAid.value ? profilesStore.profilesByAid[assignedAid.value] : null,
);

const assignedName = computed(() => {
  if (!assignedAid.value) return null;
  const c = props.contribution as typeof props.contribution & { assigned_contributor_name?: string };
  return (
    assignedProfile.value?.displayName
    ?? c.assigned_contributor_name
    ?? assignedAid.value.slice(0, 12) + '...'
  );
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

const projectName = computed(() => {
  if (!props.contribution.project_id) return '';
  const p = projectsStore.projects.find((x) => x.id === props.contribution.project_id);
  return p?.title ?? '';
});
</script>

<style scoped lang="scss">
.slim-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  background: var(--matou-card);
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius-sm);
  cursor: pointer;
  transition: border-color 0.12s ease, box-shadow 0.12s ease;

  &:hover {
    border-color: var(--matou-accent);
    box-shadow: 0 1px 6px rgba(0, 0, 0, 0.05);
  }

  &--overdue {
    border-color: var(--matou-destructive, #dc2626);
  }
}

.slim-card-row.top {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.slim-card-title {
  flex: 1;
  font-size: 0.9rem;
  font-weight: 500;
  color: var(--matou-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.slim-card-avatar {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  overflow: hidden;
  flex-shrink: 0;
  background: var(--matou-primary);
  display: flex;
  align-items: center;
  justify-content: center;
}

.slim-card-avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.slim-card-avatar-initials {
  font-size: 0.65rem;
  font-weight: 600;
  color: white;
}

.slim-card-project {
  font-size: 0.75rem;
  color: var(--matou-muted-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.slim-card-overdue-line {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 0.75rem;
  color: var(--matou-destructive, #dc2626);
}
</style>
