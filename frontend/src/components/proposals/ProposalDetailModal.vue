<template>
  <q-dialog
    :model-value="modelValue"
    @update:model-value="$emit('update:modelValue', $event)"
    maximized
    transition-show="slide-up"
    transition-hide="slide-down"
  >
    <q-card class="proposal-detail-modal">
      <!-- Toolbar -->
      <q-toolbar class="modal-toolbar">
        <q-toolbar-title class="text-weight-bold">Proposal Details</q-toolbar-title>
        <q-btn flat round icon="open_in_new" @click="navigateToPage" title="View Full Page" />
        <q-btn flat round icon="close" v-close-popup />
      </q-toolbar>

      <q-card-section class="modal-body q-pa-lg" style="overflow-y: auto">
        <!-- Loading -->
        <div v-if="loading" class="loading-state">
          <q-spinner-dots size="40px" color="primary" />
        </div>

        <!-- Error -->
        <div v-else-if="error" class="error-state">
          <q-icon name="error_outline" size="48px" color="grey-5" />
          <p>{{ error }}</p>
        </div>

        <template v-else-if="proposal">
          <!-- Header -->
          <div class="detail-header">
            <div class="badges-row">
              <span class="status-badge" :class="proposal.status">
                {{ formatStatus(proposal.status) }}
              </span>
              <span v-if="proposal.type?.length" class="category-badge">
                {{ proposal.type.join(', ') }}
              </span>
            </div>
            <h2 class="detail-title">{{ proposal.title }}</h2>
            <p class="detail-proposer">Proposed by {{ proposal.proposer_id }}</p>
          </div>

          <!-- Actions -->
          <div class="action-buttons">
            <q-btn
              v-if="proposal.status === 'submitted'"
              color="pink"
              no-caps
              icon="favorite"
              label="Endorse Proposal"
              @click="showEndorseModal = true"
            />
            <q-btn
              flat
              no-caps
              icon="open_in_new"
              label="View Full Page"
              @click="navigateToPage"
            />
          </div>

          <!-- Endorsement Progress -->
          <div v-if="proposal.status === 'submitted'" class="endorsement-card">
            <div class="endorsement-header">
              <div class="row items-center q-gutter-xs">
                <q-icon name="favorite" color="pink" size="18px" />
                <span class="text-weight-medium">Endorsement Progress</span>
              </div>
              <span :class="endorsementProgress >= 100 ? 'text-positive' : 'text-grey-6'">
                {{ endorsements.length }} / {{ proposal.endorsement_threshold || 1 }}
              </span>
            </div>
            <q-linear-progress
              :value="Math.min(endorsementProgress / 100, 1)"
              color="pink"
              class="q-mt-sm"
              rounded
              size="12px"
            />
          </div>

          <!-- Description -->
          <div class="content-section">
            <h3 class="section-title">Description</h3>
            <p class="section-text">{{ proposal.description }}</p>
          </div>

          <!-- Problem Statement -->
          <div class="content-section">
            <h3 class="section-title">Problem Statement</h3>
            <p class="section-text">{{ proposal.problem_statement }}</p>
          </div>

          <!-- Solution -->
          <div class="content-section">
            <h3 class="section-title">Proposed Solution</h3>
            <p class="section-text">{{ proposal.solution }}</p>
          </div>

          <!-- Expected Outcomes -->
          <div v-if="proposal.expected_outcomes?.length" class="content-section">
            <h3 class="section-title">Expected Outcomes</h3>
            <ul class="outcomes-list">
              <li v-for="(outcome, i) in proposal.expected_outcomes" :key="i">
                <q-icon name="check_circle" color="primary" size="16px" />
                <span>{{ outcome }}</span>
              </li>
            </ul>
          </div>

          <!-- Budget & Timeline -->
          <div class="grid-2">
            <div class="info-card">
              <h4 class="info-card-label">Estimated Budget</h4>
              <p class="info-card-value">{{ proposal.estimated_budget }}</p>
            </div>
            <div class="info-card">
              <h4 class="info-card-label">Timeline (months)</h4>
              <p class="info-card-value">{{ proposal.timeline }}</p>
            </div>
          </div>

          <!-- Priority & Type -->
          <div class="grid-2">
            <div class="info-card">
              <h4 class="info-card-label">Priority Level</h4>
              <span class="priority-badge" :class="proposal.priority">
                {{ proposal.priority }}
              </span>
            </div>
            <div class="info-card">
              <h4 class="info-card-label">Proposal Type</h4>
              <span class="type-badge">{{ proposal.type?.join(', ') }}</span>
            </div>
          </div>

          <!-- Attachments -->
          <div v-if="proposal.attachments?.length" class="content-section">
            <h3 class="section-title">Attachments</h3>
            <a
              v-for="(att, i) in proposal.attachments"
              :key="i"
              :href="att.url"
              target="_blank"
              class="attachment-link"
            >
              <q-icon name="description" color="primary" size="20px" />
              <span>{{ att.name }}</span>
            </a>
          </div>

          <!-- Discussion -->
          <div class="content-section">
            <h3 class="section-title row items-center q-gutter-sm">
              <q-icon name="chat" size="20px" />
              <span>Discussion ({{ comments.length }})</span>
            </h3>
            <div v-if="comments.length === 0" class="empty-discussion">
              No comments yet.
            </div>
            <div v-else class="comments-list">
              <div v-for="c in comments" :key="c.id" class="comment-card">
                <div class="comment-header">
                  <div class="comment-avatar">
                    <q-icon name="person" size="14px" />
                  </div>
                  <span class="comment-author">{{ c.user_name }}</span>
                  <span class="comment-time">&middot; {{ new Date(c.created_at).toLocaleString() }}</span>
                </div>
                <p class="comment-text">{{ c.text }}</p>
              </div>
            </div>
          </div>
        </template>
      </q-card-section>
    </q-card>
  </q-dialog>

  <!-- Endorse sub-modal -->
  <EndorseProposalModal
    v-model="showEndorseModal"
    :proposal-title="proposal?.title ?? ''"
    @confirm="confirmEndorse"
  />
</template>

<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import { useRouter } from 'vue-router';
import { useQuasar } from 'quasar';
import {
  getProposal,
  listEndorsements,
  listProposalComments,
  addEndorsement,
  type Proposal,
  type Endorsement,
  type ProposalComment,
} from 'src/lib/api/proposals';
import { useIdentityStore } from 'stores/identity';
import EndorseProposalModal from './EndorseProposalModal.vue';

const props = defineProps<{
  modelValue: boolean;
  proposalId: string;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  endorsed: [];
}>();

const router = useRouter();
const $q = useQuasar();
const identityStore = useIdentityStore();

const proposal = ref<Proposal | null>(null);
const endorsements = ref<Endorsement[]>([]);
const comments = ref<ProposalComment[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);
const showEndorseModal = ref(false);

const endorsementProgress = computed(() => {
  const threshold = proposal.value?.endorsement_threshold || 1;
  return (endorsements.value.length / threshold) * 100;
});

watch(
  () => props.modelValue,
  async (open) => {
    if (open && props.proposalId) {
      await loadData();
    }
  },
);

async function loadData() {
  loading.value = true;
  error.value = null;
  try {
    proposal.value = await getProposal(props.proposalId);
    const [endRes, comRes] = await Promise.all([
      listEndorsements(props.proposalId),
      listProposalComments(props.proposalId),
    ]);
    endorsements.value = endRes.endorsements || [];
    comments.value = comRes.comments || [];
  } catch {
    error.value = 'Failed to load proposal';
  } finally {
    loading.value = false;
  }
}

function formatStatus(status: string) {
  return status.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
}

function navigateToPage() {
  emit('update:modelValue', false);
  router.push({ path: `/dashboard/proposals/${props.proposalId}` });
}

async function confirmEndorse(comment: string) {
  if (!proposal.value) return;
  try {
    await addEndorsement(proposal.value.id, {
      endorser_id: identityStore.currentAID?.name || identityStore.currentAID?.prefix || 'unknown',
      endorsed_at: new Date().toISOString(),
      comment: comment || undefined,
    });
    showEndorseModal.value = false;
    $q.notify({ type: 'positive', message: 'Proposal endorsed!' });
    await loadData();
    emit('endorsed');
  } catch {
    $q.notify({ type: 'negative', message: 'Endorsement failed' });
  }
}
</script>

<style lang="scss" scoped>
.proposal-detail-modal {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.modal-toolbar {
  border-bottom: 1px solid var(--matou-border);
  flex-shrink: 0;
}

.modal-body {
  flex: 1;
  overflow-y: auto;
  max-width: 900px;
  margin: 0 auto;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.loading-state,
.error-state {
  text-align: center;
  padding: 60px 20px;
  color: var(--matou-muted-foreground);
}

// ── Header ────────────────────────────────────────────────────────────────────

.detail-header {
  padding-bottom: 16px;
  border-bottom: 1px solid var(--matou-border);
}

.badges-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}

.status-badge {
  font-size: 0.75rem;
  padding: 3px 10px;
  border-radius: 12px;
  text-transform: capitalize;
  font-weight: 500;
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

.category-badge {
  font-size: 0.75rem;
  padding: 3px 10px;
  border-radius: 12px;
  background: #f3f4f6;
  color: #6b7280;
  text-transform: capitalize;
}

.detail-title {
  font-size: 1.5rem;
  font-weight: 700;
  margin: 0 0 4px;
  color: var(--matou-foreground);
  line-height: 1.2;
}

.detail-proposer {
  color: var(--matou-muted-foreground);
  margin: 0;
  font-size: 0.9rem;
}

// ── Actions ───────────────────────────────────────────────────────────────────

.action-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

// ── Endorsement card ──────────────────────────────────────────────────────────

.endorsement-card {
  background: var(--matou-card);
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius);
  padding: 16px;
}

.endorsement-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

// ── Content sections ──────────────────────────────────────────────────────────

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

.outcomes-list {
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

    &:last-child { margin-bottom: 0; }
  }
}

// ── Grid cards ────────────────────────────────────────────────────────────────

.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

.info-card {
  background: var(--matou-card);
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius);
  padding: 16px;
}

.info-card-label {
  font-size: 0.8rem;
  font-weight: 500;
  color: var(--matou-muted-foreground);
  margin: 0 0 6px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.info-card-value {
  color: var(--matou-foreground);
  margin: 0;
  font-size: 0.95rem;
}

.priority-badge {
  display: inline-block;
  font-size: 0.75rem;
  padding: 3px 10px;
  border-radius: 12px;
  text-transform: capitalize;
  background: #f3f4f6;
  color: #6b7280;

  &.critical { background: #fee2e2; color: #dc2626; }
  &.high { background: #fef3c7; color: #d97706; }
  &.medium { background: #dbeafe; color: #2563eb; }
  &.low { background: #f3f4f6; color: #6b7280; }
}

.type-badge {
  display: inline-block;
  font-size: 0.75rem;
  padding: 3px 10px;
  border-radius: 12px;
  background: #dbeafe;
  color: #2563eb;
  text-transform: capitalize;
}

// ── Attachments ───────────────────────────────────────────────────────────────

.attachment-link {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  background: var(--matou-secondary);
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius-sm);
  text-decoration: none;
  color: var(--matou-foreground);
  margin-bottom: 8px;

  &:last-child { margin-bottom: 0; }
  &:hover { background: var(--matou-muted); }
}

// ── Discussion ────────────────────────────────────────────────────────────────

.empty-discussion {
  text-align: center;
  padding: 20px;
  background: var(--matou-secondary);
  border-radius: var(--matou-radius-sm);
  color: var(--matou-muted-foreground);
  font-size: 0.9rem;
}

.comments-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.comment-card {
  background: var(--matou-secondary);
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius-sm);
  padding: 12px;
}

.comment-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.comment-avatar {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: #dbeafe;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.comment-author {
  font-size: 0.85rem;
  font-weight: 500;
}

.comment-time {
  font-size: 0.75rem;
  color: var(--matou-muted-foreground);
}

.comment-text {
  font-size: 0.9rem;
  color: var(--matou-muted-foreground);
  margin: 0;
  line-height: 1.5;
}
</style>
