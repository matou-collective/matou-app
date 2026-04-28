<template>
  <div class="decision-plan-view">
    <div class="dp-header">
      <div class="dp-header-content">
        <h3 class="dp-title">Decision Plan</h3>
        <span v-if="decisionPlan.status === 'signed_off'" class="dp-signed-badge">Signed Off</span>
      </div>
      <div class="dp-meta">
        Status: <strong>{{ decisionPlan.status }}</strong>
      </div>
    </div>

    <p v-if="housesWithActions.length === 0" class="no-actions no-actions--overall">
      No governance actions yet
    </p>

    <div v-for="house in housesWithActions" :key="house.value" class="house-section">
      <div class="house-header" :style="{ borderLeftColor: house.color }">
        <q-icon :name="house.icon" size="20px" :style="{ color: house.color }" />
        <span class="house-name">{{ house.label }}</span>
        <span class="house-count">({{ getHouseActions(house.value).length }})</span>
      </div>

      <div
        v-for="action in getHouseActions(house.value)"
        :key="action.id"
        class="action-card"
        @click="$emit('actionClick', action.id)"
      >
        <div class="action-header">
          <div class="action-type-icon">
            <q-icon :name="getActionIcon(action.action_type)" size="16px" color="teal" />
          </div>
          <span class="action-type-label">{{ formatLabel(action.action_type) }}</span>
          <q-space />
          <span class="status-badge" :class="`status-badge--${action.status}`">
            {{ action.status }}
          </span>
          <span
            v-if="action.outcome"
            class="outcome-badge"
            :class="outcomeClass(action.outcome)"
          >
            {{ formatLabel(action.outcome.replace(/_/g, ' ')) }}
          </span>
        </div>

        <p class="action-description">{{ action.description }}</p>

        <div v-if="action.meeting_date" class="action-meeting-info">
          <q-icon name="event" size="14px" />
          <span>{{ action.meeting_date }}{{ action.meeting_time ? ' at ' + action.meeting_time : '' }}</span>
          <template v-if="action.meeting_location">
            <span class="separator">&middot;</span>
            <span>{{ action.meeting_location }}</span>
          </template>
        </div>
      </div>
    </div>

    <div class="dp-actions">
      <q-btn
        v-if="canEdit"
        no-caps
        icon="add"
        label="Add Governance Action"
        color="primary"
        class="add-action-btn"
        @click="$emit('addAction')"
      />
      <q-btn
        v-if="canSubmit"
        flat
        no-caps
        label="Submit for Review"
        color="primary"
        @click="$emit('submitForReview')"
      />
      <q-btn
        v-if="canSignOff"
        no-caps
        label="Sign Off Decision Plan"
        color="positive"
        class="sign-off-btn"
        @click="$emit('signOff')"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { DecisionPlan, GovernanceAction } from 'src/lib/api/decisionPlans';

interface House {
  value: string;
  label: string;
  icon: string;
  color: string;
}

const HOUSES: House[] = [
  { value: 'elders_council', label: 'Elder Council', icon: 'shield', color: '#7c3aed' },
  { value: 'community_reps', label: 'Community Representatives', icon: 'groups', color: '#2563eb' },
  { value: 'contributors', label: 'Contributors', icon: 'engineering', color: '#059669' },
];

const props = defineProps<{
  decisionPlan: DecisionPlan;
  canEdit: boolean;
  canSubmit: boolean;
  canSignOff: boolean;
}>();

defineEmits<{
  actionClick: [actionId: string];
  addAction: [];
  submitForReview: [];
  signOff: [];
}>();

function getHouseActions(house: string): GovernanceAction[] {
  return (props.decisionPlan.governance_actions ?? []).filter((a) => a.house === house);
}

const housesWithActions = computed(() =>
  HOUSES.filter((h) => getHouseActions(h.value).length > 0),
);

function getActionIcon(type: GovernanceAction['action_type']): string {
  switch (type) {
    case 'discussion':
      return 'chat';
    case 'meeting':
      return 'event';
    case 'decision':
      return 'how_to_vote';
  }
}

function formatLabel(raw: string): string {
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function outcomeClass(outcome: GovernanceAction['outcome']): string {
  if (outcome === 'approved' || outcome === 'no_veto') return 'outcome-badge--positive';
  return 'outcome-badge--negative';
}
</script>

<style scoped lang="scss">
.decision-plan-view {
  background: var(--matou-card);
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius);
  overflow: hidden;
}

// ── Header ──────────────────────────────────────────────────────────────────

.dp-header {
  padding: 16px 20px;
  background: linear-gradient(135deg, var(--matou-primary) 0%, var(--matou-accent) 100%);
  color: #fff;
}

.dp-header-content {
  display: flex;
  align-items: center;
  gap: 8px;
}

.dp-title {
  margin: 0;
  font-size: 1.05rem;
  font-weight: 600;
}

.dp-signed-badge {
  background: rgba(255, 255, 255, 0.2);
  padding: 2px 10px;
  border-radius: 12px;
  font-size: 0.72rem;
  font-weight: 500;
  letter-spacing: 0.02em;
}

.dp-meta {
  margin-top: 4px;
  font-size: 0.8rem;
  opacity: 0.9;
}

// ── House sections ───────────────────────────────────────────────────────────

.house-section {
  padding: 16px 20px;

  & + & {
    border-top: 1px solid var(--matou-border);
  }
}

.house-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  padding-left: 10px;
  border-left: 3px solid transparent;
}

.house-name {
  font-weight: 600;
  font-size: 0.9rem;
}

.house-count {
  color: var(--matou-muted-foreground);
  font-size: 0.8rem;
}

.no-actions {
  color: var(--matou-muted-foreground);
  font-size: 0.85rem;
  padding: 6px 0;
  margin: 0;
}

.no-actions--overall {
  padding: 24px 20px;
  text-align: center;
}

// ── Action card ──────────────────────────────────────────────────────────────

.action-card {
  background: var(--matou-secondary);
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius-sm);
  padding: 12px;
  margin-bottom: 8px;
  cursor: pointer;
  transition: background 0.15s ease;

  &:last-child {
    margin-bottom: 0;
  }

  &:hover {
    background: var(--matou-muted);
  }
}

.action-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.action-type-icon {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  background: rgba(74, 157, 156, 0.12);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.action-type-label {
  font-weight: 500;
  font-size: 0.88rem;
}

// ── Status badge ─────────────────────────────────────────────────────────────

.status-badge {
  font-size: 0.7rem;
  padding: 2px 8px;
  border-radius: 10px;
  text-transform: capitalize;
  background: var(--matou-muted);
  color: var(--matou-muted-foreground);

  &--completed {
    background: #d1fae5;
    color: #059669;
  }

  &--archived {
    background: #fef3c7;
    color: #d97706;
  }
}

// ── Outcome badge ────────────────────────────────────────────────────────────

.outcome-badge {
  font-size: 0.7rem;
  padding: 2px 8px;
  border-radius: 10px;

  &--positive {
    background: #d1fae5;
    color: #059669;
  }

  &--negative {
    background: #fee2e2;
    color: #dc2626;
  }
}

// ── Action detail rows ───────────────────────────────────────────────────────

.action-description {
  color: var(--matou-muted-foreground);
  font-size: 0.85rem;
  margin: 4px 0 0;
  line-height: 1.4;
}

.action-meeting-info {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 0.8rem;
  color: var(--matou-muted-foreground);
  margin-top: 6px;
}

.separator {
  opacity: 0.5;
}

// ── Bottom action bar ────────────────────────────────────────────────────────

.dp-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--matou-border);
  background: var(--matou-card);
}

.add-action-btn {
  width: 100%;
  border-radius: 10px;
}

.sign-off-btn {
  width: 100%;
  border-radius: 10px;
}
</style>
