<template>
  <q-dialog
    :model-value="modelValue"
    @update:model-value="$emit('update:modelValue', $event)"
    maximized
  >
    <q-card class="detail-dialog">
      <!-- Sticky header -->
      <div class="dialog-sticky-header">
        <div class="header-badges">
          <ContributionStatusBadge :status="contribution.status" />
          <ContributionTypeBadge :type="contribution.contribution_type" />
          <ContributionPriorityBadge :priority="contribution.priority" />
        </div>
        <h2 class="header-title">{{ contribution.title }}</h2>
        <div class="header-meta">
          Created by {{ contribution.created_by }}
          <span v-if="contribution.created_at">
            &middot; {{ formatDate(contribution.created_at) }}
          </span>
          <span v-if="assignedName">
            &middot; Assigned to {{ assignedName }}
          </span>
        </div>
        <q-btn
          icon="close"
          flat
          round
          dense
          class="close-btn"
          v-close-popup
        />
      </div>

      <!-- Scrollable body -->
      <div class="dialog-body">

        <!-- ── Status panels ─────────────────────────────── -->

        <!-- Offered panel -->
        <div v-if="contribution.status === 'offered'" class="status-panel offered-panel">
          <Send class="panel-icon" />
          <div>
            <div class="panel-title">Offered to {{ contribution.offered_to_name ?? contribution.offered_to }}</div>
            <div v-if="contribution.offered_at" class="panel-sub">
              Offered {{ formatDate(contribution.offered_at) }}
            </div>
          </div>
          <q-btn
            v-if="canAcceptOffer"
            no-caps
            color="primary"
            label="Accept"
            class="q-ml-auto"
            :loading="actionLoading === 'accept'"
            @click="handleAccept"
          />
        </div>

        <!-- Shared panel -->
        <div v-if="contribution.is_shared && contribution.status === 'shared'" class="status-panel shared-panel">
          <Share2 class="panel-icon" />
          <div>
            <div class="panel-title">Shared with community</div>
            <div v-if="contribution.shared_with_roles?.length" class="panel-sub">
              Roles: {{ contribution.shared_with_roles.join(', ') }}
            </div>
          </div>
          <q-btn
            v-if="canRegister"
            no-caps
            outlined
            label="Register Interest"
            class="q-ml-auto"
            :loading="actionLoading === 'register'"
            @click="showInterestDialog = true"
          />
        </div>

        <!-- Interested contributors -->
        <div
          v-if="contribution.interested_contributors?.length && (isSteward || isLead)"
          class="content-section"
        >
          <h3 class="section-title">
            <UserCheck class="section-icon" />
            Interested Contributors ({{ contribution.interested_contributors.length }})
          </h3>
          <div class="interested-list">
            <div
              v-for="ic in contribution.interested_contributors"
              :key="ic.user_id"
              class="interested-item"
            >
              <div class="interested-avatar">{{ ic.user_name.charAt(0).toUpperCase() }}</div>
              <div class="interested-info">
                <div class="interested-name">{{ ic.user_name }}</div>
                <div v-if="ic.interest_note" class="interested-note">{{ ic.interest_note }}</div>
                <div class="interested-date">{{ formatDate(ic.registered_at) }}</div>
              </div>
              <q-btn
                v-if="canOfferToContributor"
                flat
                dense
                no-caps
                size="sm"
                label="Offer"
                color="primary"
                :loading="actionLoading === `offer-${ic.user_id}`"
                @click="handleOfferToContributor(ic)"
              />
            </div>
          </div>
        </div>

        <!-- Description -->
        <div class="content-section">
          <h3 class="section-title">Description</h3>
          <p class="section-text">{{ contribution.description }}</p>
        </div>

        <!-- Objectives -->
        <div v-if="contribution.objectives?.length" class="content-section">
          <h3 class="section-title">Objectives</h3>
          <ul class="item-list">
            <li v-for="(obj, i) in contribution.objectives" :key="i">
              <CircleDot class="list-icon" />
              <span>{{ obj }}</span>
            </li>
          </ul>
        </div>

        <!-- Deliverables -->
        <div v-if="contribution.deliverables?.length" class="content-section">
          <h3 class="section-title">Deliverables</h3>
          <ul class="item-list">
            <li v-for="(d, i) in contribution.deliverables" :key="i">
              <CheckSquare class="list-icon" />
              <span>{{ d }}</span>
            </li>
          </ul>
        </div>

        <!-- Acceptance criteria -->
        <div v-if="contribution.acceptance_criteria?.length" class="content-section">
          <h3 class="section-title">Acceptance Criteria</h3>
          <ul class="item-list">
            <li v-for="(ac, i) in contribution.acceptance_criteria" :key="i">
              <CheckCircle class="list-icon accent-icon" />
              <span>{{ ac }}</span>
            </li>
          </ul>
        </div>

        <!-- Skill requirements -->
        <div v-if="contribution.skill_requirements?.length" class="content-section">
          <h3 class="section-title">Skill Requirements</h3>
          <div class="skill-chips">
            <q-chip
              v-for="(s, i) in contribution.skill_requirements"
              :key="i"
              dense
              color="blue-1"
              text-color="blue-8"
            >{{ s }}</q-chip>
          </div>
        </div>

        <!-- Stats grid -->
        <div class="stats-grid">
          <div v-if="contribution.estimated_hours" class="stat-card">
            <div class="stat-label">Estimated</div>
            <div class="stat-value">{{ contribution.estimated_hours }}h</div>
          </div>
          <div v-if="contribution.actual_hours || contribution.actual_duration" class="stat-card">
            <div class="stat-label">Actual</div>
            <div class="stat-value">{{ contribution.actual_hours ?? contribution.actual_duration }}h</div>
          </div>
          <div v-if="contribution.budget" class="stat-card">
            <div class="stat-label">Budget</div>
            <div class="stat-value">{{ contribution.budget }}</div>
          </div>
          <div v-if="contribution.deadline" class="stat-card">
            <div class="stat-label">Deadline</div>
            <div class="stat-value">{{ formatDate(contribution.deadline) }}</div>
          </div>
        </div>

        <!-- Sub-contributions section -->
        <div class="content-section">
          <div class="section-header">
            <h3 class="section-title">
              <GitBranch class="section-icon" />
              Sub-Contributions
              <span v-if="childContributions.length" class="count-chip">{{ childContributions.length }}</span>
            </h3>
            <q-btn
              v-if="canAddSub && !isPlanSignedOff"
              flat
              dense
              no-caps
              icon="add"
              label="Add Sub-Contribution"
              color="primary"
              size="sm"
              @click="$emit('create-child-contribution', contribution.id)"
            />
          </div>

          <div v-if="childContributions.length === 0" class="sub-empty">
            No sub-contributions yet. Break down this contribution into smaller tasks.
          </div>

          <div v-else class="sub-list">
            <div
              v-for="child in childContributions"
              :key="child.id"
              class="sub-item clickable"
              @click="selectedChildContribution = child"
            >
              <div class="sub-item-badges">
                <ContributionStatusBadge :status="child.status" />
              </div>
              <span class="sub-item-title">{{ child.title }}</span>
              <q-btn
                v-if="canApproveSub && child.status === 'created'"
                flat
                dense
                no-caps
                size="sm"
                label="Approve"
                color="primary"
                :loading="actionLoading === `approve-sub-${child.id}`"
                @click.stop="handleApproveSub(child.id)"
              />
            </div>
          </div>

          <!-- Blocking warning -->
          <div v-if="hasBlockingChildren" class="blocking-warning">
            <q-icon name="warning" color="warning" size="20px" />
            <div>
              <div class="blocking-title">Sub-Contributions Not Complete</div>
              <div class="blocking-text">All sub-contributions must be signed off before submission:</div>
              <ul class="blocking-list">
                <li v-for="child in blockingChildren" :key="child.id">
                  {{ child.title }} —
                  <ContributionStatusBadge :status="child.status" size="sm" />
                </li>
              </ul>
            </div>
          </div>
        </div>

        <!-- Evidence submission (assigned contributor, status=assigned/changed) -->
        <div v-if="canSubmitEvidenceNow" class="content-section">
          <h3 class="section-title">
            <Paperclip class="section-icon" />
            Submit Evidence
          </h3>

          <q-input
            v-model="evidenceForm.completion_notes"
            label="Completion Notes *"
            type="textarea"
            outlined
            autogrow
            class="q-mb-md"
          />

          <!-- Per-criterion acceptance responses -->
          <div v-if="contribution.acceptance_criteria?.length" class="evidence-criteria">
            <div class="section-label">Acceptance Criteria Responses</div>
            <div
              v-for="(criterion, idx) in contribution.acceptance_criteria"
              :key="idx"
              class="criterion-response"
            >
              <div class="criterion-text">
                <q-icon name="check_circle" size="16px" color="positive" />
                <span>{{ criterion }}</span>
              </div>
              <q-input
                v-model="evidenceForm.acceptance_notes[idx]"
                type="textarea"
                :rows="2"
                dense
                outlined
                placeholder="How was this criterion met?"
                class="criterion-input"
              />
            </div>
          </div>

          <!-- Evidence URLs -->
          <div class="evidence-urls">
            <div class="text-subtitle2 q-mb-sm">Evidence URLs</div>
            <div
              v-for="(url, i) in evidenceForm.evidence_urls"
              :key="i"
              class="list-row q-mb-sm"
            >
              <q-input
                v-model="evidenceForm.evidence_urls[i]"
                :label="`URL ${i + 1}`"
                outlined
                dense
                class="list-input"
                type="url"
              />
              <q-btn flat round icon="remove_circle_outline" color="negative" size="sm" @click="evidenceForm.evidence_urls.splice(i, 1)" />
            </div>
            <q-btn flat size="sm" icon="add" no-caps label="Add URL" color="primary" @click="evidenceForm.evidence_urls.push('')" />
          </div>

          <!-- Time Report Upload -->
          <div class="file-upload-section">
            <div class="section-label">Time Report</div>
            <div v-if="!evidenceForm.time_report_file" class="file-drop-zone">
              <q-icon name="upload_file" size="32px" color="grey-6" />
              <div class="file-drop-text">Upload time report (.pdf, .csv, .xlsx)</div>
              <q-btn outline size="sm" label="Choose File" @click="timeReportInput?.click()" />
              <input
                ref="timeReportInput"
                type="file"
                accept=".pdf,.csv,.xlsx"
                style="display: none"
                @change="(e: Event) => {
                  const f = (e.target as HTMLInputElement).files?.[0];
                  if (f) handleTimeReportUpload(f);
                }"
              />
            </div>
            <div v-else class="file-item">
              <q-icon name="description" size="20px" />
              <span class="file-name">{{ evidenceForm.time_report_file.name }}</span>
              <q-btn flat round dense icon="close" size="sm" @click="removeTimeReport" />
            </div>
          </div>

          <!-- Attachment Files Upload -->
          <div class="file-upload-section">
            <div class="section-label">Attachments</div>
            <div class="file-drop-zone">
              <q-icon name="attach_file" size="32px" color="grey-6" />
              <div class="file-drop-text">Upload screenshots, documents, or other files</div>
              <q-btn outline size="sm" label="Choose Files" @click="attachmentInput?.click()" />
              <input
                ref="attachmentInput"
                type="file"
                multiple
                style="display: none"
                @change="(e: Event) => {
                  const files = (e.target as HTMLInputElement).files;
                  if (files?.length) handleAttachmentUpload(files);
                }"
              />
            </div>
            <div v-for="(file, idx) in evidenceForm.attachment_files" :key="idx" class="file-item">
              <q-icon name="description" size="20px" />
              <span class="file-name">{{ file.name }}</span>
              <q-btn flat round dense icon="close" size="sm" @click="removeAttachment(idx)" />
            </div>
          </div>

          <q-input
            v-model.number="evidenceForm.actual_duration"
            label="Actual Hours"
            type="number"
            outlined
            min="0"
            class="q-mt-md"
          />

          <div class="q-mt-md">
            <q-btn
              no-caps
              color="primary"
              label="Submit for Review"
              :loading="actionLoading === 'submit-evidence'"
              :disable="!evidenceForm.completion_notes.trim()"
              @click="handleSubmitEvidence"
            />
          </div>
        </div>

        <!-- Existing evidence (read-only) -->
        <div
          v-else-if="hasEvidence"
          class="content-section"
        >
          <h3 class="section-title">
            <Paperclip class="section-icon" />
            Submitted Evidence
          </h3>
          <p v-if="contribution.completion_notes" class="section-text q-mb-sm">
            {{ contribution.completion_notes }}
          </p>
          <div v-if="contribution.evidence_urls?.length" class="evidence-url-list">
            <a
              v-for="(url, i) in contribution.evidence_urls"
              :key="i"
              :href="url"
              target="_blank"
              class="evidence-url-link"
            >
              <LinkIcon class="link-icon" />
              {{ url }}
            </a>
          </div>
        </div>

        <!-- Review form (lead/admin, status=needs_review) -->
        <div v-if="canReviewNow" class="content-section">
          <h3 class="section-title">
            <ClipboardCheck class="section-icon" />
            Review Submission
          </h3>

          <!-- Outcome -->
          <div class="outcome-group q-mb-md">
            <div class="text-subtitle2 q-mb-sm">Decision</div>
            <div class="outcome-btns">
              <button
                v-for="outcome in outcomeOptions"
                :key="outcome.value"
                class="outcome-btn"
                :class="[outcome.value, { active: reviewForm.outcome === outcome.value }]"
                @click="reviewForm.outcome = outcome.value"
                type="button"
              >
                <component :is="outcome.icon" class="outcome-icon" />
                {{ outcome.label }}
              </button>
            </div>
          </div>

          <!-- Quality rating (10 stars) -->
          <div class="q-mb-md">
            <div class="text-subtitle2 q-mb-sm">Quality Rating</div>
            <div class="star-row">
              <button
                v-for="star in 10"
                :key="star"
                class="star-btn"
                :class="{ filled: star <= reviewForm.quality_rating }"
                @click="reviewForm.quality_rating = star"
                type="button"
              >
                <Star class="star-icon" />
              </button>
              <span class="star-label">{{ reviewForm.quality_rating }}/10</span>
            </div>
          </div>

          <!-- Feedback -->
          <q-input
            v-model="reviewForm.feedback"
            label="Review Feedback"
            type="textarea"
            outlined
            autogrow
            class="q-mb-md"
          />

          <div>
            <q-btn
              no-caps
              color="primary"
              label="Submit Review"
              :loading="actionLoading === 'review'"
              :disable="!reviewForm.outcome"
              @click="handleSubmitReview"
            />
          </div>
        </div>

        <!-- Existing review (read-only) -->
        <div v-else-if="hasReview" class="content-section">
          <h3 class="section-title">
            <ClipboardCheck class="section-icon" />
            Review
          </h3>
          <div class="review-outcome-chip" :class="contribution.review_outcome">
            {{ formatOutcome(contribution.review_outcome) }}
          </div>
          <p v-if="contribution.review_feedback" class="section-text q-mt-sm">
            {{ contribution.review_feedback }}
          </p>
          <div v-if="contribution.quality_rating" class="q-mt-sm">
            <span class="text-caption">Quality: {{ contribution.quality_rating }}/10</span>
          </div>
        </div>

        <!-- Sign-off panel (steward/admin, status=approved) -->
        <div v-if="canSignOffNow" class="content-section sign-off-panel">
          <CheckCircle class="sign-off-icon" />
          <div>
            <div class="sign-off-title">Ready for Sign-Off</div>
            <div class="sign-off-sub">This contribution has been approved and is ready for sign-off.</div>
          </div>
          <q-btn
            no-caps
            color="positive"
            label="Sign Off"
            class="q-ml-auto"
            :loading="actionLoading === 'sign-off'"
            @click="handleSignOff"
          />
        </div>

        <!-- Signed-off confirmation -->
        <div v-if="contribution.status === 'signed_off'" class="content-section signed-off-panel">
          <Award class="sign-off-icon" />
          <div>
            <div class="sign-off-title">Signed Off</div>
            <div v-if="contribution.signed_off_by" class="sign-off-sub">
              by {{ contribution.signed_off_by }}
              <span v-if="contribution.signed_off_at">on {{ formatDate(contribution.signed_off_at) }}</span>
            </div>
          </div>
        </div>

      </div>

      <!-- Sticky footer actions -->
      <div class="dialog-sticky-footer">
        <div class="footer-actions">
          <q-btn
            v-if="canShareNow"
            flat
            no-caps
            label="Share"
            icon-right="share"
            color="primary"
            :loading="actionLoading === 'share'"
            @click="showShareDialog = true"
          />
          <q-btn
            v-if="canOfferNow"
            flat
            no-caps
            label="Offer"
            icon-right="send"
            color="primary"
            :loading="actionLoading === 'offer'"
            @click="showOfferDialog = true"
          />
          <q-btn
            v-if="canRegister"
            outlined
            no-caps
            label="Register Interest"
            color="primary"
            :loading="actionLoading === 'register'"
            @click="showInterestDialog = true"
          />
          <q-btn
            v-if="canAcceptOffer"
            no-caps
            color="primary"
            label="Accept Offer"
            :loading="actionLoading === 'accept'"
            @click="handleAccept"
          />
          <q-btn
            v-if="canChangeNow"
            flat
            label="Change Contribution"
            icon="edit_note"
            @click="showChangeDialog = true"
            :loading="actionLoading === 'change'"
          />
        </div>
        <q-btn flat round icon="close" v-close-popup />
      </div>
    </q-card>
  </q-dialog>

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
        <div class="role-checkboxes">
          <q-checkbox v-for="role in shareRoleOptions" :key="role.value"
            v-model="shareForm.roles" :val="role.value" :label="role.label" />
        </div>
      </q-card-section>
      <q-card-actions align="right">
        <q-btn flat no-caps label="Cancel" v-close-popup />
        <q-btn no-caps color="primary" label="Share"
          :disable="shareForm.roles.length === 0"
          :loading="actionLoading === 'share'"
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
        <q-input v-model="offerForm.userId" label="User ID *" outlined />
        <q-input v-model="offerForm.userName" label="User Name *" outlined />
      </q-card-section>
      <q-card-actions align="right">
        <q-btn flat no-caps label="Cancel" v-close-popup />
        <q-btn no-caps color="primary" label="Send Offer"
          :disable="!offerForm.userId.trim() || !offerForm.userName.trim()"
          :loading="actionLoading === 'offer'"
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
        <q-input
          v-model="interestNote"
          label="Why are you interested?"
          type="textarea"
          outlined
          autogrow
          placeholder="Optional note..."
        />
      </q-card-section>
      <q-card-actions align="right">
        <q-btn flat no-caps label="Cancel" v-close-popup />
        <q-btn no-caps color="primary" label="Register"
          :loading="actionLoading === 'register'"
          @click="handleRegisterInterest" />
      </q-card-actions>
    </q-card>
  </q-dialog>

  <!-- Recursive child contribution dialog -->
  <ContributionDetailDialog
    v-if="selectedChildContribution"
    v-model="showChildDialog"
    :contribution="selectedChildContribution"
    :user-role="userRole"
    :current-user-id="currentUserId"
    :current-user-name="currentUserName"
    :all-contributions="allContributions"
    :is-plan-signed-off="isPlanSignedOff"
    @update="(updated: Contribution) => {
      emit('update', updated);
      selectedChildContribution = null;
    }"
    @create-child-contribution="(parentId: string) => emit('create-child-contribution', parentId)"
  />

  <!-- Change Contribution Dialog -->
  <CreateContributionDialog
    v-model="showChangeDialog"
    :project-id="contribution.project_id"
    :milestone-id="contribution.milestone_id"
    :editing="true"
    :contribution="contribution"
    @change="handleChange"
  />
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useQuasar } from 'quasar';
import {
  CheckCircle,
  CheckSquare,
  CircleDot,
  AlertTriangle,
  Paperclip,
  ClipboardCheck,
  GitBranch,
  UserCheck,
  UserPlus,
  Send,
  Share2,
  Star,
  Award,
  ThumbsUp,
  RefreshCw,
  XCircle,
  LinkIcon,
} from 'lucide-vue-next';
import type { Contribution, ProjectRole, InterestedContributor, AttachedFile } from 'src/types/projects';
import ContributionStatusBadge from 'src/components/contributions/ContributionStatusBadge.vue';
import ContributionTypeBadge from './ContributionTypeBadge.vue';
import ContributionPriorityBadge from './ContributionPriorityBadge.vue';
import { useContributionsStore } from 'stores/contributions';
import { useContributionWorkflow } from 'src/composables/useContributionWorkflow';
import CreateContributionDialog from './CreateContributionDialog.vue';

defineOptions({ name: 'ContributionDetailDialog' });

interface Props {
  modelValue: boolean;
  contribution: Contribution;
  userRole?: string;
  currentUserId?: string;
  currentUserName?: string;
  allContributions?: Contribution[];
  isPlanSignedOff?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  userRole: 'member',
  currentUserId: '',
  currentUserName: '',
  allContributions: () => [],
  isPlanSignedOff: false,
});

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
  (e: 'update', contribution: Contribution): void;
  (e: 'create-child-contribution', parentId: string): void;
}>();

const $q = useQuasar();
const store = useContributionsStore();
const workflow = useContributionWorkflow();

const actionLoading = ref<string | null>(null);

// Dialogs
const showShareDialog = ref(false);
const showOfferDialog = ref(false);
const showInterestDialog = ref(false);
const showChangeDialog = ref(false);

// File input template refs
const timeReportInput = ref<HTMLInputElement | null>(null);
const attachmentInput = ref<HTMLInputElement | null>(null);

// Forms
const evidenceForm = ref({
  completion_notes: '',
  evidence_urls: [''],
  actual_duration: undefined as number | undefined,
  acceptance_notes: [] as string[],
  time_report_file: null as AttachedFile | null,
  attachment_files: [] as AttachedFile[],
});

watch(() => props.contribution.acceptance_criteria, (criteria) => {
  if (criteria?.length && evidenceForm.value.acceptance_notes.length === 0) {
    evidenceForm.value.acceptance_notes = criteria.map(() => '');
  }
}, { immediate: true });

const reviewForm = ref({
  outcome: '' as 'approved' | 'incomplete' | 'declined' | '',
  feedback: '',
  quality_rating: 5,
});

const shareForm = ref({ roles: [] as string[] });
const offerForm = ref({ userId: '', userName: '' });
const interestNote = ref('');

// Role context
const role = computed(() => props.userRole as ProjectRole);
const isSteward = computed(() => ['community_admin', 'project_steward'].includes(props.userRole));
const isLead = computed(() => ['community_admin', 'project_lead'].includes(props.userRole));

// Child contributions
const childContributions = computed<Contribution[]>(() => {
  const ids = props.contribution.child_contributions ?? [];
  return props.allContributions.filter((c) => ids.includes(c.id));
});

const allChildrenSignedOff = computed(() =>
  childContributions.value.every(
    (c) => ['signed_off', 'rewarded', 'archived'].includes(c.status as string),
  ),
);

const hasBlockingChildren = computed(
  () =>
    childContributions.value.length > 0 &&
    !allChildrenSignedOff.value &&
    (props.contribution.status === 'assigned' || props.contribution.status === 'changed'),
);

const blockingChildCount = computed(
  () =>
    childContributions.value.filter(
      (c) => !['signed_off', 'rewarded', 'archived'].includes(c.status as string),
    ).length,
);

const blockingChildren = computed(() =>
  childContributions.value.filter(
    (c) => !['signed_off', 'rewarded', 'archived'].includes(c.status as string),
  ),
);

const selectedChildContribution = ref<Contribution | null>(null);
const showChildDialog = computed({
  get: () => !!selectedChildContribution.value,
  set: (v: boolean) => { if (!v) selectedChildContribution.value = null; },
});

// Assigned name
const assignedName = computed(
  () =>
    props.contribution.assigned_contributor_name ??
    props.contribution.assigned_contributor ??
    props.contribution.assigned_contributor_id ??
    null,
);

// Permission checks
const canConfirmNow = computed(() =>
  workflow.canConfirm(props.contribution, props.isPlanSignedOff, role.value),
);
const canShareNow = computed(() => workflow.canShare(props.contribution, role.value));
const canOfferNow = computed(() => workflow.canOffer(props.contribution, role.value));
const canRegister = computed(() =>
  workflow.canRegisterInterest(props.contribution, role.value, props.currentUserId),
);
const canAcceptOffer = computed(() =>
  workflow.canAccept(props.contribution, props.currentUserId),
);
const canSubmitEvidenceNow = computed(() =>
  workflow.canSubmitEvidence(
    props.contribution,
    props.currentUserId,
    allChildrenSignedOff.value,
  ),
);
const canReviewNow = computed(() => workflow.canReview(props.contribution, role.value));
const canSignOffNow = computed(() => workflow.canSignOff(props.contribution, role.value));
const canAddSub = computed(() =>
  workflow.canAddSubContribution(props.contribution, props.currentUserId, role.value),
);
const canApproveSub = computed(() => isLead.value || isSteward.value);
const canChangeNow = computed(() =>
  workflow.canChange(props.contribution, props.currentUserId, role.value),
);
const canOfferToContributor = computed(() => isLead.value || isSteward.value);

// Evidence/review reads
const hasEvidence = computed(
  () =>
    !!props.contribution.completion_notes ||
    (props.contribution.evidence_urls?.length ?? 0) > 0,
);
const hasReview = computed(() => !!props.contribution.review_outcome);

// Options
const shareRoleOptions = [
  { label: 'Contributors', value: 'contributor' },
  { label: 'Members', value: 'member' },
  { label: 'Project Leads', value: 'project_lead' },
];

const outcomeOptions: { value: '' | 'approved' | 'incomplete' | 'declined'; label: string; icon: typeof ThumbsUp }[] = [
  { value: 'approved', label: 'Approve', icon: ThumbsUp },
  { value: 'incomplete', label: 'Send Back', icon: RefreshCw },
  { value: 'declined', label: 'Decline', icon: XCircle },
];

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatOutcome(outcome?: string): string {
  const map: Record<string, string> = {
    approved: 'Approved',
    incomplete: 'Sent Back',
    declined: 'Declined',
  };
  return outcome ? (map[outcome] ?? outcome) : '';
}

async function handleAccept() {
  actionLoading.value = 'accept';
  try {
    const updated = await store.acceptOffer(props.contribution.id);
    $q.notify({ type: 'positive', message: 'Contribution accepted!' });
    emit('update', updated as unknown as Contribution);
  } catch (e) {
    $q.notify({ type: 'negative', message: e instanceof Error ? e.message : 'Failed to accept' });
  } finally {
    actionLoading.value = null;
  }
}

async function handleShare() {
  actionLoading.value = 'share';
  try {
    const updated = await store.share(props.contribution.id, {
      shared_with_roles: shareForm.value.roles,
    });
    $q.notify({ type: 'positive', message: 'Contribution shared successfully!' });
    showShareDialog.value = false;
    shareForm.value.roles = [];
    emit('update', updated as unknown as Contribution);
  } catch (e) {
    $q.notify({ type: 'negative', message: e instanceof Error ? e.message : 'Failed to share' });
  } finally {
    actionLoading.value = null;
  }
}

async function handleOffer() {
  actionLoading.value = 'offer';
  try {
    const updated = await store.offer(props.contribution.id, {
      offered_to: offerForm.value.userId,
      offered_to_name: offerForm.value.userName,
    });
    $q.notify({ type: 'positive', message: `Contribution offered to ${offerForm.value.userName}` });
    showOfferDialog.value = false;
    offerForm.value = { userId: '', userName: '' };
    emit('update', updated as unknown as Contribution);
  } catch (e) {
    $q.notify({ type: 'negative', message: e instanceof Error ? e.message : 'Failed to offer' });
  } finally {
    actionLoading.value = null;
  }
}

async function handleOfferToContributor(ic: InterestedContributor) {
  actionLoading.value = `offer-${ic.user_id}`;
  try {
    const updated = await store.offer(props.contribution.id, {
      offered_to: ic.user_id,
      offered_to_name: ic.user_name,
    });
    $q.notify({ type: 'positive', message: `Contribution offered to ${ic.user_name}` });
    emit('update', updated as unknown as Contribution);
  } catch (e) {
    $q.notify({ type: 'negative', message: e instanceof Error ? e.message : 'Failed to offer' });
  } finally {
    actionLoading.value = null;
  }
}

async function handleRegisterInterest() {
  actionLoading.value = 'register';
  try {
    const updated = await store.registerInterest(props.contribution.id, {
      interest_note: interestNote.value.trim(),
    });
    $q.notify({ type: 'positive', message: 'Interest registered successfully!' });
    showInterestDialog.value = false;
    interestNote.value = '';
    emit('update', updated as unknown as Contribution);
  } catch (e) {
    $q.notify({ type: 'negative', message: e instanceof Error ? e.message : 'Failed to register interest' });
  } finally {
    actionLoading.value = null;
  }
}

function handleTimeReportUpload(file: File) {
  const url = URL.createObjectURL(file);
  evidenceForm.value.time_report_file = { name: file.name, url, type: file.type };
}

function handleAttachmentUpload(files: FileList | File[]) {
  for (const file of Array.from(files)) {
    const url = URL.createObjectURL(file);
    evidenceForm.value.attachment_files.push({ name: file.name, url, type: file.type });
  }
}

function removeTimeReport() {
  const f = evidenceForm.value.time_report_file;
  if (f?.url.startsWith('blob:')) URL.revokeObjectURL(f.url);
  evidenceForm.value.time_report_file = null;
}

function removeAttachment(idx: number) {
  const file = evidenceForm.value.attachment_files[idx];
  if (file?.url.startsWith('blob:')) URL.revokeObjectURL(file.url);
  evidenceForm.value.attachment_files.splice(idx, 1);
}

async function handleSubmitEvidence() {
  if (!evidenceForm.value.completion_notes.trim()) return;
  actionLoading.value = 'submit-evidence';
  try {
    const updated = await store.submitEvidence(props.contribution.id, {
      completion_notes: evidenceForm.value.completion_notes.trim(),
      evidence_urls: evidenceForm.value.evidence_urls.filter((u) => u.trim()),
      actual_duration: evidenceForm.value.actual_duration,
      acceptance_notes: evidenceForm.value.acceptance_notes.filter((n) => n.trim()),
      time_report_file: evidenceForm.value.time_report_file ?? undefined,
      attachment_files: evidenceForm.value.attachment_files.length ? evidenceForm.value.attachment_files : undefined,
    });
    $q.notify({ type: 'positive', message: 'Submitted for review!' });
    evidenceForm.value = { completion_notes: '', evidence_urls: [''], actual_duration: undefined, acceptance_notes: [], time_report_file: null, attachment_files: [] };
    emit('update', updated as unknown as Contribution);
  } catch (e) {
    $q.notify({ type: 'negative', message: e instanceof Error ? e.message : 'Submission failed' });
  } finally {
    actionLoading.value = null;
  }
}

async function handleSubmitReview() {
  if (!reviewForm.value.outcome) return;
  actionLoading.value = 'review';
  try {
    const updated = await store.review(props.contribution.id, {
      outcome: reviewForm.value.outcome as 'approved' | 'incomplete' | 'declined',
      feedback: reviewForm.value.feedback.trim() || undefined,
      quality_rating: reviewForm.value.quality_rating,
    });
    $q.notify({ type: 'positive', message: 'Review submitted!' });
    reviewForm.value = { outcome: '', feedback: '', quality_rating: 5 };
    emit('update', updated as unknown as Contribution);
  } catch (e) {
    $q.notify({ type: 'negative', message: e instanceof Error ? e.message : 'Review failed' });
  } finally {
    actionLoading.value = null;
  }
}

async function handleSignOff() {
  actionLoading.value = 'sign-off';
  try {
    const updated = await store.signOff(props.contribution.id);
    $q.notify({ type: 'positive', message: 'Contribution signed off! Treasury action will be generated.' });
    emit('update', updated as unknown as Contribution);
  } catch (e) {
    $q.notify({ type: 'negative', message: e instanceof Error ? e.message : 'Sign off failed' });
  } finally {
    actionLoading.value = null;
  }
}

async function handleApproveSub(subId: string) {
  actionLoading.value = `approve-sub-${subId}`;
  try {
    const updated = await store.approveSub(subId);
    $q.notify({ type: 'positive', message: 'Sub-contribution approved and assigned!' });
    emit('update', updated as unknown as Contribution);
  } catch (e) {
    $q.notify({ type: 'negative', message: e instanceof Error ? e.message : 'Approve failed' });
  } finally {
    actionLoading.value = null;
  }
}

async function handleChange(data: { updates: Record<string, unknown>; reason: string }) {
  actionLoading.value = 'change';
  try {
    await store.update(props.contribution.id, data.updates as any);
    const updated = await store.transition(props.contribution.id, 'changed');
    emit('update', updated);
    showChangeDialog.value = false;
  } catch (err) {
    console.error('[ContribDetail] change failed:', err);
  } finally {
    actionLoading.value = null;
  }
}
</script>

<style scoped lang="scss">
.detail-dialog {
  width: 100%;
  max-width: 800px;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

// Sticky header
.dialog-sticky-header {
  position: sticky;
  top: 0;
  z-index: 10;
  background: var(--matou-card);
  border-bottom: 1px solid var(--matou-border);
  padding: 16px 20px 14px;
  flex-shrink: 0;
}

.header-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}

.header-title {
  font-size: 1.4rem;
  font-weight: 700;
  margin: 0 0 6px;
  color: var(--matou-foreground);
  line-height: 1.25;
  padding-right: 40px;
}

.header-meta {
  font-size: 0.8rem;
  color: var(--matou-muted-foreground);
}

.close-btn {
  position: absolute;
  top: 12px;
  right: 12px;
}

// Scrollable body
.dialog-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

// Sticky footer
.dialog-sticky-footer {
  position: sticky;
  bottom: 0;
  z-index: 10;
  background: var(--matou-card);
  border-top: 1px solid var(--matou-border);
  padding: 10px 16px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.footer-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

// Status panels
.status-panel {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-radius: var(--matou-radius-sm);
  border: 1px solid var(--matou-border);
}

.offered-panel {
  background: rgba(30, 95, 116, 0.05);
  border-color: var(--matou-primary);
}

.shared-panel {
  background: rgba(74, 157, 156, 0.06);
  border-color: var(--matou-accent);
}

.panel-icon {
  width: 18px;
  height: 18px;
  color: var(--matou-primary);
  flex-shrink: 0;
}

.panel-title {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--matou-foreground);
}

.panel-sub {
  font-size: 0.78rem;
  color: var(--matou-muted-foreground);
}

// Content sections
.content-section {
  background: var(--matou-card);
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius);
  padding: 14px 18px;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.section-title {
  font-size: 0.95rem;
  font-weight: 600;
  margin: 0 0 12px;
  color: var(--matou-foreground);
  display: flex;
  align-items: center;
  gap: 6px;
}

.section-icon {
  width: 16px;
  height: 16px;
  color: var(--matou-primary);
  flex-shrink: 0;
}

.section-text {
  color: var(--matou-muted-foreground);
  white-space: pre-wrap;
  margin: 0;
  line-height: 1.6;
  font-size: 0.9rem;
}

.count-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  background: var(--matou-muted);
  border-radius: 10px;
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--matou-muted-foreground);
}

// Lists
.item-list {
  list-style: none;
  padding: 0;
  margin: 0;

  li {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin-bottom: 6px;
    color: var(--matou-muted-foreground);
    font-size: 0.875rem;
    line-height: 1.5;

    &:last-child { margin-bottom: 0; }
  }
}

.list-icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--matou-muted-foreground);

  &.accent-icon {
    color: var(--matou-accent);
  }
}

.skill-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

// Stats grid
.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 12px;
}

.stat-card {
  background: var(--matou-card);
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius-sm);
  padding: 12px 14px;
}

.stat-label {
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--matou-muted-foreground);
  font-weight: 500;
  margin-bottom: 4px;
}

.stat-value {
  font-size: 1rem;
  font-weight: 600;
  color: var(--matou-foreground);
}

// Interested contributors
.interested-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.interested-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: var(--matou-secondary);
  border-radius: var(--matou-radius-sm);
  border: 1px solid var(--matou-border);
}

.interested-avatar {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--matou-primary);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.8rem;
  font-weight: 600;
  flex-shrink: 0;
}

.interested-info {
  flex: 1;
}

.interested-name {
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--matou-foreground);
}

.interested-note {
  font-size: 0.8rem;
  color: var(--matou-muted-foreground);
  font-style: italic;
}

.interested-date {
  font-size: 0.72rem;
  color: var(--matou-muted-foreground);
}

// Sub-contributions
.sub-empty {
  font-size: 0.85rem;
  color: var(--matou-muted-foreground);
  font-style: italic;
}

.sub-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sub-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--matou-secondary);
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius-sm);

  &.clickable {
    cursor: pointer;
    transition: background-color 0.15s;

    &:hover {
      background-color: rgba(0, 0, 0, 0.04);
    }
  }
}

.sub-item-badges {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.sub-item-title {
  flex: 1;
  font-size: 0.875rem;
  color: var(--matou-foreground);
}

// Blocking warning
.blocking-warning {
  display: flex;
  gap: 0.75rem;
  padding: 0.75rem;
  background: rgba(255, 152, 0, 0.08);
  border: 1px solid rgba(255, 152, 0, 0.2);
  border-radius: 8px;
  margin-top: 0.75rem;

  .blocking-title {
    font-weight: 600;
    font-size: 0.85rem;
  }

  .blocking-text {
    font-size: 0.8rem;
    color: $grey-7;
    margin-top: 0.25rem;
  }

  .blocking-list {
    margin: 0.5rem 0 0 0;
    padding-left: 1.25rem;
    font-size: 0.8rem;

    li {
      margin-bottom: 0.25rem;
      display: flex;
      align-items: center;
      gap: 0.25rem;
    }
  }
}

// Evidence URLs
.evidence-urls {
  margin-bottom: 12px;
}

.list-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.list-input {
  flex: 1;
}

.evidence-url-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.evidence-url-link {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.875rem;
  color: var(--matou-primary);
  text-decoration: none;
  word-break: break-all;

  &:hover { text-decoration: underline; }
}

.link-icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}

// Review outcome
.outcome-group {
  // empty
}

.outcome-btns {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.outcome-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius-sm);
  background: transparent;
  cursor: pointer;
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--matou-muted-foreground);
  transition: all 0.12s ease;

  &.approved.active {
    background: rgba(74, 157, 156, 0.12);
    color: var(--matou-accent);
    border-color: var(--matou-accent);
  }

  &.incomplete.active {
    background: rgba(30, 95, 116, 0.1);
    color: var(--matou-primary);
    border-color: var(--matou-primary);
  }

  &.declined.active {
    background: rgba(200, 70, 58, 0.1);
    color: var(--matou-destructive);
    border-color: var(--matou-destructive);
  }
}

.outcome-icon {
  width: 14px;
  height: 14px;
}

// Star rating
.star-row {
  display: flex;
  align-items: center;
  gap: 4px;
}

.star-btn {
  background: none;
  border: none;
  padding: 2px;
  cursor: pointer;
  color: var(--matou-muted-foreground);

  .star-icon {
    width: 20px;
    height: 20px;
    transition: color 0.1s ease;
  }

  &.filled .star-icon {
    fill: var(--matou-accent);
    color: var(--matou-accent);
  }

  &:hover .star-icon {
    color: var(--matou-accent);
  }
}

.star-label {
  font-size: 0.8rem;
  color: var(--matou-muted-foreground);
  margin-left: 6px;
}

.review-outcome-chip {
  display: inline-block;
  font-size: 0.8rem;
  font-weight: 600;
  padding: 4px 12px;
  border-radius: 12px;
  text-transform: capitalize;

  &.approved {
    background: rgba(74, 157, 156, 0.12);
    color: var(--matou-accent);
  }

  &.incomplete {
    background: rgba(30, 95, 116, 0.1);
    color: var(--matou-primary);
  }

  &.declined {
    background: rgba(200, 70, 58, 0.1);
    color: var(--matou-destructive);
  }
}

// Sign off panels
.sign-off-panel,
.signed-off-panel {
  display: flex;
  align-items: center;
  gap: 14px;
}

.sign-off-panel {
  border-color: var(--matou-accent);
  background: rgba(74, 157, 156, 0.04);
}

.signed-off-panel {
  border-color: var(--matou-accent);
  background: rgba(74, 157, 156, 0.08);
}

.sign-off-icon {
  width: 24px;
  height: 24px;
  color: var(--matou-accent);
  flex-shrink: 0;
}

.sign-off-title {
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--matou-foreground);
}

.sign-off-sub {
  font-size: 0.8rem;
  color: var(--matou-muted-foreground);
  margin-top: 2px;
}

.role-checkboxes {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.evidence-criteria {
  margin-bottom: 1rem;

  .criterion-response {
    margin-bottom: 0.75rem;
  }

  .criterion-text {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    margin-bottom: 0.25rem;
    font-size: 0.85rem;

    .q-icon { margin-top: 2px; flex-shrink: 0; }
  }

  .criterion-input { margin-left: 1.5rem; }
}

// File upload
.file-upload-section {
  margin-bottom: 1rem;
}

.file-drop-zone {
  border: 2px dashed $separator-color;
  border-radius: 8px;
  padding: 1.5rem;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;

  .file-drop-text {
    font-size: 0.8rem;
    color: $grey-7;
  }
}

.file-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid $separator-color;
  border-radius: 6px;
  margin-top: 0.5rem;

  .file-name {
    flex: 1;
    font-size: 0.85rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}
</style>
