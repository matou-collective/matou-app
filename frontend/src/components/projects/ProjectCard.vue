<template>
  <div
    class="project-card"
    :class="{ clickable: clickable }"
    @click="clickable ? $emit('click') : undefined"
  >
    <div class="card-body">
      <div class="card-header">
        <div class="card-title-row">
          <span class="status-badge" :class="project.status">
            {{ formatStatus(project.status) }}
          </span>
          <div v-if="linkedProposalCount > 0" class="meta-item meta-proposals">
            From {{ linkedProposalCount }} proposal{{ linkedProposalCount !== 1 ? 's' : '' }}
          </div>
        </div>
        <h3 class="card-title">{{ project.title }}</h3>
        <p class="card-description">{{ project.description }}</p>
      </div>

      <div class="card-meta">
        <div v-if="project.project_lead_id" class="meta-item">
          <User class="meta-icon" />
          <span>Lead: {{ leadName }}</span>
        </div>
        <div v-if="project.project_steward_id" class="meta-item">
          <Shield class="meta-icon" />
          <span>Steward: {{ stewardName }}</span>
        </div>
      </div>
    </div>

    <span
      v-if="sharedContributions.length > 0"
      class="available-contributions-tag"
    >
      {{ sharedContributions.length }} available contribution{{ sharedContributions.length !== 1 ? 's' : '' }}
    </span>

    <span v-if="unread > 0" class="unread-badge" :title="`${unread} unread comment${unread !== 1 ? 's' : ''}`">
      {{ unread > 99 ? '99+' : unread }}
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { User, Shield } from 'lucide-vue-next';
import type { Project } from 'src/lib/api/projects';
import type { Contribution } from 'src/lib/api/contributions';
import { useCommentScope } from 'src/composables/useCommentScope';
import { useContributionsStore } from 'stores/contributions';
import { useProjectsStore } from 'stores/projects';

interface Props {
  project: Project;
  clickable?: boolean;
  nameMap?: Record<string, string>;
  contributions?: Contribution[];
}

const props = withDefaults(defineProps<Props>(), {
  clickable: true,
  nameMap: () => ({}),
  contributions: () => [],
});

defineEmits<{
  (e: 'click'): void;
}>();

const linkedProposalCount = computed(() => props.project.proposal_ids?.length ?? 0);

const leadName = computed(() => {
  const aid = props.project.project_lead_id;
  if (!aid) return '';
  return props.nameMap[aid] || props.project.project_lead_name || aid.slice(0, 12) + '...';
});

const stewardName = computed(() => {
  const aid = props.project.project_steward_id;
  if (!aid) return '';
  return props.nameMap[aid] || props.project.project_steward_name || aid.slice(0, 12) + '...';
});

const sharedContributions = computed(() =>
  props.contributions.filter(c => c.status === 'shared'),
);

const scope = useCommentScope();
const contributionsStore = useContributionsStore();
const projectsStoreInternal = useProjectsStore();

// Always prefer the live contributions list — props.contributions is a
// per-project cache (projectsStore.projectContributions[id]) that doesn't
// reactively pick up bumpCommentCount events from peers.
const projectContributions = computed(() =>
  contributionsStore.contributions.filter((c) => c.project_id === props.project.id),
);
const liveProject = computed(() => ({
  ...props.project,
  comment_count: projectsStoreInternal.liveCommentCount(
    props.project.id,
    props.project.comment_count ?? 0,
  ),
}));
const unread = computed(() => scope.projectRollupUnread(liveProject.value, projectContributions.value));

function formatStatus(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}
</script>

<style scoped lang="scss">
.project-card {
  position: relative;
  background: var(--matou-card);
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius);
  overflow: hidden;
  display: flex;
  align-items: stretch;
  transition: box-shadow 0.15s ease, border-color 0.15s ease;

  &.clickable {
    cursor: pointer;

    &:hover {
      border-color: var(--matou-accent);
      box-shadow: 0 2px 12px rgba(0, 0, 0, 0.07);
    }
  }
}

.card-body {
  flex: 1;
  padding: 16px 18px;
  min-width: 0;
}

.card-header {
  margin-bottom: 12px;
}

.card-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}

.card-title {
  font-size: 1rem;
  font-weight: 600;
  color: var(--matou-foreground);
  margin: 0 0 6px;
  line-height: 1.3;
}

.status-badge {
  font-size: 0.7rem;
  padding: 2px 8px;
  border-radius: 12px;
  font-weight: 500;
  white-space: nowrap;
  flex-shrink: 0;
  background: var(--matou-muted);
  color: var(--matou-muted-foreground);

  &.created {
    background: #e0e7ff;
    color: #4338ca;
  }
  &.active {
    background: #d1fae5;
    color: #059669;
  }
  &.completed {
    background: #dbeafe;
    color: #2563eb;
  }
  &.archived {
    background: #f3f4f6;
    color: #6b7280;
  }
}

.meta-proposals {
  font-size: 0.78rem;
  color: var(--matou-muted-foreground);
}

.card-description {
  font-size: 0.875rem;
  color: var(--matou-muted-foreground);
  margin: 0;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  line-height: 1.5;
}

.card-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.meta-item {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 0.78rem;
  color: var(--matou-muted-foreground);
}

.meta-icon {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
}

.available-contributions-tag {
  position: absolute;
  right: 12px;
  bottom: 12px;
  font-size: 0.7rem;
  font-weight: 500;
  padding: 3px 10px;
  border-radius: 12px;
  background: rgba(74, 157, 156, 0.12);
  color: var(--matou-accent, #4a9d9c);
  white-space: nowrap;
}

.unread-badge {
  position: absolute;
  top: 10px;
  right: 12px;
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
