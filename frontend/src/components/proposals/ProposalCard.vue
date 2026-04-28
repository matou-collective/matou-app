<template>
  <div class="proposal-card" @click="$emit('click')">
    <div class="proposal-card-header">
      <div class="proposal-card-title-row">
        <h3 class="proposal-title">{{ proposal.title }}</h3>
        <ProposalStatusBadge :status="proposal.status" />
      </div>

      <div class="proposal-meta">
        <span v-if="proposal.type?.length" class="meta-tag meta-tag--type">
          {{ proposal.type.join(', ') }}
        </span>
        <span
          v-if="proposal.priority"
          class="meta-tag"
          :class="`meta-tag--priority-${proposal.priority}`"
        >
          {{ proposal.priority }}
        </span>
        <span class="meta-date">
          {{ formatDate(proposal.created_at) }}
        </span>
      </div>
    </div>

    <p class="proposal-description">{{ proposal.description }}</p>

    <!-- Endorsement progress for submitted proposals -->
    <div v-if="proposal.status === 'submitted' && endorsementCount !== undefined" class="endorsement-bar">
      <div class="endorsement-bar-header">
        <span class="endorsement-label">Endorsements</span>
        <span class="endorsement-count">
          {{ endorsementCount }} / {{ proposal.endorsement_threshold || 2 }}
        </span>
      </div>
      <q-linear-progress
        :value="endorsementProgress"
        color="pink"
        rounded
        size="6px"
      />
    </div>

    <div class="proposal-footer">
      <span class="proposer-label">by {{ proposal.proposer_id }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { Proposal } from 'src/lib/api/proposals';
import ProposalStatusBadge from './ProposalStatusBadge.vue';

const props = defineProps<{
  proposal: Proposal;
  endorsementCount?: number;
}>();

defineEmits<{
  click: [];
}>();

const endorsementProgress = computed(() => {
  const count = props.endorsementCount ?? 0;
  const threshold = props.proposal.endorsement_threshold || 2;
  return Math.min(count / threshold, 1);
});

function formatDate(dateStr: string): string {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleDateString('en-NZ', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
</script>

<style scoped lang="scss">
.proposal-card {
  background: var(--matou-card);
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius);
  padding: 20px;
  cursor: pointer;
  transition:
    box-shadow 0.15s ease,
    border-color 0.15s ease;

  &:hover {
    border-color: var(--matou-accent);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
  }
}

.proposal-card-header {
  margin-bottom: 10px;
}

.proposal-card-title-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 8px;
}

.proposal-title {
  margin: 0;
  font-size: 1.05rem;
  font-weight: 600;
  color: var(--matou-foreground);
  line-height: 1.3;
  flex: 1;
  min-width: 0;
}

.proposal-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.meta-tag {
  font-size: 0.75rem;
  padding: 2px 8px;
  border-radius: 10px;
  text-transform: capitalize;
  background: #f3f4f6;
  color: #6b7280;
}

.meta-tag--type {
  background: #dbeafe;
  color: #2563eb;
}

.meta-tag--priority-critical {
  background: #fee2e2;
  color: #dc2626;
}

.meta-tag--priority-high {
  background: #fef3c7;
  color: #d97706;
}

.meta-tag--priority-medium {
  background: #dbeafe;
  color: #2563eb;
}

.meta-tag--priority-low {
  background: #f3f4f6;
  color: #6b7280;
}

.meta-date {
  font-size: 0.75rem;
  color: var(--matou-muted-foreground);
  margin-left: auto;
}

.proposal-description {
  color: var(--matou-muted-foreground);
  font-size: 0.9rem;
  margin: 0 0 12px;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.endorsement-bar {
  margin-bottom: 12px;
}

.endorsement-bar-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}

.endorsement-label {
  font-size: 0.8rem;
  color: var(--matou-muted-foreground);
}

.endorsement-count {
  font-size: 0.8rem;
  color: var(--matou-muted-foreground);
}

.proposal-footer {
  display: flex;
  align-items: center;
}

.proposer-label {
  font-size: 0.78rem;
  color: var(--matou-muted-foreground);
  font-style: italic;
}
</style>
