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

      <!-- Use ContributionDetailBody inline so the page matches the dialog layout -->
      <ContributionDetailBody
        inline
        :contribution="contribution"
        :user-role="currentUserRole"
        :current-user-id="currentUserId"
        :all-contributions="(store.contributions as Contribution[])"
        :is-plan-signed-off="isPlanSignedOff"
        :can-archive="canEditContribution"
        @edit-contribution="showEditDialog = true"
      />
    </template>

    <!-- Not found -->
    <div v-else class="empty-state">
      <h3>Contribution not found</h3>
      <q-btn flat no-caps label="Back to Contributions" @click="router.push({ name: 'contributions' })" />
    </div>

    <!-- Edit dialog (same form as Create) -->
    <!-- eslint-disable-next-line @typescript-eslint/no-explicit-any -->
    <CreateContributionDialog
      v-model="showEditDialog"
      :project-id="contribution?.project_id ?? ''"
      :milestone-id="contribution?.milestone_id"
      :editing="true"
      :contribution="(contribution as any)"
      :can-reassign="isKeriAdmin || isProjectLead || isProjectSteward"
      @update="handleEditSubmit"
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
          <!-- Evidence URLs -->
          <div class="q-mb-md">
            <div class="text-caption q-mb-xs">Evidence URLs</div>
            <div v-for="(url, idx) in evidenceUrls" :key="idx" class="row items-center q-mb-xs">
              <q-icon name="link" size="18px" class="q-mr-sm" />
              <span class="col text-body2" style="word-break: break-all;">{{ url }}</span>
              <q-btn flat round dense icon="close" size="sm" @click="evidenceUrls.splice(idx, 1)" />
            </div>
            <div class="row items-center q-gutter-sm">
              <q-input
                v-model="newEvidenceUrl"
                dense
                outlined
                placeholder="https://github.com/..."
                class="col"
                @keyup.enter="if (newEvidenceUrl.trim()) { evidenceUrls.push(newEvidenceUrl.trim()); newEvidenceUrl = ''; }"
              />
              <q-btn
                flat dense icon="add"
                :disable="!newEvidenceUrl.trim()"
                @click="evidenceUrls.push(newEvidenceUrl.trim()); newEvidenceUrl = '';"
              />
            </div>
          </div>
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
            <div class="text-subtitle2 q-mb-sm">Quality</div>
            <div class="star-rating">
              <q-icon
                v-for="i in 10"
                :key="i"
                :name="i <= reviewRating ? 'star' : 'star_border'"
                :color="i <= reviewRating ? 'amber' : 'grey-4'"
                size="24px"
                class="star-icon"
                @click="reviewRating = i"
              />
              <span class="rating-label">{{ reviewRating }} / 10</span>
            </div>
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
import { useProjectsStore } from 'stores/projects';
import type { CreateContributionRequest, UpdateContributionRequest } from 'src/lib/api/contributions';
import type { Contribution } from 'src/types/projects';
import ContributionDetailBody from 'src/components/contributions/ContributionDetailBody.vue';
import CreateContributionDialog from 'src/components/projects/CreateContributionDialog.vue';
import { useContributionWorkflow } from 'src/composables/useContributionWorkflow';
const route = useRoute();
const router = useRouter();
const $q = useQuasar();
const store = useContributionsStore();
const identityStore = useIdentityStore();
const projectsStore = useProjectsStore();
const workflow = useContributionWorkflow();
const isKeriAdmin = computed(() => identityStore.isAdmin);

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
const evidenceUrls = ref<string[]>([]);
const newEvidenceUrl = ref('');
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
const currentUserRole = computed(() => {
  if (isKeriAdmin.value) return 'community_admin';
  if (isProjectLead.value) return 'project_lead';
  if (isProjectSteward.value) return 'project_steward';
  return 'member';
});

const isPlanSignedOff = computed(() => {
  const projectId = contribution.value?.project_id;
  if (!projectId) return false;
  return projectsStore.implementationPlans[projectId]?.signed_off ?? false;
});

const project = computed(() => {
  const projectId = contribution.value?.project_id;
  if (!projectId) return null;
  return projectsStore.projects.find((p) => p.id === projectId) ?? null;
});

const isProjectLead = computed(() => {
  const lead = project.value?.project_lead_id;
  return !!lead && lead === currentUserId.value;
});

const isProjectSteward = computed(() => {
  const steward = project.value?.project_steward_id;
  return !!steward && steward === currentUserId.value;
});

const canEditContribution = computed(() => {
  const c = contribution.value;
  if (!c) return false;
  if (TERMINAL_STATUSES.includes(c.status as string)) return false;
  return isKeriAdmin.value || isProjectLead.value || isProjectSteward.value;
});

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
  // Load projects so we can resolve project_lead_id for permission checks.
  if (projectsStore.projects.length === 0) void projectsStore.fetchProjects();
});

// When the contribution loads (or changes), fetch its parent project's plan
// so isPlanSignedOff resolves correctly for the assignment gating.
watch(
  () => contribution.value?.project_id,
  (pid) => {
    if (pid) void projectsStore.fetchImplementationPlan(pid);
  },
  { immediate: true },
);

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
      evidence_urls: evidenceUrls.value,
    });
    $q.notify({ type: 'positive', message: 'Submitted for review!' });
    showEvidenceDialog.value = false;
    evidenceNotes.value = '';
    evidenceHours.value = undefined;
    evidenceUrls.value = [];
    newEvidenceUrl.value = '';
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
  margin: 0 auto;
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

.star-rating {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-wrap: wrap;

  .star-icon { cursor: pointer; transition: color 0.1s; }
  .rating-label { margin-left: 0.5rem; font-size: 0.85rem; color: $grey-7; }
}

.outcome-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
