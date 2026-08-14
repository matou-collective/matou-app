<template>
  <div
    class="slim-card"
    :class="[`contrib-status-${contribution.status}`, { 'slim-card--overdue': showOverdueLine }]"
    @click="$emit('click')"
  >
    <div class="slim-card-row top">
      <span class="slim-card-title">{{ contribution.title }}</span>
      <ContributionStatusBadge :status="contribution.status" />
      <UserAvatar v-if="assignedAid" :aid="assignedAid" :name="assignedName ?? undefined" :size="24" />
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
import { formatDate } from 'src/lib/formatDate';
import ContributionStatusBadge from './ContributionStatusBadge.vue';
import UserAvatar from 'src/components/profiles/UserAvatar.vue';

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

const projectName = computed(() => {
  if (!props.contribution.project_id) return '';
  const p = projectsStore.projects.find((x) => x.id === props.contribution.project_id);
  return p?.title ?? '';
});
</script>

<style scoped lang="scss">
@import 'src/css/contribution-status.scss';

.slim-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  background: var(--matou-card);
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius-sm);
  cursor: pointer;
  transition: border-color 0.12s ease, box-shadow 0.12s ease, background 0.12s ease;

  @include contribution-status-wash;

  &:hover {
    border-color: var(--matou-accent);
    box-shadow: 0 1px 6px rgba(0, 0, 0, 0.05);
  }

  // The timeline's Overdue section already labels these contributions
  // (section header + inline "Due ... overdue" line) — a red border is
  // enough here, no floating tag needed.
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
