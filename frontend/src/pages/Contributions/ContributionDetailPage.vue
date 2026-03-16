<template>
  <div class="contribution-detail-page">
    <!-- Loading -->
    <div v-if="store.isLoading && !contribution" class="loading-state">
      <q-spinner-dots size="40px" color="primary" />
    </div>

    <template v-else-if="contribution">
      <!-- Back navigation -->
      <div class="detail-nav">
        <q-btn flat round icon="arrow_back" @click="router.push({ name: 'contributions' })" />
        <span class="breadcrumb">Contributions</span>
      </div>

      <!-- Use the full ContributionDetailDialog mounted inline (not as a dialog) -->
      <ContributionDetail :contribution="contribution">
        <!-- Status transition actions -->
        <template #actions>
          <!-- Confirm (admin/steward) -->
          <q-btn
            v-if="workflow.canConfirm(contribution, false, currentUserRole)"
            color="primary"
            no-caps
            icon="verified"
            label="Confirm"
            :loading="transitioning === 'confirm'"
            @click="handleConfirm"
          />

          <!-- Share (lead/steward/admin) -->
          <q-btn
            v-if="workflow.canShare(contribution, currentUserRole)"
            flat
            no-caps
            label="Share"
            color="primary"
            :loading="transitioning === 'share'"
            @click="showShareDialog = true"
          />

          <!-- Offer (lead/steward/admin) -->
          <q-btn
            v-if="workflow.canOffer(contribution, currentUserRole)"
            flat
            no-caps
            label="Offer"
            color="primary"
            :loading="transitioning === 'offer'"
            @click="showOfferDialog = true"
          />

          <!-- Register Interest (contributor/member on shared) -->
          <q-btn
            v-if="workflow.canRegisterInterest(contribution, currentUserRole, currentUserId)"
            outlined
            no-caps
            label="Register Interest"
            color="primary"
            :loading="transitioning === 'register'"
            @click="showInterestDialog = true"
          />

          <!-- Accept offer (offered-to user) -->
          <q-btn
            v-if="workflow.canAccept(contribution, currentUserId)"
            color="primary"
            no-caps
            label="Accept Offer"
            :loading="transitioning === 'accept'"
            @click="handleAccept"
          />

          <!-- Submit for review (assigned, no blocking children) -->
          <q-btn
            v-if="workflow.canSubmitEvidence(contribution, currentUserId, allChildrenSignedOff)"
            color="primary"
            no-caps
            label="Submit for Review"
            :loading="transitioning === 'submit-evidence'"
            @click="showEvidenceDialog = true"
          />

          <!-- Review (lead/admin on needs_review) -->
          <q-btn
            v-if="workflow.canReview(contribution, currentUserRole)"
            color="positive"
            no-caps
            label="Review"
            :loading="transitioning === 'review'"
            @click="showReviewDialog = true"
          />

          <!-- Sign off (steward/admin on approved) -->
          <q-btn
            v-if="workflow.canSignOff(contribution, currentUserRole)"
            color="positive"
            no-caps
            icon="check_circle"
            label="Sign Off"
            :loading="transitioning === 'sign-off'"
            @click="handleSignOff"
          />

          <!-- Edit -->
          <q-btn
            v-if="!TERMINAL_STATUSES.includes(contribution.status)"
            flat
            no-caps
            icon="edit"
            label="Edit"
            @click="showEditDialog = true"
          />
        </template>

        <!-- Evidence section -->
        <template #evidence>
          <div v-if="contribution.completion_notes" class="evidence-notes">
            <p>{{ contribution.completion_notes }}</p>
          </div>
          <div v-if="(contribution.evidence_urls?.length ?? 0) === 0 && !contribution.completion_notes" class="empty-evidence">
            No evidence submitted yet.
          </div>
          <div v-if="contribution.evidence_urls?.length" class="evidence-list">
            <div v-for="(url, i) in contribution.evidence_urls" :key="i" class="evidence-item">
              <q-icon name="link" size="16px" color="primary" />
              <a :href="url" target="_blank" class="evidence-link">{{ url }}</a>
            </div>
          </div>
        </template>

        <!-- Review feedback section -->
        <template #feedback>
          <div v-if="!contribution.review_feedback" class="empty-feedback">
            No review feedback yet.
          </div>
          <div v-else class="feedback-item">
            <div class="feedback-outcome" :class="contribution.review_outcome">
              {{ formatOutcome(contribution.review_outcome) }}
            </div>
            <p class="feedback-text">{{ contribution.review_feedback }}</p>
            <div v-if="contribution.quality_rating" class="quality-rating">
              Quality: {{ contribution.quality_rating }}/10
            </div>
          </div>
        </template>
      </ContributionDetail>
    </template>

    <!-- Not found -->
    <div v-else class="empty-state">
      <h3>Contribution not found</h3>
      <q-btn flat no-caps label="Back to Contributions" @click="router.push({ name: 'contributions' })" />
    </div>

    <!-- Edit dialog -->
    <ContributionForm
      v-model="showEditDialog"
      :contribution="contribution ?? undefined"
      @submit="handleEditSubmit"
    />

    <!-- Share dialog -->
    <q-dialog v-model="showShareDialog">
      <q-card style="min-width: 400px">
        <q-card-section class="row items-center q-pb-none">
          <div class="text-h6">Share Contribution</div>
          <q-space />
          <q-btn icon="close" flat round dense v-close-popup />
        </q-card-section>
        <q-card-section>
          <div class="text-body2 q-mb-md">Select roles that can see and register interest:</div>
          <q-checkbox v-for="role in shareRoleOptions" :key="role.value"
            v-model="shareRoles" :val="role.value" :label="role.label" class="q-mb-sm block" />
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat no-caps label="Cancel" v-close-popup />
          <q-btn no-caps color="primary" label="Share"
            :disable="shareRoles.length === 0"
            :loading="transitioning === 'share'"
            @click="handleShare" />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Offer dialog -->
    <q-dialog v-model="showOfferDialog">
      <q-card style="min-width: 420px">
        <q-card-section class="row items-center q-pb-none">
          <div class="text-h6">Offer Contribution</div>
          <q-space />
          <q-btn icon="close" flat round dense v-close-popup />
        </q-card-section>
        <q-card-section class="q-gutter-md">
          <q-input v-model="offerUserId" label="User ID *" outlined />
          <q-input v-model="offerUserName" label="User Name *" outlined />
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat no-caps label="Cancel" v-close-popup />
          <q-btn no-caps color="primary" label="Send Offer"
            :disable="!offerUserId.trim() || !offerUserName.trim()"
            :loading="transitioning === 'offer'"
            @click="handleOffer" />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Interest dialog -->
    <q-dialog v-model="showInterestDialog">
      <q-card style="min-width: 420px">
        <q-card-section class="row items-center q-pb-none">
          <div class="text-h6">Register Interest</div>
          <q-space />
          <q-btn icon="close" flat round dense v-close-popup />
        </q-card-section>
        <q-card-section>
          <q-input v-model="interestNote" label="Why are you interested?" type="textarea" outlined autogrow />
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat no-caps label="Cancel" v-close-popup />
          <q-btn no-caps color="primary" label="Register"
            :loading="transitioning === 'register'"
            @click="handleRegisterInterest" />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Evidence dialog -->
    <q-dialog v-model="showEvidenceDialog" persistent>
      <q-card style="min-width: 500px">
        <q-card-section class="row items-center q-pb-none">
          <div class="text-h6">Submit Evidence</div>
          <q-space />
          <q-btn icon="close" flat round dense v-close-popup />
        </q-card-section>
        <q-card-section class="q-gutter-md">
          <q-input v-model="evidenceNotes" label="Completion Notes *" type="textarea" outlined autogrow />
          <q-input v-model.number="evidenceHours" label="Actual Hours" type="number" outlined min="0" />
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat no-caps label="Cancel" v-close-popup />
          <q-btn no-caps color="primary" label="Submit for Review"
            :disable="!evidenceNotes.trim()"
            :loading="transitioning === 'submit-evidence'"
            @click="handleSubmitEvidence" />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Review dialog -->
    <q-dialog v-model="showReviewDialog" persistent>
      <q-card style="min-width: 500px">
        <q-card-section class="row items-center q-pb-none">
          <div class="text-h6">Review Contribution</div>
          <q-space />
          <q-btn icon="close" flat round dense v-close-popup />
        </q-card-section>
        <q-card-section class="q-gutter-md">
          <div>
            <div class="text-subtitle2 q-mb-sm">Decision *</div>
            <div class="outcome-row">
              <q-btn
                v-for="opt in outcomeOptions"
                :key="opt.value"
                :outline="reviewOutcome !== opt.value"
                :color="reviewOutcome === opt.value ? opt.color : 'grey'"
                no-caps
                :label="opt.label"
                @click="reviewOutcome = opt.value"
              />
            </div>
          </div>
          <div>
            <div class="text-subtitle2 q-mb-sm">Quality ({{ reviewRating }}/10)</div>
            <q-slider v-model="reviewRating" :min="1" :max="10" :step="1" color="primary" label />
          </div>
          <q-input v-model="reviewFeedback" label="Feedback" type="textarea" outlined autogrow />
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat no-caps label="Cancel" v-close-popup />
          <q-btn no-caps color="primary" label="Submit Review"
            :disable="!reviewOutcome"
            :loading="transitioning === 'review'"
            @click="handleReview" />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuasar } from 'quasar';
import { useContributionsStore } from 'stores/contributions';
import { useIdentityStore } from 'stores/identity';
import type { CreateContributionRequest, UpdateContributionRequest } from 'src/lib/api/contributions';
import type { Contribution } from 'src/types/projects';
import ContributionDetail from 'src/components/contributions/ContributionDetail.vue';
import ContributionForm from 'src/components/contributions/ContributionForm.vue';
import { useContributionWorkflow } from 'src/composables/useContributionWorkflow';

const route = useRoute();
const router = useRouter();
const $q = useQuasar();
const store = useContributionsStore();
const identityStore = useIdentityStore();
const workflow = useContributionWorkflow();

// ── Local state ───────────────────────────────────────────────────────────────

const transitioning = ref<string | null>(null);
const showEditDialog = ref(false);
const showShareDialog = ref(false);
const showOfferDialog = ref(false);
const showInterestDialog = ref(false);
const showEvidenceDialog = ref(false);
const showReviewDialog = ref(false);

// Form state
const shareRoles = ref<string[]>([]);
const offerUserId = ref('');
const offerUserName = ref('');
const interestNote = ref('');
const evidenceNotes = ref('');
const evidenceHours = ref<number | undefined>(undefined);
const reviewOutcome = ref<'approved' | 'incomplete' | 'declined' | ''>('');
const reviewRating = ref(5);
const reviewFeedback = ref('');

// Options
const shareRoleOptions = [
  { label: 'Contributors', value: 'contributor' },
  { label: 'Members', value: 'member' },
  { label: 'Project Leads', value: 'project_lead' },
];

const outcomeOptions = [
  { value: 'approved', label: 'Approve', color: 'positive' },
  { value: 'incomplete', label: 'Send Back', color: 'warning' },
  { value: 'declined', label: 'Decline', color: 'negative' },
] as const;

// ── Derived ───────────────────────────────────────────────────────────────────

const contribution = computed(() => store.currentContribution as Contribution | null);
const currentUserId = computed(() => identityStore.aidPrefix ?? '');
const currentUserRole = computed(() => 'member'); // Will come from identity/profile store

const TERMINAL_STATUSES = ['signed_off', 'rewarded', 'archived', 'declined', 'cancelled', 'rejected'];

// For evidence gating: check all children are in terminal states
const allChildrenSignedOff = computed(() => {
  const c = contribution.value;
  if (!c?.child_contributions?.length) return true;
  const childIds = c.child_contributions;
  const allContribs = store.contributions as Contribution[];
  return childIds.every((id) => {
    const child = allContribs.find((x) => x.id === id);
    return !child || ['signed_off', 'rewarded', 'archived'].includes(child.status as string);
  });
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────

onMounted(() => {
  void store.fetchContribution(route.params.id as string);
});

watch(
  () => route.params.id,
  (newId) => {
    if (newId) void store.fetchContribution(newId as string);
  },
);

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatOutcome(outcome?: string): string {
  const map: Record<string, string> = { approved: 'Approved', incomplete: 'Sent Back', declined: 'Declined' };
  return outcome ? (map[outcome] ?? outcome) : '';
}

// ── Workflow actions ───────────────────────────────────────────────────────────

async function handleConfirm() {
  if (!contribution.value) return;
  transitioning.value = 'confirm';
  try {
    await store.confirm(contribution.value.id);
    $q.notify({ type: 'positive', message: 'Contribution confirmed!' });
  } catch (e) {
    $q.notify({ type: 'negative', message: e instanceof Error ? e.message : 'Failed to confirm' });
  } finally {
    transitioning.value = null;
  }
}

async function handleShare() {
  if (!contribution.value) return;
  transitioning.value = 'share';
  try {
    await store.share(contribution.value.id, { shared_with_roles: shareRoles.value });
    $q.notify({ type: 'positive', message: 'Contribution shared successfully!' });
    showShareDialog.value = false;
    shareRoles.value = [];
  } catch (e) {
    $q.notify({ type: 'negative', message: e instanceof Error ? e.message : 'Failed to share' });
  } finally {
    transitioning.value = null;
  }
}

async function handleOffer() {
  if (!contribution.value) return;
  transitioning.value = 'offer';
  try {
    await store.offer(contribution.value.id, {
      offered_to: offerUserId.value,
      offered_to_name: offerUserName.value,
    });
    $q.notify({ type: 'positive', message: `Contribution offered to ${offerUserName.value}` });
    showOfferDialog.value = false;
    offerUserId.value = '';
    offerUserName.value = '';
  } catch (e) {
    $q.notify({ type: 'negative', message: e instanceof Error ? e.message : 'Failed to offer' });
  } finally {
    transitioning.value = null;
  }
}

async function handleAccept() {
  if (!contribution.value) return;
  transitioning.value = 'accept';
  try {
    await store.acceptOffer(contribution.value.id);
    $q.notify({ type: 'positive', message: 'Contribution accepted!' });
  } catch (e) {
    $q.notify({ type: 'negative', message: e instanceof Error ? e.message : 'Failed to accept' });
  } finally {
    transitioning.value = null;
  }
}

async function handleRegisterInterest() {
  if (!contribution.value) return;
  transitioning.value = 'register';
  try {
    await store.registerInterest(contribution.value.id, { interest_note: interestNote.value.trim() });
    $q.notify({ type: 'positive', message: 'Interest registered successfully!' });
    showInterestDialog.value = false;
    interestNote.value = '';
  } catch (e) {
    $q.notify({ type: 'negative', message: e instanceof Error ? e.message : 'Failed to register' });
  } finally {
    transitioning.value = null;
  }
}

async function handleSubmitEvidence() {
  if (!contribution.value || !evidenceNotes.value.trim()) return;
  transitioning.value = 'submit-evidence';
  try {
    await store.submitEvidence(contribution.value.id, {
      completion_notes: evidenceNotes.value.trim(),
      actual_duration: evidenceHours.value,
    });
    $q.notify({ type: 'positive', message: 'Submitted for review!' });
    showEvidenceDialog.value = false;
    evidenceNotes.value = '';
    evidenceHours.value = undefined;
  } catch (e) {
    $q.notify({ type: 'negative', message: e instanceof Error ? e.message : 'Submission failed' });
  } finally {
    transitioning.value = null;
  }
}

async function handleReview() {
  if (!contribution.value || !reviewOutcome.value) return;
  transitioning.value = 'review';
  try {
    await store.review(contribution.value.id, {
      outcome: reviewOutcome.value as 'approved' | 'incomplete' | 'declined',
      feedback: reviewFeedback.value.trim() || undefined,
      quality_rating: reviewRating.value,
    });
    $q.notify({ type: 'positive', message: 'Review submitted!' });
    showReviewDialog.value = false;
    reviewOutcome.value = '';
    reviewFeedback.value = '';
  } catch (e) {
    $q.notify({ type: 'negative', message: e instanceof Error ? e.message : 'Review failed' });
  } finally {
    transitioning.value = null;
  }
}

async function handleSignOff() {
  if (!contribution.value) return;
  transitioning.value = 'sign-off';
  try {
    await store.signOff(contribution.value.id);
    $q.notify({ type: 'positive', message: 'Contribution signed off! Treasury action will be generated.' });
  } catch (e) {
    $q.notify({ type: 'negative', message: e instanceof Error ? e.message : 'Sign off failed' });
  } finally {
    transitioning.value = null;
  }
}

async function handleEditSubmit(form: CreateContributionRequest | UpdateContributionRequest) {
  if (!contribution.value) return;
  try {
    await store.update(contribution.value.id, form as UpdateContributionRequest);
    showEditDialog.value = false;
    $q.notify({ type: 'positive', message: 'Contribution updated!' });
  } catch {
    $q.notify({ type: 'negative', message: 'Update failed' });
  }
}
</script>

<style scoped lang="scss">
.contribution-detail-page {
  padding: 24px;
  max-width: 900px;
}

.loading-state,
.empty-state {
  text-align: center;
  padding: 60px 20px;
  color: var(--matou-muted-foreground);
}

.detail-nav {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 20px;
}

.breadcrumb {
  font-size: 0.9rem;
  color: var(--matou-muted-foreground);
}

// Evidence
.evidence-notes {
  padding: 10px 12px;
  background: var(--matou-secondary);
  border-radius: var(--matou-radius-sm);
  font-size: 0.875rem;
  color: var(--matou-foreground);
  white-space: pre-wrap;
  margin-bottom: 10px;
}

.empty-evidence,
.empty-feedback {
  padding: 12px;
  background: var(--matou-secondary);
  border-radius: var(--matou-radius-sm);
  color: var(--matou-muted-foreground);
  font-size: 0.875rem;
}

.evidence-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.evidence-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--matou-secondary);
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius-sm);
}

.evidence-link {
  color: var(--matou-primary);
  text-decoration: none;
  font-size: 0.875rem;
  word-break: break-all;
  &:hover { text-decoration: underline; }
}

// Feedback
.feedback-item {
  padding: 12px;
  background: var(--matou-secondary);
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius-sm);
}

.feedback-outcome {
  display: inline-block;
  font-size: 0.8rem;
  font-weight: 600;
  padding: 3px 10px;
  border-radius: 12px;
  margin-bottom: 8px;

  &.approved { background: rgba(74, 157, 156, 0.12); color: var(--matou-accent); }
  &.incomplete { background: rgba(30, 95, 116, 0.1); color: var(--matou-primary); }
  &.declined { background: rgba(200, 70, 58, 0.1); color: var(--matou-destructive); }
}

.feedback-text {
  font-size: 0.875rem;
  color: var(--matou-muted-foreground);
  margin: 0 0 6px;
  line-height: 1.5;
}

.quality-rating {
  font-size: 0.78rem;
  color: var(--matou-muted-foreground);
}

.outcome-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
