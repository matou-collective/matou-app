<template>
  <div class="proposal-detail-page">
    <!-- Loading -->
    <div v-if="proposalsStore.isLoading && !proposal" class="loading-state">
      <q-spinner-dots size="40px" color="primary" />
    </div>

    <template v-else-if="proposal">
      <!-- Header -->
      <div class="detail-header">
        <q-btn
          flat
          round
          icon="arrow_back"
          @click="router.push({ name: 'proposals' })"
          class="q-mr-sm"
        />
        <div class="detail-header-content">
          <div class="badges-row">
            <span class="status-badge" :class="proposal.status">
              {{ formatStatus(proposal.status) }}
            </span>
            <span v-if="proposal.type?.length" class="category-badge">
              {{ proposal.type.join(', ') }}
            </span>
            <span v-if="proposal.proposal_lead_id" class="lead-badge">
              Lead: {{ proposal.proposal_lead_id }}
            </span>
          </div>
          <h1 class="detail-title">{{ proposal.title }}</h1>
          <p class="detail-proposer">Proposed by {{ proposal.proposer_id }}</p>
        </div>
        <q-btn
          flat
          no-caps
          label="View History"
          icon="history"
          @click="showHistory = true"
          class="history-btn"
        />
      </div>

      <!-- Content area -->
      <div class="detail-content">
        <!-- Action Buttons -->
        <div class="action-buttons">
          <!-- Draft -->
          <template v-if="proposal.status === 'draft' && isProposer">
            <q-btn
              color="primary"
              no-caps
              icon="send"
              label="Submit for Endorsement"
              class="action-btn-rounded"
              @click="submitForEndorsement"
              :loading="transitioning"
            />
            <q-btn
              flat
              no-caps
              icon="edit"
              label="Edit Proposal"
              class="action-btn-rounded"
              @click="showEditDialog = true"
            />
          </template>

          <!-- Submitted -->
          <template v-if="proposal.status === 'submitted'">
            <q-btn
              v-if="!isProposer"
              color="pink"
              no-caps
              icon="favorite"
              label="Endorse Proposal"
              class="action-btn-rounded"
              @click="showEndorseModal = true"
              :loading="endorsing"
            />
            <q-btn flat no-caps icon="link" label="Copy Proposal Link" class="action-btn-rounded" @click="copyLink" />
          </template>

          <!-- In Review -->
          <template v-if="proposal.status === 'in_review'">
            <q-btn
              v-if="isSteward"
              color="positive"
              no-caps
              icon="check"
              label="Sign Off Proposal"
              class="action-btn-rounded"
              @click="signOff"
              :loading="transitioning"
            />
            <q-btn
              v-if="isSteward"
              outline
              color="negative"
              no-caps
              icon="block"
              label="Reject Proposal"
              class="action-btn-rounded"
              @click="showRejectDialog = true"
            />
            <q-btn v-if="isSteward || isProposer" flat no-caps icon="edit" label="Edit Proposal" class="action-btn-rounded" @click="showEditDialog = true" />
            <div v-if="!isSteward && !isProposer" class="review-info-banner">
              <q-icon name="info" color="primary" size="20px" />
              <span>Proposal is currently in review.</span>
            </div>
          </template>

          <!-- Signed Off / Voting — add governance action (auto-creates plan if needed) -->
          <template
            v-if="
              canManageDecisionPlan &&
              (proposal.status === 'signed_off' || proposal.status === 'voting_process') &&
              (!decisionPlansStore.currentPlan || ['drafted', 'submitted', 'signed_off'].includes(decisionPlansStore.currentPlan.status))
            "
          >
            <q-btn
              color="primary"
              no-caps
              icon="add"
              label="Add Governance Action"
              class="action-btn-rounded"
              @click="showAddGovernanceAction = true"
            />
          </template>

          <!-- Approved — create or view project -->
          <template v-if="proposal.status === 'approved'">
            <q-btn
              v-if="linkedProject"
              color="primary"
              no-caps
              icon="open_in_new"
              label="View Project"
              :to="{ name: 'projects' }"
            />
            <q-btn
              v-else-if="isProposalLead || isProposalSteward || isAdmin"
              color="positive"
              no-caps
              icon="rocket_launch"
              label="Create Project"
              @click="createProject"
              :loading="creatingProject"
            />
          </template>
        </div>

        <!-- Endorsement Progress -->
        <div v-if="proposal.status === 'submitted'" class="endorsement-card">
          <div class="endorsement-header">
            <div class="row items-center q-gutter-xs">
              <q-icon name="favorite" color="pink" size="18px" />
              <span class="text-weight-medium">Endorsement Progress</span>
            </div>
            <span :class="endorsementProgress >= 100 ? 'text-positive' : 'text-grey-6'">
              {{ proposalsStore.endorsements.length }} /
              {{ proposal.endorsement_threshold || 2 }}
            </span>
          </div>
          <q-linear-progress
            :value="Math.min(endorsementProgress / 100, 1)"
            color="pink"
            class="q-mt-sm"
            rounded
            size="12px"
          />
          <div
            v-if="endorsementProgress >= 100"
            class="text-positive text-caption q-mt-xs row items-center q-gutter-xs"
          >
            <q-icon name="check_circle" size="14px" />
            <span>Threshold met! Moving to review...</span>
          </div>
        </div>

        <!-- Role Assignments -->
        <div v-if="showRoleAssignments" class="roles-card">
          <h3 class="section-title row items-center q-gutter-sm">
            <q-icon name="groups" size="20px" />
            <span>Assigned Roles</span>
          </h3>
          <div
            v-if="proposal.lead_contribution_id || proposal.steward_contribution_id"
            class="roles-notice q-mb-md"
          >
            <q-icon name="info" color="primary" size="16px" />
            <div>
              <div class="text-weight-medium" style="color: var(--matou-primary)">
                Role assignment contributions available
              </div>
              <div class="text-caption">Assign team members to lead and steward roles.</div>
            </div>
          </div>

          <!-- Lead row -->
          <div class="role-row">
            <div class="role-info">
              <div class="text-weight-medium">Proposal Lead</div>
              <div class="text-caption text-grey">Reviews and signs off proposal</div>
            </div>
            <template v-if="proposal.proposal_lead_id">
              <span class="role-assigned">{{ proposal.proposal_lead_id }}</span>
            </template>
            <q-btn
              v-else-if="proposal.lead_contribution_id && isSteward"
              size="sm"
              no-caps
              label="Claim Role"
              color="primary"
              class="action-btn-rounded"
              @click="claimRole('lead')"
            />
            <span v-else class="role-unassigned">Unassigned</span>
          </div>

          <!-- Steward row -->
          <div class="role-row">
            <div class="role-info">
              <div class="text-weight-medium">Proposal Steward</div>
              <div class="text-caption text-grey">Reviews and signs off decision plan</div>
            </div>
            <template v-if="proposal.proposal_steward_id">
              <span class="role-assigned">{{ proposal.proposal_steward_id }}</span>
            </template>
            <q-btn
              v-else-if="proposal.steward_contribution_id && isSteward"
              size="sm"
              no-caps
              label="Claim Role"
              color="teal"
              class="action-btn-rounded"
              @click="claimRole('steward')"
            />
            <span v-else class="role-unassigned">Unassigned</span>
          </div>
        </div>

        <!-- Decision Plan -->
        <DecisionPlanView
          v-if="decisionPlansStore.currentPlan"
          :decision-plan="decisionPlansStore.currentPlan"
          :can-edit="
            canManageDecisionPlan &&
            ['signed_off', 'voting_process'].includes(proposal.status) &&
            ['drafted', 'submitted', 'signed_off'].includes(decisionPlansStore.currentPlan.status)
          "
          :can-submit="
            canManageDecisionPlan &&
            ['signed_off', 'voting_process'].includes(proposal.status) &&
            decisionPlansStore.currentPlan.status === 'drafted' &&
            (decisionPlansStore.currentPlan.governance_actions?.length ?? 0) > 0
          "
          :can-sign-off="
            canManageDecisionPlan &&
            ['signed_off', 'voting_process'].includes(proposal.status) &&
            decisionPlansStore.currentPlan.status === 'submitted'
          "
          @action-click="openGovernanceAction"
          @add-action="showAddGovernanceAction = true"
          @submit-for-review="submitDecisionPlanForReview"
          @sign-off="signOffDecisionPlan"
        />

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
              <q-icon name="check_circle" color="primary" size="16px" class="flex-shrink-0" />
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
            <span>Discussion ({{ proposalsStore.comments.length }})</span>
          </h3>
          <div v-if="proposalsStore.comments.length === 0" class="empty-discussion">
            No comments yet. Be the first to share your thoughts!
          </div>
          <div v-else class="comments-list">
            <div
              v-for="c in proposalsStore.comments"
              :key="c.id"
              class="comment-row"
              :class="{ 'comment-row--mine': c.user_id === identityStore.currentAID?.prefix }"
            >
              <div
                class="comment-card"
                :class="[
                  { 'comment-card--mine': c.user_id === identityStore.currentAID?.prefix },
                  c.kind && c.kind !== 'user' ? `comment-card--${c.kind}` : '',
                ]"
              >
                <div class="comment-header">
                  <div class="comment-avatar">
                    <q-icon :name="commentKindIcon(c.kind)" size="14px" />
                  </div>
                  <span class="comment-author">{{ commentDisplayName(c) }}</span>
                  <span
                    v-if="c.subtitle"
                    class="comment-subtitle"
                    :class="commentSubtitleClass(c)"
                  >
                    {{ c.subtitle }}
                  </span>
                  <span class="comment-time">&middot; {{ new Date(c.created_at).toLocaleString() }}</span>
                </div>
                <p v-if="c.text" class="comment-text">{{ c.text }}</p>
                <div v-if="(c.attachments?.length ?? 0) > 0 || (c.links?.length ?? 0) > 0" class="comment-attachments">
                  <a
                    v-for="att in c.attachments"
                    :key="att.file_ref"
                    class="comment-chip"
                    :href="getFileUrl(att.file_ref)"
                    target="_blank"
                    rel="noopener"
                  >
                    <q-icon name="attach_file" size="12px" />
                    <span>{{ att.file_name }}</span>
                  </a>
                  <a
                    v-for="link in c.links"
                    :key="link"
                    class="comment-chip"
                    :href="link"
                    target="_blank"
                    rel="noopener"
                  >
                    <q-icon name="link" size="12px" />
                    <span>{{ link }}</span>
                  </a>
                </div>
              </div>
            </div>
          </div>
          <div class="comment-input-row">
            <q-input
              v-model="newComment"
              placeholder="Add your comment..."
              type="textarea"
              outlined
              autogrow
              dense
              class="col"
            />
            <q-btn
              flat
              round
              icon="send"
              color="primary"
              :disable="!newComment.trim()"
              @click="addComment"
            />
          </div>
        </div>
      </div>
    </template>

    <!-- Not found -->
    <div v-else class="empty-state">
      <h3>Proposal not found</h3>
      <q-btn
        flat
        no-caps
        label="Back to Proposals"
        @click="router.push({ name: 'proposals' })"
      />
    </div>

    <!-- Modals -->
    <EndorseProposalModal
      v-model="showEndorseModal"
      :proposal-title="proposal?.title ?? ''"
      @confirm="confirmEndorse"
    />

    <ProposalHistoryModal
      v-model="showHistory"
      :history="proposalsStore.history"
    />

    <CreateProposalDialog
      v-model="showEditDialog"
      :proposal="proposal"
      @submit="handleEditSubmit"
    />

    <AddGovernanceActionDialog
      v-model="showAddGovernanceAction"
      :existing-actions="decisionPlansStore.currentPlan?.governance_actions ?? []"
      :proposal-title="proposal?.title"
      @add="handleAddGovernanceAction"
    />

    <GovernanceActionModal
      v-if="selectedAction"
      v-model="showGovernanceAction"
      :action="selectedAction"
      :all-actions="decisionPlansStore.currentPlan?.governance_actions ?? []"
      :proposal-status="proposal?.status"
      :decision-plan-status="decisionPlansStore.currentPlan?.status"
      :can-manage="canManageDecisionPlan"
      @complete="handleCompleteAction"
      @archive="handleArchiveAction"
      @vote="handleCastVote"
      @resolve="handleResolveDecision"
    />

    <!-- Reject reason dialog -->
    <q-dialog v-model="showRejectDialog">
      <q-card style="min-width: 400px">
        <q-card-section>
          <div class="text-h6">Reject Proposal</div>
        </q-card-section>
        <q-card-section>
          <q-input
            v-model="rejectReason"
            label="Reason for rejection *"
            type="textarea"
            outlined
            autogrow
          />
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat no-caps label="Cancel" v-close-popup />
          <q-btn
            flat
            no-caps
            label="Reject"
            color="negative"
            :loading="transitioning"
            :disable="!rejectReason.trim()"
            @click="confirmReject"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuasar } from 'quasar';
import { BACKEND_URL, getFileUrl } from 'src/lib/api/client';
import { getProjectForProposal, type Project } from 'src/lib/api/projects';
import { useProposalsStore } from 'stores/proposals';
import { useDecisionPlansStore } from 'stores/decisionPlans';
import type { GovernanceAction, CompleteActionRequest } from 'src/lib/api/decisionPlans';
import { transitionDecisionPlan } from 'src/lib/api/decisionPlans';
import type { Proposal } from 'src/lib/api/proposals';
import type { NewGovernanceAction } from 'src/components/proposals/AddGovernanceActionDialog.vue';
import DecisionPlanView from 'src/components/proposals/DecisionPlanView.vue';
import EndorseProposalModal from 'src/components/proposals/EndorseProposalModal.vue';
import ProposalHistoryModal from 'src/components/proposals/ProposalHistoryModal.vue';
import CreateProposalDialog from 'src/components/proposals/CreateProposalDialog.vue';
import AddGovernanceActionDialog from 'src/components/proposals/AddGovernanceActionDialog.vue';
import GovernanceActionModal from 'src/components/proposals/GovernanceActionModal.vue';
import { useIdentityStore } from 'stores/identity';
import { useBackendEvents } from 'src/composables/useBackendEvents';

// ── Router / store setup ──────────────────────────────────────────────────────

const route = useRoute();
const router = useRouter();
const $q = useQuasar();
const proposalsStore = useProposalsStore();
const decisionPlansStore = useDecisionPlansStore();
const identityStore = useIdentityStore();
const isAdmin = computed(() => identityStore.isAdmin);
const isSteward = computed(() => identityStore.isSteward);
const { lastEvent } = useBackendEvents();

// ── Real-time updates ─────────────────────────────────────────────────────────

watch(lastEvent, (event) => {
  if (!event || !proposal.value) return;
  const refreshEvents = [
    'proposal:status_changed',
    'proposal:endorsed',
    'proposal:updated',
    'proposal:created',
    'proposal:comment_added',
    'proposal:approved',
    'proposal:rejected',
    'proposal_updated',
    'decision_plan_updated',
    'decision_plan:submitted',
    'decision_plan:signed_off',
    'governance_action_updated',
    'governance_action:completed',
  ];
  if (refreshEvents.includes(event.type)) {
    void proposalsStore.fetchProposal(route.params.id as string);
    void proposalsStore.fetchEndorsements(route.params.id as string);
    // Refetch comments on events that synthesize chat entries (endorsements, vote/completion comments)
    if (
      [
        'proposal:comment_added',
        'proposal:endorsed',
        'governance_action_updated',
        'governance_action:completed',
      ].includes(event.type)
    ) {
      void proposalsStore.fetchComments(route.params.id as string);
    }
    if (['decision_plan_updated', 'governance_action_updated', 'decision_plan:submitted', 'decision_plan:signed_off', 'governance_action:completed'].includes(event.type)) {
      void decisionPlansStore.fetchForProposal(route.params.id as string);
    }
  }
});

// ── Local state ───────────────────────────────────────────────────────────────

const transitioning = ref(false);
const endorsing = ref(false);
const creatingProject = ref(false);
const linkedProject = ref<Project | null>(null);

const showEndorseModal = ref(false);
const showHistory = ref(false);
const showEditDialog = ref(false);
const showAddGovernanceAction = ref(false);
const showGovernanceAction = ref(false);
const showRejectDialog = ref(false);

const rejectReason = ref('');
const newComment = ref('');
const selectedAction = ref<GovernanceAction | null>(null);

// ── Derived state ─────────────────────────────────────────────────────────────

const proposal = computed(() => proposalsStore.currentProposal);

const endorsementProgress = computed(() => {
  const threshold = proposal.value?.endorsement_threshold || 2;
  return (proposalsStore.endorsements.length / threshold) * 100;
});

const showRoleAssignments = computed(() => {
  const s = proposal.value?.status;
  return s === 'in_review' || s === 'signed_off' || s === 'voting_process';
});

const isProposalLead = computed(() => {
  const p = proposal.value;
  if (!p?.proposal_lead_id) return false;
  const aid = identityStore.currentAID;
  if (!aid) return false;
  return p.proposal_lead_id === aid.prefix;
});

const isProposalSteward = computed(() => {
  const p = proposal.value;
  if (!p?.proposal_steward_id) return false;
  const aid = identityStore.currentAID;
  if (!aid) return false;
  return p.proposal_steward_id === aid.prefix;
});

const canManageDecisionPlan = computed(() =>
  isAdmin.value || isSteward.value || isProposalLead.value,
);

const isProposer = computed(() => {
  const p = proposal.value;
  if (!p) return false;
  const aid = identityStore.currentAID;
  if (!aid) return false;
  return p.proposer_id === aid.name || p.proposer_id === aid.prefix;
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────

// Map of AID prefix → SharedProfile.displayName, used to resolve admin/legacy
// comments where stored user_name is the prefix.
const memberNames = ref<Record<string, string>>({});

async function loadMemberNames() {
  try {
    const resp = await fetch(`${BACKEND_URL}/api/v1/profiles/SharedProfile`);
    if (!resp.ok) return;
    const data = (await resp.json()) as { profiles?: { id: string; data: Record<string, string> }[] };
    const map: Record<string, string> = {};
    for (const p of data.profiles ?? []) {
      const aid = p.data?.aid || p.id?.replace('SharedProfile-', '');
      if (aid && p.data?.displayName) map[aid] = p.data.displayName;
    }
    memberNames.value = map;
  } catch {
    /* keep previous map on error */
  }
}

onMounted(() => {
  const id = route.params.id as string;
  void loadProposal(id);
  void loadMemberNames();
});

watch(
  () => route.params.id,
  (newId) => {
    if (newId) void loadProposal(newId as string);
  },
);

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadProposal(id: string) {
  await proposalsStore.fetchProposal(id);
  if (proposalsStore.currentProposal) {
    void proposalsStore.fetchEndorsements(id);
    void proposalsStore.fetchHistory(id);
    void proposalsStore.fetchComments(id);
    void decisionPlansStore.fetchForProposal(id);
    if (proposalsStore.currentProposal.status === 'approved') {
      linkedProject.value = await getProjectForProposal(id);
    }
  }
}

// ── Formatters ────────────────────────────────────────────────────────────────

function commentDisplayName(c: { user_id: string; user_name: string }): string {
  return memberNames.value[c.user_id] || c.user_name || c.user_id;
}

function commentKindIcon(kind?: string): string {
  switch (kind) {
    case 'endorsement': return 'favorite';
    case 'completion': return 'check_circle';
    case 'vote': return 'how_to_vote';
    default: return 'person';
  }
}

function commentSubtitleClass(c: { kind?: string; outcome?: string }): string {
  if (c.kind === 'endorsement') return 'comment-subtitle--endorsement';
  if (c.kind === 'completion') return 'comment-subtitle--completion';
  if (c.kind === 'vote') {
    if (c.outcome === 'approved' || c.outcome === 'no_veto') return 'comment-subtitle--vote-positive';
    return 'comment-subtitle--vote-negative';
  }
  return '';
}

function formatStatus(status: string) {
  return status.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
}

// ── Status transitions ────────────────────────────────────────────────────────

async function submitForEndorsement() {
  if (!proposal.value) return;
  transitioning.value = true;
  try {
    await proposalsStore.transition(proposal.value.id, 'submitted');
    $q.notify({ type: 'positive', message: 'Proposal submitted for endorsement!' });
  } catch {
    $q.notify({ type: 'negative', message: 'Failed to submit proposal' });
  } finally {
    transitioning.value = false;
  }
}

async function signOff() {
  if (!proposal.value) return;
  transitioning.value = true;
  try {
    await proposalsStore.transition(proposal.value.id, 'signed_off');
    $q.notify({ type: 'positive', message: 'Proposal signed off!' });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Sign off failed';
    $q.notify({ type: 'negative', message: msg });
  } finally {
    transitioning.value = false;
  }
}

async function confirmReject() {
  if (!proposal.value || !rejectReason.value.trim()) return;
  transitioning.value = true;
  try {
    const response = await fetch(
      `${BACKEND_URL}/api/v1/proposals/${proposal.value.id}/transition`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(identityStore.currentAID?.prefix ? { 'X-User-AID': identityStore.currentAID.prefix } : {}),
        },
        body: JSON.stringify({ status: 'rejected', reason: rejectReason.value.trim() }),
      },
    );
    if (!response.ok) throw new Error('Rejection failed');
    // Refresh the proposal from store so currentProposal is updated reactively
    await proposalsStore.fetchProposal(proposal.value.id);
    showRejectDialog.value = false;
    rejectReason.value = '';
    $q.notify({ type: 'info', message: 'Proposal rejected' });
  } catch {
    $q.notify({ type: 'negative', message: 'Rejection failed' });
  } finally {
    transitioning.value = false;
  }
}

// ── Endorsements ──────────────────────────────────────────────────────────────

async function confirmEndorse(comment: string) {
  if (!proposal.value) return;
  endorsing.value = true;
  try {
    const result = await proposalsStore.endorse(proposal.value.id, {
      endorser_id: identityStore.currentAID?.name || identityStore.currentAID?.prefix || 'unknown',
      endorsed_at: new Date().toISOString(),
      comment: comment || undefined,
    });
    showEndorseModal.value = false;
    if (result?.threshold_met) {
      $q.notify({
        type: 'positive',
        message: 'Endorsement threshold met! Proposal moved to In Review.',
      });
      await loadProposal(proposal.value.id);
    } else {
      $q.notify({ type: 'positive', message: 'Proposal endorsed!' });
      await Promise.all([
        proposalsStore.fetchEndorsements(proposal.value.id),
        proposalsStore.fetchComments(proposal.value.id),
      ]);
    }
  } catch {
    $q.notify({ type: 'negative', message: 'Endorsement failed' });
  } finally {
    endorsing.value = false;
  }
}

function copyLink() {
  if (!proposal.value) return;
  const link = `${window.location.origin}/dashboard/proposals/${proposal.value.id}`;
  navigator.clipboard.writeText(link).catch(() => undefined);
  $q.notify({ type: 'positive', message: 'Proposal link copied!' });
}

// ── Role claims ───────────────────────────────────────────────────────────────

async function claimRole(role: 'lead' | 'steward') {
  if (!proposal.value) return;
  try {
    const userId = identityStore.currentAID?.name || identityStore.currentAID?.prefix || 'unknown';
    const fields =
      role === 'lead'
        ? { proposal_lead_id: userId }
        : { proposal_steward_id: userId };
    await proposalsStore.update(proposal.value.id, fields);
    $q.notify({
      type: 'positive',
      message: `You have been assigned as Proposal ${role === 'lead' ? 'Lead' : 'Steward'}`,
    });
  } catch {
    $q.notify({ type: 'negative', message: 'Failed to claim role' });
  }
}

// ── Edit proposal ─────────────────────────────────────────────────────────────

async function handleEditSubmit(form: Partial<Omit<Proposal, 'id' | 'status' | 'created_at' | 'updated_at'>>) {
  if (!proposal.value) return;
  try {
    await proposalsStore.update(proposal.value.id, form);
    showEditDialog.value = false;
    $q.notify({ type: 'positive', message: 'Proposal updated!' });
  } catch {
    $q.notify({ type: 'negative', message: 'Update failed' });
  }
}

// ── Decision plan ─────────────────────────────────────────────────────────────

async function submitDecisionPlanForReview() {
  if (!decisionPlansStore.currentPlan) return;
  try {
    await decisionPlansStore.transition(decisionPlansStore.currentPlan.id, 'submitted');
    $q.notify({ type: 'positive', message: 'Decision plan submitted for review!' });
  } catch {
    $q.notify({ type: 'negative', message: 'Failed to submit for review' });
  }
}

async function signOffDecisionPlan() {
  if (!decisionPlansStore.currentPlan) return;
  try {
    await decisionPlansStore.transition(decisionPlansStore.currentPlan.id, 'signed_off');
    $q.notify({ type: 'positive', message: 'Decision plan signed off!' });
    if (proposal.value) await loadProposal(proposal.value.id);
  } catch {
    $q.notify({ type: 'negative', message: 'Failed to sign off decision plan' });
  }
}

// ── Governance actions ────────────────────────────────────────────────────────

async function handleAddGovernanceAction(action: NewGovernanceAction) {
  if (!proposal.value) return;
  try {
    let planId = decisionPlansStore.currentPlan?.id;

    // Auto-create a decision plan if one does not yet exist
    if (!planId) {
      const plan = await decisionPlansStore.create({
        proposal_id: proposal.value.id,
        title: `Decision Plan for ${proposal.value.title}`,
        description: 'Governance decision plan',
        proposal_lead_id: proposal.value.proposal_lead_id ?? '',
        proposal_steward_id: proposal.value.proposal_steward_id ?? '',
      });
      planId = plan.id;
    }

    await decisionPlansStore.addAction(planId, action);

    // If plan was signed off, revert to submitted so it goes through review again
    if (decisionPlansStore.currentPlan?.status === 'signed_off') {
      await transitionDecisionPlan(planId, 'submitted');
      await decisionPlansStore.fetchForProposal(proposal.value.id);
    }

    showAddGovernanceAction.value = false;
    $q.notify({ type: 'positive', message: 'Governance action added!' });
  } catch {
    $q.notify({ type: 'negative', message: 'Failed to add governance action' });
  }
}

function openGovernanceAction(actionId: string) {
  const actions = decisionPlansStore.currentPlan?.governance_actions ?? [];
  selectedAction.value = actions.find((a) => a.id === actionId) ?? null;
  if (selectedAction.value) showGovernanceAction.value = true;
}

async function handleCompleteAction(actionId: string, data: { outcome?: string; completion_notes: string; completion_files?: unknown[]; completion_links?: string[] }) {
  try {
    await decisionPlansStore.completeAction(actionId, {
      outcome: data.outcome,
      completion_notes: data.completion_notes,
      completion_files: data.completion_files as CompleteActionRequest['completion_files'],
      completion_links: data.completion_links,
      voter_name: identityStore.currentAID?.name || identityStore.currentAID?.prefix || 'unknown',
    });
    showGovernanceAction.value = false;
    selectedAction.value = null;
    $q.notify({ type: 'positive', message: 'Action completed!' });
    // Re-fetch both proposal and decision plan to get updated action statuses
    if (proposal.value) {
      await Promise.all([
        loadProposal(proposal.value.id),
        decisionPlansStore.fetchForProposal(proposal.value.id),
      ]);
    }
  } catch {
    $q.notify({ type: 'negative', message: 'Failed to complete action' });
  }
}

async function handleArchiveAction(actionId: string, data: { completion_notes: string; completion_files?: unknown[]; completion_links?: string[] }) {
  try {
    await decisionPlansStore.archiveAction(actionId, {
      completion_notes: data.completion_notes,
      completion_files: data.completion_files as CompleteActionRequest['completion_files'],
      completion_links: data.completion_links,
    });
    showGovernanceAction.value = false;
    selectedAction.value = null;
    $q.notify({ type: 'positive', message: 'Action archived!' });
    if (proposal.value) {
      await decisionPlansStore.fetchForProposal(proposal.value.id);
    }
  } catch {
    $q.notify({ type: 'negative', message: 'Failed to archive action' });
  }
}

async function handleCastVote(actionId: string, decision: string, comment: string) {
  try {
    const voterName = identityStore.currentAID?.name || identityStore.currentAID?.prefix || 'unknown';
    await decisionPlansStore.vote(actionId, decision, comment, voterName);
    $q.notify({ type: 'positive', message: 'Vote cast!' });
    // Re-fetch to update action state (don't close modal — user may want to see results)
    if (proposal.value) {
      await Promise.all([
        decisionPlansStore.fetchForProposal(proposal.value.id),
        proposalsStore.fetchComments(proposal.value.id),
      ]);
      // Update selectedAction with fresh data
      const actions = decisionPlansStore.currentPlan?.governance_actions ?? [];
      selectedAction.value = actions.find((a) => a.id === actionId) ?? null;
    }
  } catch (e) {
    $q.notify({ type: 'negative', message: e instanceof Error ? e.message : 'Failed to cast vote' });
  }
}

async function handleResolveDecision(actionId: string) {
  try {
    await decisionPlansStore.resolve(actionId);
    $q.notify({ type: 'positive', message: 'Voting closed — decision resolved!' });
    if (proposal.value) {
      await Promise.all([
        loadProposal(proposal.value.id),
        decisionPlansStore.fetchForProposal(proposal.value.id),
      ]);
    }
    showGovernanceAction.value = false;
    selectedAction.value = null;
  } catch (e) {
    $q.notify({ type: 'negative', message: e instanceof Error ? e.message : 'Failed to resolve decision' });
  }
}

// ── Project creation ──────────────────────────────────────────────────────────

async function createProject() {
  if (!proposal.value) return;
  creatingProject.value = true;
  try {
    const response = await fetch(`${BACKEND_URL}/api/v1/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: proposal.value.title,
        description: proposal.value.description,
        created_by: 'current-user',
      }),
    });
    if (!response.ok) throw new Error('Failed to create project');
    const project = (await response.json()) as { id: string };
    await fetch(`${BACKEND_URL}/api/v1/projects/${project.id}/link-proposal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposal_id: proposal.value.id }),
    });
    $q.notify({ type: 'positive', message: 'Project created from proposal!' });
    void router.push({ name: 'projects' });
  } catch {
    $q.notify({ type: 'negative', message: 'Failed to create project' });
  } finally {
    creatingProject.value = false;
  }
}

// ── Discussion ────────────────────────────────────────────────────────────────

async function addComment() {
  if (!newComment.value.trim() || !proposal.value) return;
  const userId = identityStore.currentAID?.prefix || 'unknown';
  const userName = identityStore.currentAID?.name || identityStore.currentAID?.prefix || 'unknown';
  try {
    await proposalsStore.addComment(proposal.value.id, userId, userName, newComment.value.trim());
    newComment.value = '';
    $q.notify({ type: 'positive', message: 'Comment added!' });
  } catch {
    $q.notify({ type: 'negative', message: 'Failed to add comment' });
  }
}
</script>

<style scoped lang="scss">
.proposal-detail-page {
  padding: 24px;
  max-width: 900px;
  margin: 0 auto;
}

.action-btn-rounded {
  border-radius: 10px;
}

// ── Loading / empty states ────────────────────────────────────────────────────

.loading-state,
.empty-state {
  text-align: center;
  padding: 60px 20px;
  color: var(--matou-muted-foreground);
}

// ── Header ────────────────────────────────────────────────────────────────────

.detail-header {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--matou-border);
  margin-bottom: 24px;
}

.detail-header-content {
  flex: 1;
  min-width: 0;
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

.lead-badge {
  font-size: 0.75rem;
  padding: 3px 10px;
  border-radius: 12px;
  background: #dbeafe;
  color: #2563eb;
}

.detail-title {
  font-size: 1.8rem;
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

.history-btn {
  flex-shrink: 0;
}

// ── Content layout ────────────────────────────────────────────────────────────

.detail-content {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

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

// ── Roles card ────────────────────────────────────────────────────────────────

.roles-card {
  background: var(--matou-card);
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius);
  padding: 16px;
}

.review-info-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px;
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  border-radius: var(--matou-radius-sm);
  color: var(--matou-foreground);
  font-size: 0.9rem;
}

.roles-notice {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 12px;
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  border-radius: var(--matou-radius-sm);
}

.role-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  background: var(--matou-secondary);
  border-radius: var(--matou-radius-sm);
  margin-bottom: 8px;

  &:last-child {
    margin-bottom: 0;
  }
}

.role-info {
  flex: 1;
  min-width: 0;
}

.role-assigned {
  font-size: 0.85rem;
  padding: 4px 12px;
  border-radius: 12px;
  background: #dbeafe;
  color: #2563eb;
  font-weight: 500;
  flex-shrink: 0;
}

.role-unassigned {
  font-size: 0.85rem;
  padding: 4px 12px;
  border-radius: 12px;
  background: #f3f4f6;
  color: #9ca3af;
  flex-shrink: 0;
}

// ── Content sections ──────────────────────────────────────────────────────────

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

.content-section {
  background: var(--matou-card);
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius);
  padding: 16px 20px;
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

    &:last-child {
      margin-bottom: 0;
    }
  }
}

.flex-shrink-0 {
  flex-shrink: 0;
  margin-top: 2px;
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
  transition: background 0.15s ease;

  &:last-child {
    margin-bottom: 0;
  }

  &:hover {
    background: var(--matou-muted);
  }
}

// ── Discussion ────────────────────────────────────────────────────────────────

.empty-discussion {
  text-align: center;
  padding: 20px;
  background: var(--matou-secondary);
  border-radius: var(--matou-radius-sm);
  color: var(--matou-muted-foreground);
  font-size: 0.9rem;
  margin-bottom: 12px;
}

.comments-list {
  margin-bottom: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.comment-row {
  display: flex;
  justify-content: flex-start;

  &--mine {
    justify-content: flex-end;
  }
}

.comment-card {
  background: var(--matou-secondary);
  border: 1px solid var(--matou-border);
  border-radius: 12px 12px 12px 4px;
  padding: 12px;
  max-width: 80%;

  &--mine {
    background: var(--matou-primary-light, rgba(37, 99, 235, 0.08));
    border-color: rgba(37, 99, 235, 0.15);
    border-radius: 12px 12px 4px 12px;
  }
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

.comment-card--mine .comment-avatar {
  background: rgba(37, 99, 235, 0.15);
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

.comment-input-row {
  display: flex;
  gap: 8px;
  align-items: flex-end;
  margin-top: 12px;
}

// ── Synthesized comment kinds ────────────────────────────────────────────────

.comment-card--endorsement {
  border-left: 3px solid #ec4899;
}
.comment-card--completion {
  border-left: 3px solid #059669;
}
.comment-card--vote {
  border-left: 3px solid #2563eb;
}

.comment-subtitle {
  font-size: 0.72rem;
  font-weight: 600;
  padding: 1px 8px;
  border-radius: 10px;
  background: var(--matou-muted);
  color: var(--matou-muted-foreground);

  &--endorsement {
    background: #fce7f3;
    color: #be185d;
  }
  &--completion {
    background: #d1fae5;
    color: #047857;
  }
  &--vote-positive {
    background: #d1fae5;
    color: #047857;
  }
  &--vote-negative {
    background: #fee2e2;
    color: #b91c1c;
  }
}

.comment-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.comment-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 8px;
  background: var(--matou-card);
  border: 1px solid var(--matou-border);
  font-size: 0.75rem;
  color: var(--matou-foreground);
  text-decoration: none;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;

  &:hover {
    background: var(--matou-muted);
  }

  span {
    overflow: hidden;
    text-overflow: ellipsis;
  }
}
</style>
