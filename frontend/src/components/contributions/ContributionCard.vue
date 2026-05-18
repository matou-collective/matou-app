<template>
  <div class="contribution-card" @click="$emit('click')">
    <div class="card-header">
      <div class="card-header-left">
        <span class="contribution-type">{{ contribution.contribution_type }}</span>
        <ContributionStatusBadge :status="contribution.status" />
      </div>
      <span v-if="unread > 0" class="unread-badge" :title="`${unread} unread comment${unread !== 1 ? 's' : ''}`">
        {{ unread > 99 ? '99+' : unread }}
      </span>
    </div>

    <h3 class="card-title">{{ contribution.title }}</h3>

    <p class="card-description">{{ contribution.description }}</p>

    <div class="card-footer">
      <span v-if="assignedAid" class="assigned-label">
        <q-icon name="person" size="14px" />
        {{ assignedName }}
      </span>
      <span v-else class="unassigned-label">
        <q-icon name="person_outline" size="14px" />
        Unassigned
      </span>

      <span v-if="projectName" class="project-label">
        <q-icon name="folder_open" size="14px" />
        {{ projectName }}
      </span>

      <span v-if="contribution.estimated_duration" class="hours-label">
        <q-icon name="schedule" size="14px" />
        {{ contribution.estimated_duration }}h
      </span>

      <span class="date-label">
        {{ new Date(contribution.created_at).toLocaleDateString() }}
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Contribution } from 'src/lib/api/contributions';
import type { Project } from 'src/lib/api/projects';
import { useProfilesStore } from 'stores/profiles';
import { useProjectsStore } from 'stores/projects';
import { useContributionsStore } from 'stores/contributions';
import { useCommentScope } from 'src/composables/useCommentScope';
import ContributionStatusBadge from './ContributionStatusBadge.vue';

const props = withDefaults(
  defineProps<{
    contribution: Contribution;
    projectName?: string;
  }>(),
  {
    projectName: undefined,
  },
);

defineEmits<{
  (e: 'click'): void;
}>();

const profilesStore = useProfilesStore();
const projectsStore = useProjectsStore();
const contributionsStore = useContributionsStore();
const scope = useCommentScope();

const parentProject = computed<Project | null>(() =>
  projectsStore.projects.find((p) => p.id === props.contribution.project_id) ?? null,
);
const liveContribution = computed(() => ({
  ...props.contribution,
  comment_count: contributionsStore.liveCommentCount(
    props.contribution.id,
    props.contribution.comment_count ?? 0,
  ),
}));
const unread = computed(() => scope.contributionUnread(liveContribution.value, parentProject.value));

const assignedAid = computed(() => {
  const c = props.contribution as typeof props.contribution & {
    assigned_contributor?: string;
  };
  return c.assigned_contributor_id ?? c.assigned_contributor ?? null;
});

const assignedName = computed(() => {
  if (!assignedAid.value) return null;
  const c = props.contribution as typeof props.contribution & {
    assigned_contributor_name?: string;
  };
  return (
    profilesStore.profilesByAid[assignedAid.value]?.displayName
    ?? c.assigned_contributor_name
    ?? assignedAid.value.slice(0, 12) + '...'
  );
});
</script>

<style scoped lang="scss">
.contribution-card {
  background: var(--matou-card);
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius);
  padding: 16px 20px;
  margin-bottom: 12px;
  cursor: pointer;
  transition: box-shadow 0.15s ease, border-color 0.15s ease;

  &:hover {
    border-color: var(--matou-accent, #4a9d9c);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
  }
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  gap: 8px;
}

.card-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.contribution-type {
  font-size: 0.75rem;
  padding: 2px 8px;
  border-radius: 10px;
  background: #dbeafe;
  color: #2563eb;
  text-transform: capitalize;
  white-space: nowrap;
}

.priority-badge {
  font-size: 0.75rem;
  padding: 2px 8px;
  border-radius: 10px;
  text-transform: capitalize;
  white-space: nowrap;
  background: #f3f4f6;
  color: #6b7280;

  &.low      { background: #f3f4f6; color: #6b7280; }
  &.medium   { background: #dbeafe; color: #2563eb; }
  &.high     { background: #fef3c7; color: #d97706; }
  &.critical { background: #fee2e2; color: #dc2626; }
}

.card-title {
  font-size: 1.05rem;
  font-weight: 600;
  margin: 0 0 6px;
  color: var(--matou-foreground);
}

.card-description {
  color: var(--matou-muted-foreground);
  margin: 0 0 12px;
  font-size: 0.9rem;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  line-height: 1.5;
}

.card-footer {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
  font-size: 0.8rem;
}

.assigned-label,
.unassigned-label,
.project-label,
.hours-label,
.date-label {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--matou-muted-foreground);
}

.unassigned-label {
  color: var(--matou-muted-foreground);
  opacity: 0.7;
}

.card-header {
  position: relative;
}

.unread-badge {
  margin-left: auto;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: 10px;
  background: var(--matou-destructive, #dc2626);
  color: white;
  font-size: 0.7rem;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}
</style>
