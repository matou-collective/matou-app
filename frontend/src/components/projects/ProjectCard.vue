<template>
  <div
    class="project-card"
    :class="{ clickable: clickable }"
    @click="clickable ? $emit('click') : undefined"
  >
    <!-- Status stripe -->
    <div class="status-stripe" :class="project.status" />

    <div class="card-body">
      <div class="card-header">
        <div class="card-title-row">
          <h3 class="card-title">{{ project.title }}</h3>
          <span class="status-badge" :class="project.status">
            {{ formatStatus(project.status) }}
          </span>
        </div>
        <p class="card-description">{{ project.description }}</p>
      </div>

      <div class="card-meta">
        <div v-if="project.project_lead_id" class="meta-item">
          <User class="meta-icon" />
          <span>Lead: {{ project.project_lead_id }}</span>
        </div>
        <div v-if="project.project_steward_id" class="meta-item">
          <Shield class="meta-icon" />
          <span>Steward: {{ project.project_steward_id }}</span>
        </div>
        <div v-if="linkedProposalCount > 0" class="meta-item">
          <Vote class="meta-icon" />
          <span>{{ linkedProposalCount }} proposal{{ linkedProposalCount !== 1 ? 's' : '' }}</span>
        </div>
        <div class="meta-item meta-date">
          <Calendar class="meta-icon" />
          <span>{{ formatDate(project.created_at) }}</span>
        </div>
      </div>
    </div>

    <div v-if="clickable" class="card-arrow">
      <ChevronRight class="arrow-icon" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { User, Shield, Vote, Calendar, ChevronRight } from 'lucide-vue-next';
import type { Project } from 'src/lib/api/projects';

interface Props {
  project: Project;
  clickable?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  clickable: true,
});

defineEmits<{
  (e: 'click'): void;
}>();

const linkedProposalCount = computed(() => props.project.proposal_ids?.length ?? 0);

function formatStatus(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
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

.status-stripe {
  width: 4px;
  flex-shrink: 0;
  background: var(--matou-muted);

  &.active { background: #059669; }
  &.created { background: var(--matou-primary); }
  &.completed { background: #2563eb; }
  &.archived { background: #9ca3af; }
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
  margin-bottom: 6px;
  flex-wrap: wrap;
}

.card-title {
  font-size: 1rem;
  font-weight: 600;
  color: var(--matou-foreground);
  margin: 0;
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

  &.meta-date {
    margin-left: auto;
  }
}

.meta-icon {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
}

.card-arrow {
  display: flex;
  align-items: center;
  padding: 0 12px 0 4px;
  color: var(--matou-muted-foreground);
  flex-shrink: 0;
}

.arrow-icon {
  width: 16px;
  height: 16px;
}
</style>
