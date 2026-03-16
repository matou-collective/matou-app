<template>
  <div class="project-detail">
    <!-- Header -->
    <div class="detail-header">
      <div class="detail-header-top">
        <div class="badges-row">
          <span class="status-badge" :class="project.status">
            {{ formatStatus(project.status) }}
          </span>
          <span v-if="project.project_lead_id" class="role-badge lead">
            Lead: {{ project.project_lead_id }}
          </span>
          <span v-if="project.project_steward_id" class="role-badge steward">
            Steward: {{ project.project_steward_id }}
          </span>
        </div>
        <h1 class="detail-title">{{ project.title }}</h1>
        <p class="detail-meta">
          Created {{ formatDate(project.created_at) }}
          <span v-if="project.created_by"> by {{ project.created_by }}</span>
        </p>
      </div>

      <div v-if="canEdit || canDelete" class="detail-actions">
        <q-btn
          v-if="canEdit"
          flat
          no-caps
          icon="edit"
          label="Edit"
          @click="$emit('edit')"
        />
        <q-btn
          v-if="canDelete"
          flat
          no-caps
          icon="delete"
          label="Delete"
          color="negative"
          @click="$emit('delete')"
        />
      </div>
    </div>

    <!-- Description -->
    <div class="content-section">
      <h3 class="section-title">Description</h3>
      <p class="section-text">{{ project.description }}</p>
    </div>

    <!-- Linked Proposals -->
    <div v-if="linkedProposals.length > 0" class="content-section">
      <h3 class="section-title row items-center q-gutter-sm">
        <q-icon name="how_to_vote" size="18px" />
        <span>Linked Proposals ({{ linkedProposals.length }})</span>
      </h3>
      <div class="proposals-list">
        <div
          v-for="proposal in linkedProposals"
          :key="proposal.id"
          class="proposal-item"
          @click="$emit('view-proposal', proposal.id)"
        >
          <div class="proposal-item-body">
            <span class="proposal-item-title">{{ proposal.title }}</span>
            <span class="proposal-item-status" :class="proposal.status">
              {{ formatStatus(proposal.status) }}
            </span>
          </div>
          <ChevronRight class="item-arrow" />
        </div>
      </div>
    </div>

    <div
      v-else-if="project.proposal_ids && project.proposal_ids.length > 0"
      class="content-section"
    >
      <h3 class="section-title row items-center q-gutter-sm">
        <q-icon name="how_to_vote" size="18px" />
        <span>Linked Proposals ({{ project.proposal_ids.length }})</span>
      </h3>
      <div class="proposals-list">
        <div
          v-for="pid in project.proposal_ids"
          :key="pid"
          class="proposal-item"
          @click="$emit('view-proposal', pid)"
        >
          <div class="proposal-item-body">
            <span class="proposal-item-title">{{ pid }}</span>
          </div>
          <ChevronRight class="item-arrow" />
        </div>
      </div>
    </div>

    <!-- Implementation Plans -->
    <div class="content-section">
      <div class="section-header">
        <h3 class="section-title row items-center q-gutter-sm">
          <q-icon name="assignment" size="18px" />
          <span>Implementation Plans</span>
        </h3>
        <q-btn
          v-if="canEdit"
          flat
          no-caps
          dense
          icon="add"
          label="Add Plan"
          color="primary"
          @click="$emit('create-implementation-plan')"
        />
      </div>

      <div v-if="implementationPlans.length === 0" class="empty-plans">
        <p>No implementation plans yet.</p>
      </div>

      <div v-else class="plans-list">
        <div
          v-for="plan in implementationPlans"
          :key="plan.id"
          class="plan-card"
        >
          <div class="plan-card-header">
            <div>
              <div class="plan-budget">Budget: {{ plan.total_budget }}</div>
              <div class="plan-lead text-caption">
                Lead: {{ plan.project_lead }}
              </div>
            </div>
            <span class="status-badge" :class="plan.current_status">
              {{ formatStatus(plan.current_status) }}
            </span>
          </div>

          <!-- Milestones -->
          <div v-if="plan.milestones && plan.milestones.length > 0" class="milestones">
            <div class="milestones-label">Milestones</div>
            <div
              v-for="(milestone, idx) in plan.milestones"
              :key="milestone.milestone_id"
              class="milestone-row"
            >
              <span class="milestone-num">{{ idx + 1 }}</span>
              <span class="milestone-title">{{ milestone.title }}</span>
              <span class="milestone-duration">{{ milestone.duration }}</span>
            </div>
          </div>
          <div v-else class="milestones-empty">No milestones defined yet.</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ChevronRight } from 'lucide-vue-next';
import type { Project } from 'src/lib/api/projects';
import type { Proposal } from 'src/lib/api/proposals';
import type { ImplementationPlan } from 'src/lib/api/implementationPlans';

interface Props {
  project: Project;
  linkedProposals?: Proposal[];
  implementationPlans?: ImplementationPlan[];
  canEdit?: boolean;
  canDelete?: boolean;
}

withDefaults(defineProps<Props>(), {
  linkedProposals: () => [],
  implementationPlans: () => [],
  canEdit: false,
  canDelete: false,
});

defineEmits<{
  (e: 'edit'): void;
  (e: 'delete'): void;
  (e: 'view-proposal', proposalId: string): void;
  (e: 'create-implementation-plan'): void;
}>();

function formatStatus(status: string): string {
  return status
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (l) => l.toUpperCase());
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}
</script>

<style scoped lang="scss">
.project-detail {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

// ── Header ──────────────────────────────────────────────────────────────────

.detail-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--matou-border);
}

.detail-header-top {
  flex: 1;
  min-width: 0;
}

.badges-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
}

.status-badge {
  font-size: 0.75rem;
  padding: 3px 10px;
  border-radius: 12px;
  font-weight: 500;
  text-transform: capitalize;
  background: var(--matou-muted);
  color: var(--matou-muted-foreground);

  &.created { background: #e0e7ff; color: #4338ca; }
  &.active { background: #d1fae5; color: #059669; }
  &.completed { background: #dbeafe; color: #2563eb; }
  &.archived { background: #f3f4f6; color: #6b7280; }
}

.role-badge {
  font-size: 0.75rem;
  padding: 3px 10px;
  border-radius: 12px;
  font-weight: 500;

  &.lead { background: #dbeafe; color: #2563eb; }
  &.steward { background: #d1fae5; color: #059669; }
}

.detail-title {
  font-size: 1.8rem;
  font-weight: 700;
  margin: 0 0 6px;
  color: var(--matou-foreground);
  line-height: 1.2;
}

.detail-meta {
  color: var(--matou-muted-foreground);
  margin: 0;
  font-size: 0.875rem;
}

.detail-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

// ── Content sections ────────────────────────────────────────────────────────

.content-section {
  background: var(--matou-card);
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius);
  padding: 16px 20px;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.section-title {
  font-size: 1rem;
  font-weight: 600;
  color: var(--matou-foreground);
  margin: 0 0 12px;
}

.section-text {
  color: var(--matou-muted-foreground);
  margin: 0;
  white-space: pre-wrap;
  line-height: 1.6;
}

// ── Proposals list ──────────────────────────────────────────────────────────

.proposals-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.proposal-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background: var(--matou-secondary);
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius-sm);
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease;

  &:hover {
    background: var(--matou-muted);
    border-color: var(--matou-accent);
  }
}

.proposal-item-body {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.proposal-item-title {
  font-size: 0.9rem;
  font-weight: 500;
  color: var(--matou-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.proposal-item-status {
  font-size: 0.7rem;
  padding: 2px 7px;
  border-radius: 12px;
  font-weight: 500;
  flex-shrink: 0;
  background: var(--matou-muted);
  color: var(--matou-muted-foreground);

  &.draft { background: #f3f4f6; color: #6b7280; }
  &.submitted { background: #fef3c7; color: #d97706; }
  &.in_review { background: #dbeafe; color: #2563eb; }
  &.signed_off { background: #d1fae5; color: #059669; }
  &.approved { background: #d1fae5; color: #059669; }
  &.rejected { background: #fee2e2; color: #dc2626; }
  &.completed { background: #dbeafe; color: #2563eb; }
}

.item-arrow {
  width: 15px;
  height: 15px;
  color: var(--matou-muted-foreground);
  flex-shrink: 0;
}

// ── Implementation plans ────────────────────────────────────────────────────

.empty-plans {
  color: var(--matou-muted-foreground);
  font-size: 0.875rem;
}

.plans-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.plan-card {
  background: var(--matou-secondary);
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius-sm);
  padding: 12px 14px;
}

.plan-card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}

.plan-budget {
  font-weight: 600;
  font-size: 0.9rem;
  color: var(--matou-foreground);
}

.plan-lead {
  color: var(--matou-muted-foreground);
  margin-top: 2px;
}

.milestones-label {
  font-size: 0.78rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--matou-muted-foreground);
  margin-bottom: 6px;
}

.milestone-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 0;
  border-top: 1px solid var(--matou-border);
  font-size: 0.875rem;

  &:first-of-type {
    border-top: none;
  }
}

.milestone-num {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--matou-primary);
  color: white;
  font-size: 0.7rem;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.milestone-title {
  flex: 1;
  color: var(--matou-foreground);
}

.milestone-duration {
  font-size: 0.78rem;
  color: var(--matou-muted-foreground);
  flex-shrink: 0;
}

.milestones-empty {
  font-size: 0.8rem;
  color: var(--matou-muted-foreground);
}
</style>
