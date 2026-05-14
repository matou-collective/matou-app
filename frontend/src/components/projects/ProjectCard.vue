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

      <!-- Available contributions -->
      <div v-if="sharedContributions.length > 0" class="contributions-section">
        <div class="contributions-header">
          <span class="contributions-label">AVAILABLE CONTRIBUTIONS</span>
          <span class="contributions-count">{{ sharedContributions.length }} shared</span>
        </div>
        <div
          v-for="c in visibleContributions"
          :key="c.id"
          class="contribution-row"
        >
          <div class="contribution-row-body">
            <div class="contribution-row-title">{{ c.title }}</div>
            <div v-if="c.description" class="contribution-row-desc">{{ c.description }}</div>
          </div>
          <ContributionTypeBadge :type="c.contribution_type" />
        </div>
        <div v-if="sharedContributions.length > 3" class="contributions-more">
          +{{ sharedContributions.length - 3 }} more contributions
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { User, Shield } from 'lucide-vue-next';
import type { Project } from 'src/lib/api/projects';
import type { Contribution } from 'src/lib/api/contributions';
import ContributionTypeBadge from './ContributionTypeBadge.vue';

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
  props.contributions.filter(c => c.is_shared),
);

const visibleContributions = computed(() =>
  sharedContributions.value.slice(0, 3),
);

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

// ── Contributions section ────────────────────────────────────────────────────

.contributions-section {
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--matou-border);
}

.contributions-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.contributions-label {
  font-size: 0.7rem;
  font-weight: 600;
  color: var(--matou-muted-foreground);
  letter-spacing: 0.04em;
}

.contributions-count {
  font-size: 0.75rem;
  color: var(--matou-accent);
  font-weight: 500;
}

.contribution-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px;
  background: rgba(30, 95, 116, 0.03);
  border: 1px solid rgba(30, 95, 116, 0.12);
  border-radius: var(--matou-radius-sm, 6px);
  margin-bottom: 6px;
}

.contribution-row-body {
  flex: 1;
  min-width: 0;
}

.contribution-row-title {
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--matou-foreground);
  line-height: 1.3;
}

.contribution-row-desc {
  font-size: 0.75rem;
  color: var(--matou-muted-foreground);
  margin-top: 2px;
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.contributions-more {
  text-align: center;
  font-size: 0.78rem;
  color: var(--matou-muted-foreground);
  padding: 6px 0 2px;
}
</style>
