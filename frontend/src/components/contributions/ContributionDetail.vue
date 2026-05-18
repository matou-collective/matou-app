<template>
  <div class="contribution-detail">
    <!-- Header -->
    <div class="detail-header">
      <div class="badges-row">
        <ContributionStatusBadge :status="contribution.status" />
        <span class="type-badge">{{ contribution.contribution_type }}</span>
      </div>
      <h1 class="detail-title">
        <span>{{ contribution.title }}</span>
        <slot name="title-actions" />
      </h1>
      <p class="detail-meta">
        Created by {{ contribution.created_by }}
        &middot;
        {{ new Date(contribution.created_at).toLocaleDateString() }}
        <template v-if="contribution.assigned_contributor_id">
          &middot; Assigned to {{ contribution.assigned_contributor_id }}
        </template>
      </p>
    </div>

    <!-- Status transition actions (slot for parent to pass buttons) -->
    <div v-if="$slots.actions" class="action-buttons">
      <slot name="actions" />
    </div>

    <!-- Description -->
    <div class="content-section">
      <h3 class="section-title">Description</h3>
      <p class="section-text">{{ contribution.description }}</p>
    </div>

    <!-- Objectives -->
    <div v-if="contribution.objectives?.length" class="content-section">
      <h3 class="section-title">Objectives</h3>
      <ul class="item-list">
        <li v-for="(obj, i) in contribution.objectives" :key="i">
          <q-icon name="radio_button_checked" size="14px" color="primary" class="list-icon" />
          <span>{{ obj }}</span>
        </li>
      </ul>
    </div>

    <!-- Deliverables -->
    <div v-if="contribution.deliverables?.length" class="content-section">
      <h3 class="section-title">Deliverables</h3>
      <ul class="item-list">
        <li v-for="(del, i) in contribution.deliverables" :key="i">
          <q-icon name="check_box_outline_blank" size="14px" color="primary" class="list-icon" />
          <span>{{ del }}</span>
        </li>
      </ul>
    </div>

    <!-- Acceptance Criteria -->
    <div v-if="contribution.acceptance_criteria?.length" class="content-section">
      <h3 class="section-title">Acceptance Criteria</h3>
      <ul class="item-list">
        <li v-for="(crit, i) in contribution.acceptance_criteria" :key="i">
          <q-icon name="check_circle" size="14px" color="positive" class="list-icon" />
          <span>{{ crit }}</span>
        </li>
      </ul>
    </div>

    <!-- Skill Requirements -->
    <div v-if="contribution.skill_requirements?.length" class="content-section">
      <h3 class="section-title">Skill Requirements</h3>
      <div class="skill-chips">
        <q-chip
          v-for="(skill, i) in contribution.skill_requirements"
          :key="i"
          dense
          color="blue-1"
          text-color="blue-8"
        >
          {{ skill }}
        </q-chip>
      </div>
    </div>

    <!-- Estimates -->
    <div class="grid-2">
      <div v-if="contribution.estimated_duration" class="info-card">
        <div class="info-card-label">Estimated Hours</div>
        <div class="info-card-value">{{ contribution.estimated_duration }}h</div>
      </div>
      <div v-if="contribution.budget" class="info-card">
        <div class="info-card-label">Budget</div>
        <div class="info-card-value">{{ contribution.budget }}</div>
      </div>
    </div>

    <!-- Evidence submission slot -->
    <div v-if="$slots.evidence" class="content-section">
      <h3 class="section-title row items-center q-gutter-sm">
        <q-icon name="attach_file" size="18px" />
        <span>Evidence</span>
      </h3>
      <slot name="evidence" />
    </div>

    <!-- Review feedback slot -->
    <div v-if="$slots.feedback" class="content-section">
      <h3 class="section-title row items-center q-gutter-sm">
        <q-icon name="rate_review" size="18px" />
        <span>Review Feedback</span>
      </h3>
      <slot name="feedback" />
    </div>
  </div>
</template>

<script setup lang="ts">
import type { Contribution } from 'src/lib/api/contributions';
import ContributionStatusBadge from './ContributionStatusBadge.vue';

defineProps<{
  contribution: Contribution;
}>();
</script>

<style scoped lang="scss">
.contribution-detail {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

// Header
.detail-header {
  padding-bottom: 20px;
  border-bottom: 1px solid var(--matou-border);
}

.badges-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
}

.type-badge {
  display: inline-block;
  font-size: 0.75rem;
  font-weight: 500;
  padding: 3px 10px;
  border-radius: 12px;
  background: #dbeafe;
  color: #2563eb;
  text-transform: capitalize;
}

.priority-badge {
  display: inline-block;
  font-size: 0.75rem;
  font-weight: 500;
  padding: 3px 10px;
  border-radius: 12px;
  text-transform: capitalize;
  background: #f3f4f6;
  color: #6b7280;

  &.low      { background: #f3f4f6; color: #6b7280; }
  &.medium   { background: #dbeafe; color: #2563eb; }
  &.high     { background: #fef3c7; color: #d97706; }
  &.critical { background: #fee2e2; color: #dc2626; }
}

.detail-title {
  font-size: 1.75rem;
  font-weight: 700;
  margin: 0 0 6px;
  color: var(--matou-foreground);
  line-height: 1.2;
  display: flex;
  align-items: center;
  gap: 8px;
}

.detail-meta {
  color: var(--matou-muted-foreground);
  margin: 0;
  font-size: 0.875rem;
}

// Action buttons row
.action-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

// Content sections
.content-section {
  background: var(--matou-card);
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius);
  padding: 16px 20px;
}

.section-title {
  font-size: 1rem;
  font-weight: 600;
  margin: 0 0 10px;
  color: var(--matou-foreground);
}

.section-text {
  color: var(--matou-muted-foreground);
  white-space: pre-wrap;
  margin: 0;
  line-height: 1.6;
}

// Lists
.item-list {
  list-style: none;
  padding: 0;
  margin: 0;

  li {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin-bottom: 8px;
    color: var(--matou-muted-foreground);
    line-height: 1.5;

    &:last-child {
      margin-bottom: 0;
    }
  }
}

.list-icon {
  flex-shrink: 0;
  margin-top: 2px;
}

// Skill chips
.skill-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

// Grid cards
.grid-2 {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 16px;
}

.info-card {
  background: var(--matou-card);
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius);
  padding: 16px;
}

.info-card-label {
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--matou-muted-foreground);
  margin-bottom: 4px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.info-card-value {
  font-size: 1rem;
  color: var(--matou-foreground);
  font-weight: 500;
}
</style>
