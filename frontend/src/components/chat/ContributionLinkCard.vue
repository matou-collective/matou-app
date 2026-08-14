<template>
  <div class="entity-link-card" @click="$emit('open', contributionId)">
    <!-- Loading -->
    <div v-if="loading" class="card-loading">
      <q-spinner-dots size="20px" color="primary" />
      <span>Loading contribution...</span>
    </div>

    <!-- Error -->
    <div v-else-if="error" class="card-error">
      <q-icon name="error_outline" size="18px" color="grey-6" />
      <span>Contribution not found</span>
    </div>

    <!-- Contribution preview -->
    <template v-else-if="contribution">
      <div class="card-header">
        <q-icon name="assignment" size="18px" color="primary" />
        <span class="card-title">{{ contribution.title }}</span>
      </div>
      <div class="card-meta">
        <span class="status-badge" :class="contribution.status">
          {{ formatStatus(contribution.status) }}
        </span>
        <span v-if="contribution.contribution_type" class="type-tag">
          {{ formatStatus(contribution.contribution_type) }}
        </span>
        <span v-if="contribution.priority" class="priority-tag" :class="contribution.priority">
          {{ contribution.priority }}
        </span>
      </div>
      <div class="card-footer">
        <span class="view-action">View Contribution</span>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { getContribution, type Contribution } from 'src/lib/api/contributions';

const props = defineProps<{
  contributionId: string;
}>();

defineEmits<{
  (e: 'open', id: string): void;
}>();

const contribution = ref<Contribution | null>(null);
const loading = ref(true);
const error = ref(false);

function formatStatus(status: string) {
  return status.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
}

onMounted(async () => {
  try {
    contribution.value = await getContribution(props.contributionId);
  } catch {
    error.value = true;
  } finally {
    loading.value = false;
  }
});
</script>

<style lang="scss" scoped>
.entity-link-card {
  margin-top: 0.5rem;
  padding: 0.625rem 0.75rem;
  background: var(--matou-card);
  border: 1px solid var(--matou-border);
  border-left: 3px solid var(--matou-primary);
  border-radius: var(--matou-radius);
  cursor: pointer;
  transition: background-color 0.15s ease, box-shadow 0.15s ease;
  width: 100%;
  min-width: 0;
  box-sizing: border-box;

  &:hover {
    background: var(--matou-secondary);
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
  }
}

.card-loading,
.card-error {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8rem;
  color: var(--matou-muted-foreground);
  padding: 0.25rem 0;
}

.card-header {
  display: flex;
  align-items: flex-start;
  gap: 0.375rem;
  margin-bottom: 0.375rem;
  min-width: 0;
}

.card-title {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--matou-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;

  @media (max-width: 480px) {
    white-space: normal;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }
}

.card-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
  margin-bottom: 0.375rem;
}

.status-badge {
  font-size: 0.675rem;
  padding: 1px 8px;
  border-radius: 10px;
  text-transform: capitalize;
  font-weight: 500;
  white-space: nowrap;
  background: var(--matou-muted);
  color: var(--matou-muted-foreground);
}

.type-tag {
  font-size: 0.675rem;
  padding: 1px 8px;
  border-radius: 10px;
  background: #f3f4f6;
  color: #6b7280;
  text-transform: capitalize;
  white-space: nowrap;
}

.priority-tag {
  font-size: 0.675rem;
  padding: 1px 8px;
  border-radius: 10px;
  text-transform: capitalize;
  white-space: nowrap;
  background: #f3f4f6;
  color: #6b7280;

  &.critical { background: #fee2e2; color: #dc2626; }
  &.high { background: #fef3c7; color: #d97706; }
  &.medium { background: #dbeafe; color: #2563eb; }
  &.low { background: #f3f4f6; color: #6b7280; }
}

.card-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.5rem;
}

.view-action {
  font-size: 0.75rem;
  color: var(--matou-primary);
  font-weight: 500;
  white-space: nowrap;
  flex-shrink: 0;
}
</style>
