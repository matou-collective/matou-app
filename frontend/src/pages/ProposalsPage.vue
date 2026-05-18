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

    <!-- My Proposals section -->
    <section v-if="myProposalsAll.length > 0" class="my-proposals-section">
      <div class="section-heading-row">
        <h3 class="section-heading">My Proposals</h3>
        <button
          v-if="myProposalsWithdrawn.length > 0"
          class="show-withdrawn-btn"
          :class="{ active: showWithdrawn }"
          @click="showWithdrawn = !showWithdrawn"
        >
          {{ showWithdrawn ? 'Hide withdrawn' : `Show withdrawn (${myProposalsWithdrawn.length})` }}
        </button>
      </div>
      <div class="proposals-list">
        <ProposalCard
          v-for="proposal in myProposals"
          :key="`mine-${proposal.id}`"
          :proposal="proposal"
          :endorsement-count="getEndorsementCount(proposal.id)"
          @click="router.push({ name: 'proposal-detail', params: { id: proposal.id } })"
        >
          <div class="proposal-card-header">
            <h3>{{ proposal.title }}</h3>
            <span class="status-badge" :class="proposal.status">{{ formatStatus(proposal.status) }}</span>
          </div>
          <p class="proposal-description">{{ proposal.description }}</p>

          <div v-if="proposal.status === 'submitted'" class="endorsement-bar">
            <div class="endorsement-bar-header">
              <span class="endorsement-label">Endorsements</span>
              <span class="endorsement-count">{{ getEndorsementCount(proposal.id) }} / {{ proposal.endorsement_threshold || 2 }}</span>
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
        </ProposalCard>
      </div>
    </section>

    <!-- All proposals heading -->
    <h3 v-if="myProposalsAll.length > 0" class="section-heading">All Proposals</h3>

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
        <ProposalCard
          v-for="proposal in filteredProposals"
          :key="proposal.id"
          :proposal="proposal"
          :endorsement-count="getEndorsementCount(proposal.id)"
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
              <span class="endorsement-count">{{ getEndorsementCount(proposal.id) }} / {{ proposal.endorsement_threshold || 2 }}</span>
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
        </ProposalCard>
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
import { ref, computed, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { Vote } from 'lucide-vue-next';
import { useQuasar } from 'quasar';
import { useProposalsStore } from 'stores/proposals';
import { useIdentityStore } from 'stores/identity';
import { listEndorsements } from 'src/lib/api/proposals';
import CreateProposalDialog from 'src/components/proposals/CreateProposalDialog.vue';
import ProposalCard from 'src/components/proposals/ProposalCard.vue';
import { useBackendEvents } from 'src/composables/useBackendEvents';

const router = useRouter();
const $q = useQuasar();
const proposalsStore = useProposalsStore();
const identityStore = useIdentityStore();
const showCreateDialog = ref(false);
const activeFilter = ref('active');
const { lastEvent } = useBackendEvents();

watch(lastEvent, (event) => {
  if (!event) return;
  const refreshEvents = [
    'proposal:status_changed',
    'proposal:endorsed',
    'proposal:updated',
    'proposal:created',
    'proposal:approved',
    'proposal:rejected',
    'proposal_updated',
  ];
  if (refreshEvents.includes(event.type)) {
    void proposalsStore.fetchProposals();
  }
});

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
    return all.filter(p => ['approved', 'rejected', 'completed', 'withdrawn'].includes(p.status));
  }
  return all.filter(p => p.status === activeFilter.value);
});

const showWithdrawn = ref(false);

const myProposalsAll = computed(() => {
  const aid = identityStore.currentAID;
  if (!aid) return [];
  const ids = [aid.name, aid.prefix].filter(Boolean) as string[];
  if (ids.length === 0) return [];
  return proposalsStore.proposals.filter(p => ids.includes(p.proposer_id));
});

const myProposalsWithdrawn = computed(() =>
  myProposalsAll.value.filter(p => p.status === 'withdrawn'),
);

const myProposals = computed(() =>
  showWithdrawn.value
    ? myProposalsAll.value
    : myProposalsAll.value.filter(p => p.status !== 'withdrawn'),
);

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

function getEndorsementCount(proposalId: string): number {
  return endorsementCounts.value[proposalId] || 0;
}

function formatStatus(status: string): string {
  return status.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
}

function getEndorsementProgress(proposalId: string, threshold?: number): number {
  const count = getEndorsementCount(proposalId);
  const t = threshold || 2;
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
  max-width: 1200px;
  margin: 0 auto;
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
  color: var(--matou-foreground);
}

.proposals-subtitle {
  color: var(--matou-muted-foreground);
  margin: 4px 0 0;
}

.create-btn {
  background: transparent;
  color: var(--matou-teal, #0d9488);
  border: 2px solid var(--matou-teal, #0d9488);
  border-radius: 10px;
  padding: 8px 16px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;

  &:hover {
    background: var(--matou-teal, #0d9488);
    color: white;
  }
}

.filter-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 20px;
}

.filter-pill {
  background: transparent;
  border: 1px solid var(--matou-border);
  border-radius: 20px;
  padding: 6px 14px;
  font-size: 0.85rem;
  cursor: pointer;
  color: var(--matou-muted-foreground);
  transition: background 0.15s, color 0.15s, border-color 0.15s;

  &.active {
    background: var(--matou-teal, #0d9488);
    color: white;
    border-color: var(--matou-teal, #0d9488);
  }

  &:hover:not(.active) {
    background: var(--matou-secondary);
    border-color: var(--matou-accent);
    color: var(--matou-foreground);
  }
}

.loading-state,
.empty-state {
  text-align: center;
  padding: 60px 20px;
  color: var(--matou-muted-foreground);
}

.empty-icon {
  opacity: 0.3;
  margin-bottom: 16px;
}

.proposals-list {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}

@media (max-width: 1000px) {
  .proposals-list {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 640px) {
  .proposals-list {
    grid-template-columns: 1fr;
  }
}

.my-proposals-section {
  margin-bottom: 28px;
}

.section-heading {
  font-size: 1rem;
  font-weight: 600;
  color: var(--matou-foreground);
  margin: 0 0 12px;
  letter-spacing: 0.01em;
}

.section-heading-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;

  .section-heading {
    margin: 0;
  }
}

.show-withdrawn-btn {
  background: transparent;
  border: 1px solid var(--matou-border);
  border-radius: 14px;
  padding: 3px 10px;
  font-size: 0.75rem;
  color: var(--matou-muted-foreground);
  cursor: pointer;
  transition: background 0.12s, color 0.12s, border-color 0.12s;

  &:hover {
    border-color: var(--matou-accent);
    color: var(--matou-foreground);
  }

  &.active {
    background: var(--matou-secondary);
    color: var(--matou-foreground);
    border-color: var(--matou-accent);
  }
}
</style>
