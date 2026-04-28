<template>
  <div class="proposal-link-card" @click="$emit('open', proposalId)">
    <!-- Loading -->
    <div v-if="loading" class="card-loading">
      <q-spinner-dots size="20px" color="primary" />
      <span>Loading proposal...</span>
    </div>

    <!-- Error -->
    <div v-else-if="error" class="card-error">
      <q-icon name="error_outline" size="18px" color="grey-6" />
      <span>Proposal not found</span>
    </div>

    <!-- Proposal preview -->
    <template v-else-if="proposal">
      <div class="card-header">
        <q-icon name="description" size="18px" color="primary" />
        <span class="card-title">{{ proposal.title }}</span>
      </div>
      <div class="card-meta">
        <span class="status-badge" :class="proposal.status">
          {{ formatStatus(proposal.status) }}
        </span>
        <span v-if="proposal.type?.length" class="type-tag">
          {{ proposal.type.join(', ') }}
        </span>
        <span v-if="proposal.priority" class="priority-tag" :class="proposal.priority">
          {{ proposal.priority }}
        </span>
      </div>
      <div class="card-footer">
        <div v-if="endorsementCount !== null" class="endorsement-info">
          <q-icon name="favorite" size="14px" color="pink" />
          <span>{{ endorsementCount }} / {{ proposal.endorsement_threshold || 2 }} endorsements</span>
        </div>
        <span class="view-action">View Proposal</span>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { getProposal, listEndorsements, type Proposal } from 'src/lib/api/proposals';

const props = defineProps<{
  proposalId: string;
}>();

defineEmits<{
  (e: 'open', id: string): void;
}>();

const proposal = ref<Proposal | null>(null);
const endorsementCount = ref<number | null>(null);
const loading = ref(true);
const error = ref(false);

function formatStatus(status: string) {
  return status.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
}

onMounted(async () => {
  try {
    proposal.value = await getProposal(props.proposalId);
    const result = await listEndorsements(props.proposalId);
    endorsementCount.value = result.endorsements?.length ?? 0;
  } catch {
    error.value = true;
  } finally {
    loading.value = false;
  }
});
</script>

<style lang="scss" scoped>
.proposal-link-card {
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

  &.draft { background: #f3f4f6; color: #6b7280; }
  &.submitted { background: #fef3c7; color: #d97706; }
  &.endorsing { background: #fce7f3; color: #db2777; }
  &.in_review { background: #dbeafe; color: #2563eb; }
  &.signed_off { background: #d1fae5; color: #059669; }
  &.voting_process { background: #e0e7ff; color: #4f46e5; }
  &.approved { background: #d1fae5; color: #059669; }
  &.rejected { background: #fee2e2; color: #dc2626; }
  &.completed { background: #d1fae5; color: #059669; }
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
  justify-content: space-between;
  gap: 0.5rem;

  @media (max-width: 360px) {
    flex-direction: column;
    align-items: flex-start;
    gap: 0.25rem;
  }
}

.endorsement-info {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.75rem;
  color: var(--matou-muted-foreground);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.view-action {
  font-size: 0.75rem;
  color: var(--matou-primary);
  font-weight: 500;
  white-space: nowrap;
  flex-shrink: 0;
}
</style>
