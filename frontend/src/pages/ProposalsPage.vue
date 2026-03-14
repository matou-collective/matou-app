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
          @click="router.push({ name: 'proposal-detail', params: { id: proposal.id } })"
        >
          <div class="proposal-card-header">
            <h3>{{ proposal.title }}</h3>
            <span class="status-badge" :class="proposal.status">{{ formatStatus(proposal.status) }}</span>
          </div>
          <p class="proposal-description">{{ proposal.description }}</p>

          <!-- Endorsement progress bar for submitted proposals -->
          <div v-if="proposal.status === 'submitted'" class="endorsement-bar">
            <div class="endorsement-bar-header">
              <span class="endorsement-label">Endorsements</span>
              <span class="endorsement-count">{{ getEndorsementCount(proposal.id) }} / {{ proposal.endorsement_threshold || 1 }}</span>
            </div>
            <q-linear-progress
              :value="getEndorsementProgress(proposal.id, proposal.endorsement_threshold)"
              color="pink"
              rounded
              size="6px"
            />
          </div>

          <div class="proposal-meta">
            <span class="proposal-type">{{ proposal.type?.join(', ') }}</span>
            <span class="proposal-priority" :class="proposal.priority">{{ proposal.priority }}</span>
            <span>{{ new Date(proposal.created_at).toLocaleDateString() }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Create Proposal Dialog -->
    <CreateProposalDialog
      v-model="showCreateDialog"
      @submit="handleCreateSubmit"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { Vote } from 'lucide-vue-next';
import { useQuasar } from 'quasar';
import { useProposalsStore } from 'stores/proposals';
import { useIdentityStore } from 'stores/identity';
import { listEndorsements } from 'src/lib/api/proposals';
import CreateProposalDialog from 'src/components/proposals/CreateProposalDialog.vue';

const router = useRouter();
const $q = useQuasar();
const proposalsStore = useProposalsStore();
const identityStore = useIdentityStore();
const showCreateDialog = ref(false);
const activeFilter = ref('all');

// Track endorsement counts per proposal
const endorsementCounts = ref<Record<string, number>>({});

const filters = [
  { label: 'All', value: 'all' },
  { label: 'Active', value: 'active' },
  { label: 'Draft', value: 'draft' },
  { label: 'Closed', value: 'closed' },
];

const filteredProposals = computed(() => {
  const all = proposalsStore.proposals;
  if (activeFilter.value === 'all') return all;
  if (activeFilter.value === 'active') {
    return all.filter(p => ['submitted', 'in_review', 'signed_off', 'voting_process'].includes(p.status));
  }
  if (activeFilter.value === 'closed') {
    return all.filter(p => ['approved', 'rejected', 'completed'].includes(p.status));
  }
  return all.filter(p => p.status === activeFilter.value);
});

async function fetchEndorsementCounts() {
  for (const p of proposalsStore.proposals) {
    try {
      const result = await listEndorsements(p.id);
      endorsementCounts.value[p.id] = result.total || result.endorsements?.length || 0;
    } catch {
      endorsementCounts.value[p.id] = 0;
    }
  }
}

onMounted(async () => {
  await proposalsStore.fetchProposals();
  fetchEndorsementCounts();
});

function formatStatus(status: string) {
  return status.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
}

function getEndorsementCount(proposalId: string): number {
  return endorsementCounts.value[proposalId] || 0;
}

function getEndorsementProgress(proposalId: string, threshold?: number): number {
  const count = getEndorsementCount(proposalId);
  const t = threshold || 1;
  return Math.min(count / t, 1);
}

async function handleCreateSubmit(form: {
  title: string;
  type: string[];
  priority: string;
  description: string;
  problem_statement: string;
  solution: string;
  expected_outcomes: string[];
  estimated_budget: string;
  timeline: string;
  attachments?: { name: string; url: string }[];
}) {
  try {
    await proposalsStore.create({
      proposer_id: identityStore.currentAID?.name || identityStore.currentAID?.prefix || 'unknown',
      title: form.title,
      type: form.type,
      priority: form.priority as 'low' | 'medium' | 'high' | 'critical',
      description: form.description,
      problem_statement: form.problem_statement,
      solution: form.solution,
      expected_outcomes: form.expected_outcomes,
      estimated_budget: form.estimated_budget,
      timeline: form.timeline,
      attachments: form.attachments,
    });
    showCreateDialog.value = false;
    $q.notify({ type: 'positive', message: 'Proposal created!' });
  } catch {
    $q.notify({ type: 'negative', message: 'Failed to create proposal' });
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
  background: transparent;
  color: var(--matou-teal, #0d9488);
  border: 2px solid var(--matou-teal, #0d9488);
  border-radius: 8px;
  padding: 8px 16px;
  font-weight: 500;
  cursor: pointer;
  &:hover { background: var(--matou-teal, #0d9488); color: white; }
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
    background: var(--matou-teal, #0d9488);
    color: white;
    border-color: var(--matou-teal, #0d9488);
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
  cursor: pointer;
  transition: box-shadow 0.15s, border-color 0.15s;
  &:hover {
    border-color: var(--matou-teal, #0d9488);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
  }
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
  &.draft { background: #f3f4f6; color: #6b7280; }
  &.submitted { background: #fef3c7; color: #d97706; }
  &.in_review { background: #dbeafe; color: #2563eb; }
  &.signed_off { background: #d1fae5; color: #059669; }
  &.voting_process { background: #e0e7ff; color: #4f46e5; }
  &.approved { background: #d1fae5; color: #059669; }
  &.rejected { background: #fee2e2; color: #dc2626; }
}

.proposal-description {
  color: var(--text-secondary);
  margin: 0 0 12px;
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
  color: var(--text-secondary);
}

.endorsement-count {
  font-size: 0.8rem;
  color: var(--text-tertiary, #9ca3af);
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
