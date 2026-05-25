<template>
  <div class="milestone-card" :class="{ 'signed-off': isPlanSignedOff, expanded: isExpanded }">
    <!-- Header -->
    <div class="milestone-header" @click="isExpanded = !isExpanded">
      <div class="milestone-header-left">
        <span class="milestone-number">{{ milestoneNumber }}</span>
        <div class="milestone-title-group">
          <h3 class="milestone-title">{{ milestone.title }}</h3>
          <div class="milestone-meta">
            <span class="meta-pill">{{ milestone.duration }}</span>
            <span v-if="milestone.start_date && milestone.end_date" class="meta-pill">
              {{ formatDate(milestone.start_date) }} — {{ formatDate(milestone.end_date) }}
            </span>
          </div>
        </div>
      </div>
      <div class="milestone-header-right">
        <span v-if="hasBudget" class="budget-pill">
          Budget: {{ formatCurrency(milestone.budget_allocation ?? 0) }}
          <q-tooltip>
            The budget allocated to this milestone at planning time. Set when creating or editing the milestone.
          </q-tooltip>
        </span>
        <span
          v-if="hasBudget || actualCost > 0"
          class="budget-pill actual-pill"
          :class="{ 'over-budget': isOverBudget }"
        >
          Actual: {{ formatCurrency(actualCost) }}
          <q-tooltip>
            The running cost of this milestone, summed from the budget of each non-archived contribution.
            For completed contributions this reflects the final agreed cost; for in-progress contributions it reflects the latest estimate.
          </q-tooltip>
        </span>
        <span class="milestone-meta-count">{{ totalCount }} contributions</span>
        <span v-if="isPlanSignedOff" class="badge-locked">
          <Lock class="badge-icon" />
          Locked
        </span>
        <span v-else-if="allConfirmed && contributions.length > 0" class="badge-confirmed">
          <CheckCircle class="badge-icon" />
          All Confirmed
        </span>
        <div v-if="canEdit" class="milestone-row-actions" @click.stop>
          <q-btn
            flat round dense size="sm"
            icon="edit"
            @click="emit('edit-milestone', milestone)"
          >
            <q-tooltip>Edit Milestone</q-tooltip>
          </q-btn>
        </div>
        <div class="expand-btn">
          <ChevronDown class="expand-icon" :class="{ rotated: isExpanded }" />
        </div>
      </div>
    </div>

    <!-- Over-budget warning -->
    <div v-if="isOverBudget" class="over-budget-banner">
      <AlertTriangle class="banner-icon" />
      <div>
        <div class="banner-title">Over budget</div>
        <div class="banner-sub">
          Actual ({{ formatCurrency(actualCost) }}) exceeds the allocated budget ({{ formatCurrency(milestone.budget_allocation ?? 0) }}) by {{ formatCurrency(actualCost - (milestone.budget_allocation ?? 0)) }}.
        </div>
      </div>
    </div>

    <!-- Contributions list (expanded) -->
    <div v-if="isExpanded" class="contributions-body">
      <!-- Empty state -->
      <div v-if="contributions.length === 0" class="contributions-empty">
        <AlertCircle class="empty-icon" />
        <span>No contributions in this milestone yet</span>
      </div>

      <!-- Contribution cards -->
      <div v-else class="contributions-list">
        <ContributionCardCompact
          v-for="contribution in contributions"
          :key="contribution.id"
          :contribution="contribution"
          :can-confirm="canConfirm"
          :can-edit="canEdit"
          :is-plan-signed-off="isPlanSignedOff"
          :user-role="userRole"
          :current-user-id="currentUserId"
          :all-contributions="allContributions"
          @update="$emit('update-contribution', $event)"
          @view-detail="$emit('view-contribution', $event)"
          @create-child="$emit('create-child-contribution', $event)"
          @assign="(c: Contribution) => emit('assign-contribution', c)"
          @edit="(c: Contribution) => emit('edit-contribution', c)"
          @archive="(c: Contribution) => emit('archive-contribution', c)"
        />
      </div>

      <!-- Add contribution (always available to those with edit perms; adding a
           contribution post-signoff invalidates the plan and requires re-signoff). -->
      <div v-if="canEdit" class="add-contribution-row">
        <button class="add-contribution-btn" @click="$emit('create-contribution', milestone.milestone_id)">
          <Plus class="add-icon" />
          Add Contribution
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { ChevronDown, CheckCircle, Lock, AlertCircle, AlertTriangle, Plus } from 'lucide-vue-next';
import type { Milestone, Contribution } from 'src/types/projects';
import ContributionCardCompact from './ContributionCardCompact.vue';

interface Props {
  milestone: Milestone;
  milestoneNumber: number;
  projectId?: string;
  canEdit?: boolean;
  canConfirm?: boolean;
  isPlanSignedOff?: boolean;
  userRole?: string;
  currentUserId?: string;
  allContributions?: Contribution[];
}

const props = withDefaults(defineProps<Props>(), {
  projectId: undefined,
  canEdit: false,
  canConfirm: false,
  isPlanSignedOff: false,
  userRole: 'member',
  currentUserId: '',
  allContributions: () => [],
});

const emit = defineEmits<{
  (e: 'create-contribution', milestoneId: string): void;
  (e: 'update-contribution', contribution: Contribution): void;
  (e: 'view-contribution', contribution: Contribution): void;
  (e: 'create-child-contribution', parentId: string): void;
  (e: 'assign-contribution', contribution: Contribution): void;
  (e: 'edit-milestone', milestone: Milestone): void;
  (e: 'archive-milestone', milestone: Milestone): void;
  (e: 'edit-contribution', contribution: Contribution): void;
  (e: 'archive-contribution', contribution: Contribution): void;
}>();

const isExpanded = ref(true);

const contributions = computed<Contribution[]>(
  () => ((props.milestone.contributions ?? []) as Contribution[])
    .filter(c => c.status !== 'archived'),
);

const allConfirmed = computed(
  () =>
    contributions.value.length > 0 &&
    contributions.value.every((c) => c.status === 'confirmed'),
);

const confirmedCount = computed(() =>
  contributions.value.filter((c) => c.status !== 'created').length,
);
const totalCount = computed(() => contributions.value.length);
const progressPercent = computed(() =>
  totalCount.value === 0 ? 0 : Math.round((confirmedCount.value / totalCount.value) * 100),
);

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// Parse a free-form budget string ("$1,234.50", "1234", "USD 500") to a number.
// Returns 0 when nothing parseable is found.
function parseBudget(s: string | undefined): number {
  if (!s) return 0;
  const cleaned = s.replace(/[^0-9.\-]/g, '');
  if (!cleaned) return 0;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

const actualCost = computed(() =>
  contributions.value.reduce((sum, c) => sum + parseBudget(c.budget), 0),
);

const hasBudget = computed(() => (props.milestone.budget_allocation ?? 0) > 0);

const isOverBudget = computed(
  () => hasBudget.value && actualCost.value > (props.milestone.budget_allocation ?? 0),
);

function formatCurrency(n: number): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(n);
}
</script>

<style scoped lang="scss">
.milestone-card {
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius);
  overflow: hidden;
  transition: border-color 0.15s ease;

  &.signed-off {
    border-color: var(--matou-primary);

    .milestone-header {
      background: var(--matou-primary);
      color: var(--matou-primary-foreground);
    }

    .milestone-title,
    .milestone-number,
    .meta-pill,
    .expand-icon {
      color: var(--matou-primary-foreground) !important;
    }

    .meta-pill {
      background: rgba(255, 255, 255, 0.15);
    }
  }
}

.milestone-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  background: var(--matou-card);
  cursor: pointer;
  user-select: none;
  gap: 12px;

  &:hover {
    background: var(--matou-secondary);
  }
}

.milestone-header-left {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  min-width: 0;
}

.milestone-number {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--matou-primary);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.8rem;
  font-weight: 700;
  flex-shrink: 0;

  .signed-off & {
    background: rgba(255, 255, 255, 0.25);
  }
}

.milestone-title-group {
  flex: 1;
  min-width: 0;
}

.milestone-title {
  font-size: 1rem;
  font-weight: 600;
  margin: 0 0 4px;
  color: var(--matou-foreground);
  line-height: 1.3;
}

.milestone-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.meta-pill {
  font-size: 0.75rem;
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--matou-secondary);
  color: var(--matou-muted-foreground);
}

.milestone-header-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.badge-locked,
.badge-confirmed {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.75rem;
  font-weight: 500;
  padding: 3px 10px;
  border-radius: 12px;
}

.badge-locked {
  background: rgba(255, 255, 255, 0.2);
  color: var(--matou-primary-foreground, white);
}

.badge-confirmed {
  background: rgba(74, 157, 156, 0.12);
  color: var(--matou-accent, #4a9d9c);
}

.badge-icon {
  width: 12px;
  height: 12px;
}

.expand-btn {
  padding: 2px;
  border-radius: 4px;
  color: var(--matou-muted-foreground);
}

.expand-icon {
  width: 18px;
  height: 18px;
  transition: transform 0.2s ease;

  &.rotated {
    transform: rotate(180deg);
  }
}

// Body
.contributions-body {
  padding: 12px 16px 16px;
  background: var(--matou-background, #fafbfc);
  border-top: 1px solid var(--matou-border);
}

.contributions-empty {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px;
  color: var(--matou-muted-foreground);
  font-size: 0.875rem;
  justify-content: center;
}

.empty-icon {
  width: 20px;
  height: 20px;
  opacity: 0.5;
}

.contributions-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
}

.add-contribution-row {
  margin-top: 8px;
}

.add-contribution-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border: 1px dashed var(--matou-border);
  border-radius: var(--matou-radius-sm);
  background: transparent;
  cursor: pointer;
  font-size: 0.82rem;
  color: var(--matou-muted-foreground);
  transition: all 0.12s ease;

  &:hover {
    border-color: var(--matou-primary);
    color: var(--matou-primary);
  }
}

.add-icon {
  width: 14px;
  height: 14px;
}

.milestone-meta-count {
  font-size: 0.75rem;
  color: $grey-7;

  .signed-off & {
    color: var(--matou-primary-foreground) !important;
  }
}

.milestone-progress {
  margin: 0.5rem 1rem 0;
}

.milestone-progress-label {
  font-size: 0.7rem;
  color: $grey-6;
  padding: 0.25rem 1rem;
}

.milestone-row-actions {
  display: flex;
  gap: 2px;
  align-items: center;
}

.budget-pill {
  font-size: 0.75rem;
  padding: 3px 10px;
  border-radius: 12px;
  background: rgba(74, 157, 156, 0.12);
  color: var(--matou-accent, #4a9d9c);
  font-weight: 500;
  white-space: nowrap;

  .signed-off & {
    background: rgba(255, 255, 255, 0.18);
    color: var(--matou-primary-foreground, white);
  }
}

.actual-pill {
  background: rgba(0, 0, 0, 0.05);
  color: var(--matou-muted-foreground);

  &.over-budget {
    background: rgba(245, 158, 11, 0.15);
    color: #b45309; // amber-700
  }

  .signed-off & {
    background: rgba(255, 255, 255, 0.12);
    color: var(--matou-primary-foreground, white);

    &.over-budget {
      background: rgba(245, 158, 11, 0.35);
      color: #fef3c7; // amber-100 on dark
    }
  }
}

.over-budget-banner {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 18px;
  background: rgba(245, 158, 11, 0.12);
  border-bottom: 1px solid rgba(245, 158, 11, 0.25);
  color: #92400e; // amber-800

  .banner-icon {
    width: 18px;
    height: 18px;
    flex-shrink: 0;
    color: #d97706; // amber-600
    margin-top: 2px;
  }

  .banner-title {
    font-size: 0.85rem;
    font-weight: 600;
  }

  .banner-sub {
    font-size: 0.78rem;
    color: #b45309;
    line-height: 1.3;
    margin-top: 2px;
  }
}
</style>
