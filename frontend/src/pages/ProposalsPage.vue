<template>
  <div class="proposals-page">
    <div class="proposals-header">
      <div class="proposals-header-text">
        <h2 class="proposals-title">Proposals</h2>
        <p class="proposals-subtitle">Community proposals and governance</p>
      </div>
      <button class="create-btn" @click="showCreateDialog = true">
        + New Proposal
      </button>
    </div>

    <!-- Filter pills -->
    <div class="filter-row">
      <button
        v-for="f in filters"
        :key="f.value"
        class="filter-pill"
        :class="{ active: activeFilter === f.value }"
        @click="activeFilter = f.value"
      >
        {{ f.label }}
      </button>
    </div>

    <div class="feed-container">
      <div v-if="proposalsStore.isLoading" class="loading-state">
        <q-spinner-dots size="40px" color="primary" />
      </div>
      <div v-else-if="filteredProposals.length === 0" class="empty-state">
        <Vote :size="48" class="empty-icon" />
        <h3>No proposals yet</h3>
        <p>Submit a proposal to suggest improvements or new initiatives.</p>
      </div>
      <div v-else class="proposals-list">
        <div
          v-for="proposal in filteredProposals"
          :key="proposal.id"
          class="proposal-card"
        >
          <div class="proposal-card-header">
            <h3>{{ proposal.title }}</h3>
            <span class="status-badge" :class="proposal.status">{{ proposal.status.replace('_', ' ') }}</span>
          </div>
          <p class="proposal-description">{{ proposal.description }}</p>
          <div class="proposal-meta">
            <span class="proposal-type">{{ proposal.type?.join(', ') }}</span>
            <span class="proposal-priority" :class="proposal.priority">{{ proposal.priority }}</span>
            <span>{{ new Date(proposal.created_at).toLocaleDateString() }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Create Proposal Dialog -->
    <q-dialog v-model="showCreateDialog">
      <q-card style="min-width: 550px">
        <q-card-section>
          <div class="text-h6">Create Proposal</div>
        </q-card-section>
        <q-card-section>
          <q-input v-model="newProposal.title" label="Title" outlined class="q-mb-md" />
          <q-input v-model="newProposal.description" label="Description" type="textarea" outlined class="q-mb-md" />
          <q-input v-model="newProposal.problem_statement" label="Problem Statement" type="textarea" outlined class="q-mb-md" />
          <q-input v-model="newProposal.solution" label="Proposed Solution" type="textarea" outlined class="q-mb-md" />
          <q-select
            v-model="newProposal.type"
            :options="proposalTypes"
            label="Type"
            outlined
            multiple
            class="q-mb-md"
          />
          <q-select
            v-model="newProposal.priority"
            :options="priorities"
            label="Priority"
            outlined
          />
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat label="Cancel" v-close-popup />
          <q-btn flat label="Submit" color="primary" @click="createProposal" :loading="creating" />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { Vote } from 'lucide-vue-next';
import { useProposalsStore } from 'stores/proposals';

const proposalsStore = useProposalsStore();
const showCreateDialog = ref(false);
const creating = ref(false);
const activeFilter = ref('all');

const filters = [
  { label: 'All', value: 'all' },
  { label: 'Draft', value: 'draft' },
  { label: 'Submitted', value: 'submitted' },
  { label: 'In Review', value: 'in_review' },
  { label: 'Approved', value: 'approved' },
];

const proposalTypes = ['technical', 'community', 'governance', 'operations'];
const priorities = ['low', 'medium', 'high', 'critical'];

const newProposal = ref({
  proposer_id: '',
  title: '',
  description: '',
  problem_statement: '',
  solution: '',
  type: [] as string[],
  priority: 'medium' as 'low' | 'medium' | 'high' | 'critical',
  expected_outcomes: [] as string[],
  estimated_budget: '',
  timeline: '',
});

const filteredProposals = computed(() => {
  if (activeFilter.value === 'all') return proposalsStore.proposals;
  return proposalsStore.proposals.filter(
    (p: { status: string }) => p.status === activeFilter.value,
  );
});

onMounted(() => {
  proposalsStore.fetchProposals();
});

async function createProposal() {
  creating.value = true;
  try {
    await proposalsStore.create({
      ...newProposal.value,
      proposer_id: newProposal.value.proposer_id || 'current-user',
    });
    showCreateDialog.value = false;
    newProposal.value = {
      proposer_id: '',
      title: '',
      description: '',
      problem_statement: '',
      solution: '',
      type: [],
      priority: 'medium',
      expected_outcomes: [],
      estimated_budget: '',
      timeline: '',
    };
  } finally {
    creating.value = false;
  }
}
</script>

<style scoped lang="scss">
.proposals-page {
  padding: 24px;
  max-width: 900px;
}

.proposals-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 16px;
}

.proposals-title {
  font-size: 1.5rem;
  font-weight: 600;
  margin: 0;
}

.proposals-subtitle {
  color: var(--text-secondary);
  margin: 4px 0 0;
}

.create-btn {
  background: var(--matou-teal);
  color: white;
  border: none;
  border-radius: 8px;
  padding: 8px 16px;
  font-weight: 500;
  cursor: pointer;
  &:hover { opacity: 0.9; }
}

.filter-row {
  display: flex;
  gap: 8px;
  margin-bottom: 20px;
}

.filter-pill {
  background: transparent;
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 20px;
  padding: 6px 14px;
  font-size: 0.85rem;
  cursor: pointer;
  color: var(--text-secondary);
  &.active {
    background: var(--matou-teal);
    color: white;
    border-color: var(--matou-teal);
  }
}

.loading-state,
.empty-state {
  text-align: center;
  padding: 60px 20px;
  color: var(--text-secondary);
}

.empty-icon {
  opacity: 0.3;
  margin-bottom: 16px;
}

.proposal-card {
  background: var(--card-bg, #fff);
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 12px;
}

.proposal-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  h3 { margin: 0; font-size: 1.1rem; }
}

.status-badge {
  font-size: 0.75rem;
  padding: 2px 8px;
  border-radius: 12px;
  text-transform: capitalize;
  background: var(--matou-teal-light, #e0f7f4);
  color: var(--matou-teal);
  &.submitted { background: #fef3c7; color: #d97706; }
  &.in_review { background: #dbeafe; color: #2563eb; }
  &.approved { background: #d1fae5; color: #059669; }
  &.rejected { background: #fee2e2; color: #dc2626; }
}

.proposal-description {
  color: var(--text-secondary);
  margin: 0 0 12px;
}

.proposal-meta {
  display: flex;
  gap: 12px;
  font-size: 0.8rem;
  color: var(--text-tertiary, #9ca3af);
}

.proposal-priority {
  text-transform: capitalize;
  &.high { color: #f59e0b; }
  &.critical { color: #dc2626; }
}
</style>
