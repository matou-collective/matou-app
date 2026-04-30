<template>
  <q-dialog
    :model-value="modelValue"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <q-card class="detail-dialog">
      <!-- Sticky header -->
      <div class="dialog-sticky-header">
        <div class="header-badges">
          <ContributionStatusBadge :status="contribution.status" />
          <ContributionTypeBadge :type="contribution.contribution_type" />
        </div>
        <div v-if="assignedAid" class="assigned-avatar">
          <q-tooltip>Assigned to {{ assignedName }}</q-tooltip>
          <img
            v-if="assignedAvatar"
            :src="assignedAvatar"
            class="avatar-img"
          />
          <span v-else class="avatar-initials">{{ assignedInitials }}</span>
        </div>
        <h2 class="header-title">{{ contribution.title }}</h2>
        <q-btn
          icon="close"
          flat
          round
          dense
          class="close-btn"
          v-close-popup
        />
        <q-btn
          v-if="canChangeNow"
          flat
          round
          dense
          icon="edit"
          color="primary"
          class="edit-btn"
          @click="showChangeDialog = true"
        />
      </div>

      <!-- Scrollable body -->
      <div class="dialog-body">

        <!-- ── Status panels ─────────────────────────────── -->

        <!-- Offered panel -->
        <div v-if="contribution.status === 'offered'" class="status-panel offered-panel">
          <Send class="panel-icon" />
          <div>
            <div class="panel-title">Offered to {{ profilesStore.profilesByAid[contribution.offered_to]?.displayName ?? contribution.offered_to_name ?? contribution.offered_to }}</div>
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

        <!-- Changes proposed panel -->
        <div v-if="contribution.status === 'changed' && contribution.changes_diff?.length" class="changes-panel">
          <div class="changes-panel-header">
            <AlertTriangle class="panel-icon changes-icon" />
            <div>
              <div class="panel-title">Changes Requested</div>
              <div v-if="contribution.change_reason" class="panel-sub">
                Reason: {{ contribution.change_reason }}
              </div>
              <div v-if="contribution.changed_by" class="panel-sub">
                By {{ profilesStore.profilesByAid[contribution.changed_by]?.displayName ?? contribution.changed_by?.slice(0, 12) + '...' }}
                <span v-if="contribution.changed_at"> on {{ formatDate(contribution.changed_at) }}</span>
              </div>
            </div>
          </div>
          <div class="changes-diff-list">
            <div
              v-for="(diff, idx) in contribution.changes_diff"
              :key="idx"
              class="changes-diff-item"
            >
              <div class="diff-field">{{ formatFieldName(diff.field) }}</div>
              <div class="diff-values">
                <div class="diff-old">
                  <span class="diff-label">Was:</span>
                  <span>{{ diff.old_value || '(empty)' }}</span>
                </div>
                <div class="diff-new">
                  <span class="diff-label">Now:</span>
                  <span>{{ diff.new_value || '(empty)' }}</span>
                </div>
              </div>
            </div>
          </div>
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
            color="primary"
            class="q-ml-auto register-interest-btn"
            :loading="actionLoading === 'register'"
            @click="showInterestDialog = true"
          />
          <span v-else-if="hasRegistered && !canAcceptOffer && (contribution.status === 'shared' || contribution.status === 'offered')" class="registered-badge q-ml-auto">
            <q-icon name="check_circle" size="16px" />
            Interest Registered
          </span>
          <q-btn
            v-if="canAcceptOffer"
            no-caps
            color="primary"
            label="Accept Offer"
            class="q-ml-auto register-interest-btn"
            :loading="actionLoading === 'accept'"
            @click="handleAccept"
          />
        </div>

        <!-- Interested contributors -->
        <div
          v-if="contribution.interested_contributors?.length && (isSteward || isLead) && (contribution.status === 'shared' || contribution.status === 'offered')"
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
                outline
                no-caps
                label="Offer"
                color="primary"
                class="offer-interested-btn"
                :loading="actionLoading === `offer-${ic.user_id}`"
                @click="confirmOfferToContributor(ic)"
              />
            </div>
          </div>
        </div>

        <!-- Description -->
        <div class="description-section">
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
        <div class="sub-contributions-section">
          <div class="section-header">
            <h3 class="section-title">Sub-Contributions ({{ childContributions.length }})</h3>
            <q-btn
              v-if="canAddSub && childContributions.length > 0"
              outline
              no-caps
              icon="add"
              label="Add Sub-Contribution"
              color="primary"
              class="add-sub-btn"
              @click="$emit('create-child-contribution', contribution.id)"
            />
          </div>

          <div v-if="childContributions.length === 0" class="sub-empty">
            <span>No sub-contributions yet. Break down this contribution into smaller tasks.</span>
            <q-btn
              v-if="canAddSub"
              outline
              no-caps
              icon="add"
              label="Add Sub-Contribution"
              color="primary"
              class="add-sub-btn q-mt-sm"
              @click="$emit('create-child-contribution', contribution.id)"
            />
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
                outline
                no-caps
                label="Approve"
                color="primary"
                class="approve-sub-btn"
                :loading="actionLoading === `approve-sub-${child.id}`"
                @click.stop="handleApproveSub(child.id)"
              />
              <template v-if="canApproveSub">
                <q-btn
                  flat round dense size="sm"
                  icon="edit"
                  @click.stop="emit('edit-sub-contribution', child)"
                >
                  <q-tooltip>Edit Sub-Contribution</q-tooltip>
                </q-btn>
                <q-btn
                  flat round dense size="sm"
                  icon="delete"
                  color="negative"
                  @click.stop="emit('archive-sub-contribution', child)"
                >
                  <q-tooltip>Delete Sub-Contribution</q-tooltip>
                </q-btn>
              </template>
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

        <!-- Evidence submission form (toggled by footer button) -->
        <div v-if="canSubmitEvidenceNow && showEvidenceForm" class="submit-completion-form">
          <h3 class="completion-form-title">Submit Completion</h3>

          <!-- Completion Notes -->
          <div class="completion-field">
            <div class="completion-field-label">Completion Notes *</div>
            <q-input
              v-model="evidenceForm.completion_notes"
              type="textarea"
              outlined
              autogrow
              :rows="3"
              placeholder="Describe how you completed this contribution..."
            />
          </div>

          <!-- How Acceptance Criteria Were Met -->
          <div v-if="contribution.acceptance_criteria?.length" class="completion-field">
            <div class="completion-field-label">How Acceptance Criteria Were Met *</div>
            <div
              v-for="(criterion, idx) in contribution.acceptance_criteria"
              :key="idx"
              class="criterion-block"
            >
              <div class="criterion-label">{{ criterion }}</div>
              <q-input
                v-model="evidenceForm.acceptance_notes[idx]"
                outlined
                dense
                placeholder="Explain how this was met..."
              />
            </div>
          </div>

          <!-- Evidence URLs -->
          <div class="completion-field">
            <div class="completion-field-label">Evidence URLs</div>
            <div class="evidence-url-row">
              <q-input
                v-model="newEvidenceUrl"
                outlined
                dense
                placeholder="https://..."
                class="evidence-url-input"
              />
              <q-btn
                unelevated
                no-caps
                icon="link"
                label="Add"
                color="primary"
                class="evidence-url-add-btn"
                :disable="!newEvidenceUrl.trim()"
                @click="evidenceForm.evidence_urls.push(newEvidenceUrl.trim()); newEvidenceUrl = ''"
              />
            </div>
            <div v-for="(url, i) in evidenceForm.evidence_urls" :key="i" class="evidence-url-item">
              <q-icon name="link" size="14px" />
              <span class="evidence-url-text">{{ url }}</span>
              <q-btn flat round dense icon="close" size="xs" @click="evidenceForm.evidence_urls.splice(i, 1)" />
            </div>
          </div>

          <!-- File Uploads (two columns) -->
          <div class="file-uploads-row">
            <div class="file-upload-col">
              <div class="completion-field-label">Time Reports</div>
              <div class="file-thumbs-row">
                <div
                  v-for="(file, idx) in evidenceForm.time_report_files"
                  :key="'tr-' + idx"
                  class="file-thumb"
                >
                  <img v-if="file.type?.startsWith('image/')" :src="file.url" class="file-thumb-img" />
                  <q-icon v-else :name="fileIcon(file.type)" size="28px" class="file-thumb-icon" />
                  <div class="file-thumb-name">{{ file.name }}</div>
                  <q-btn flat round dense icon="close" size="xs" class="file-thumb-remove" @click="removeTimeReport(idx)" />
                </div>
                <button class="file-add-btn" :disabled="uploadingFiles" @click="timeReportInput?.click()">
                  <q-spinner-dots v-if="uploadingFiles" size="20px" />
                  <q-icon v-else name="upload_file" size="24px" />
                  <span>{{ uploadingFiles ? 'Uploading...' : 'Add' }}</span>
                </button>
                <input
                  ref="timeReportInput"
                  type="file"
                  accept=".pdf,.csv,.xlsx,.png,.jpg,.jpeg"
                  multiple
                  style="display: none"
                  @change="(e: Event) => {
                    const files = (e.target as HTMLInputElement).files;
                    if (files?.length) handleTimeReportUpload(files);
                    (e.target as HTMLInputElement).value = '';
                  }"
                />
              </div>
            </div>
            <div class="file-upload-col">
              <div class="completion-field-label">Attachments</div>
              <div class="file-thumbs-row">
                <div
                  v-for="(file, idx) in evidenceForm.attachment_files"
                  :key="'at-' + idx"
                  class="file-thumb"
                >
                  <img v-if="file.type?.startsWith('image/')" :src="file.url" class="file-thumb-img" />
                  <q-icon v-else :name="fileIcon(file.type)" size="28px" class="file-thumb-icon" />
                  <div class="file-thumb-name">{{ file.name }}</div>
                  <q-btn flat round dense icon="close" size="xs" class="file-thumb-remove" @click="removeAttachment(idx)" />
                </div>
                <button class="file-add-btn" :disabled="uploadingFiles" @click="attachmentInput?.click()">
                  <q-spinner-dots v-if="uploadingFiles" size="20px" />
                  <q-icon v-else name="attach_file" size="24px" />
                  <span>{{ uploadingFiles ? 'Uploading...' : 'Add' }}</span>
                </button>
                <input
                  ref="attachmentInput"
                  type="file"
                  multiple
                  style="display: none"
                  @change="(e: Event) => {
                    const files = (e.target as HTMLInputElement).files;
                    if (files?.length) handleAttachmentUpload(files);
                    (e.target as HTMLInputElement).value = '';
                  }"
                />
              </div>
            </div>
          </div>

          <!-- Actual Hours Worked -->
          <div class="completion-field">
            <div class="completion-field-label">Actual Hours Worked</div>
            <q-input
              v-model.number="evidenceForm.actual_duration"
              type="number"
              outlined
              dense
              min="0"
            />
          </div>

          <!-- Submit / Cancel -->
          <div class="dialog-btn-row q-mt-md">
            <q-btn
              unelevated
              no-caps
              color="primary"
              icon="send"
              label="Submit for Review"
              class="dialog-btn-half"
              :loading="actionLoading === 'submit-evidence'"
              :disable="!canSubmitEvidence"
              @click="handleSubmitEvidence"
            />
            <q-btn
              outline
              no-caps
              label="Cancel"
              color="primary"
              class="dialog-btn-half"
              @click="showEvidenceForm = false"
            />
          </div>
        </div>

        <!-- Existing evidence (read-only) -->
        <div v-if="hasEvidence" class="content-section">
          <h3 class="section-title">
            <Paperclip class="section-icon" />
            Submitted Evidence
          </h3>

          <!-- Completion Notes -->
          <div v-if="contribution.completion_notes" class="evidence-field">
            <div class="evidence-field-label">Completion Notes</div>
            <div class="evidence-field-value">{{ contribution.completion_notes }}</div>
          </div>

          <!-- Acceptance Criteria Responses -->
          <div v-if="contribution.acceptance_notes?.length" class="evidence-field">
            <div class="evidence-field-label">Acceptance Criteria Responses</div>
            <div
              v-for="(note, idx) in contribution.acceptance_notes"
              :key="idx"
              class="evidence-criterion-item"
            >
              <div v-if="contribution.acceptance_criteria?.[idx]" class="evidence-criterion-label">
                {{ contribution.acceptance_criteria[idx] }}
              </div>
              <div class="evidence-criterion-response">{{ note }}</div>
            </div>
          </div>

          <!-- Evidence URLs -->
          <div v-if="contribution.evidence_urls?.length" class="evidence-field">
            <div class="evidence-field-label">Evidence URLs</div>
            <div class="evidence-url-list">
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

          <!-- Files -->
          <div v-if="contribution.time_report_file || contribution.attachment_files?.length" class="evidence-field">
            <div class="evidence-field-label">Files</div>
            <div class="evidence-files-row">
              <a
                v-if="contribution.time_report_file"
                :href="resolveFileUrl(contribution.time_report_file)"
                target="_blank"
                class="evidence-file-chip"
              >
                <q-icon name="description" size="14px" />
                {{ contribution.time_report_file.file_name || contribution.time_report_file.name }}
              </a>
              <a
                v-for="(f, i) in contribution.attachment_files"
                :key="i"
                :href="resolveFileUrl(f)"
                target="_blank"
                class="evidence-file-chip"
              >
                <q-icon name="attach_file" size="14px" />
                {{ f.file_name || f.name }}
              </a>
            </div>
          </div>

          <!-- Actual Hours -->
          <div v-if="contribution.actual_duration" class="evidence-field">
            <div class="evidence-field-label">Actual Hours Worked</div>
            <div class="evidence-field-value">{{ contribution.actual_duration }}h</div>
          </div>
        </div>

        <!-- Review form (lead/admin, status=needs_review) — toggled by footer button -->
        <div v-if="canReviewNow && showReviewForm" class="submit-completion-form">
          <h3 class="completion-form-title">Review Submission</h3>

          <!-- Decision -->
          <div class="completion-field">
            <div class="completion-field-label">Decision *</div>
            <div class="decision-btns">
              <button
                v-for="outcome in outcomeOptions"
                :key="outcome.value"
                class="decision-btn"
                :class="[outcome.value, { active: reviewForm.outcome === outcome.value }]"
                @click="reviewForm.outcome = outcome.value"
                type="button"
              >
                <component :is="outcome.icon" class="decision-btn-icon" />
                {{ outcome.label }}
              </button>
            </div>
          </div>

          <!-- Quality rating (10 stars) -->
          <div class="completion-field">
            <div class="completion-field-label">Quality Rating</div>
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
          <div class="completion-field">
            <div class="completion-field-label">Review Feedback</div>
            <q-input
              v-model="reviewForm.feedback"
              type="textarea"
              outlined
              autogrow
              :rows="3"
              placeholder="Provide feedback on the submission..."
            />
          </div>

          <div class="dialog-btn-row q-mt-md">
            <q-btn
              unelevated
              no-caps
              color="primary"
              label="Submit Review"
              icon="check"
              class="dialog-btn-half"
              :loading="actionLoading === 'review'"
              :disable="!reviewForm.outcome"
              @click="handleSubmitReview"
            />
            <q-btn
              outline
              no-caps
              label="Cancel"
              color="primary"
              class="dialog-btn-half"
              @click="showReviewForm = false"
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
              by {{ profilesStore.profilesByAid[contribution.signed_off_by]?.displayName ?? contribution.signed_off_by?.slice(0, 12) + '...' }}
              <span v-if="contribution.signed_off_at">on {{ formatDate(contribution.signed_off_at) }}</span>
            </div>
          </div>
        </div>

      </div>

      <!-- Sticky footer actions -->
      <div class="dialog-sticky-footer">
        <div class="footer-actions">
          <q-btn
            v-if="canShareNow || canOfferNow"
            unelevated
            no-caps
            label="Assign Contribution"
            icon="person_add"
            color="primary"
            class="footer-action-btn"
            @click="openAssignDialog"
          />
          <q-btn
            v-if="canRegister"
            outlined
            no-caps
            label="Register Interest"
            color="primary"
            class="footer-action-btn"
            :loading="actionLoading === 'register'"
            @click="showInterestDialog = true"
          />
          <div v-else-if="hasRegistered && !canAcceptOffer && (contribution.status === 'shared' || contribution.status === 'offered')" class="registered-badge full-width q-my-sm">
            <q-icon name="check_circle" size="16px" />
            Interest Registered
          </div>
          <q-btn
            v-if="canAcceptOffer"
            no-caps
            color="primary"
            label="Accept Offer"
            class="footer-action-btn"
            :loading="actionLoading === 'accept'"
            @click="handleAccept"
          />
          <q-btn
            v-if="canConfirmNow"
            unelevated
            no-caps
            color="primary"
            :label="contribution.status === 'changed' ? 'Confirm Changes' : 'Confirm'"
            icon="check_circle"
            class="footer-action-btn"
            :loading="actionLoading === 'confirm'"
            @click="handleConfirm"
          />
          <q-btn
            v-if="canSubmitEvidenceNow && !showEvidenceForm"
            unelevated
            no-caps
            color="primary"
            label="Submit Evidence & Complete"
            icon="check_circle"
            class="footer-action-btn"
            @click="showEvidenceForm = true"
          />
          <q-btn
            v-if="canReviewNow && !showReviewForm"
            unelevated
            no-caps
            color="primary"
            label="Review Submission"
            icon="rate_review"
            class="footer-action-btn"
            @click="showReviewForm = true"
          />
        </div>
      </div>
    </q-card>
  </q-dialog>

  <!-- Assign contribution dialog -->
  <q-dialog v-model="showAssignDialog">
    <q-card class="assign-dialog">
      <q-card-section class="row items-center q-pb-none">
        <div class="text-h6">Assign Contribution</div>
        <q-space />
        <q-btn icon="close" flat round dense v-close-popup />
      </q-card-section>

      <q-card-section class="assign-body">
        <!-- Registered interest members -->
        <div v-if="contribution.interested_contributors?.length" class="assign-section">
          <div class="assign-section-label">Registered Interest</div>
          <div
            v-for="ic in contribution.interested_contributors"
            :key="ic.user_id"
            class="assign-member-row"
            :class="{ selected: assignSelectedMember === ic.user_id }"
            @click="selectAssignMember(ic.user_id, ic.user_name)"
          >
            <div>
              <div class="assign-member-name">{{ ic.user_name || ic.user_id.slice(0, 12) + '...' }}</div>
              <div v-if="ic.interest_note" class="assign-member-note">{{ ic.interest_note }}</div>
            </div>
            <q-icon v-if="assignSelectedMember === ic.user_id" name="check_circle" color="primary" size="18px" />
          </div>
        </div>

        <!-- Mode selection -->
        <div class="assign-section">
          <div class="assign-section-label">Assign to</div>
          <div class="assign-mode-row">
            <button
              class="assign-mode-card"
              :class="{ active: assignMode === 'group' }"
              @click="assignMode = 'group'; assignSelectedMember = null; assignSelectedMemberName = null"
            >
              <q-icon name="groups" size="20px" />
              <span>Group</span>
            </button>
            <button
              class="assign-mode-card"
              :class="{ active: assignMode === 'member' }"
              @click="assignMode = 'member'; assignSelectedGroup = null"
            >
              <q-icon name="person" size="20px" />
              <span>Member</span>
            </button>
          </div>
        </div>

        <!-- Group list -->
        <div v-if="assignMode === 'group'" class="assign-section">
          <div
            v-for="g in assignGroupOptions"
            :key="g.value"
            class="assign-member-row"
            :class="{ selected: assignSelectedGroup === g.value }"
            @click="assignSelectedGroup = g.value"
          >
            <div class="assign-member-name">{{ g.label }}</div>
            <q-icon v-if="assignSelectedGroup === g.value" name="check_circle" color="primary" size="18px" />
          </div>
        </div>

        <!-- Member search + list -->
        <div v-if="assignMode === 'member'" class="assign-section">
          <q-input
            v-model="assignMemberSearch"
            outlined
            dense
            placeholder="Search members..."
            class="q-mb-sm"
          >
            <template #prepend>
              <q-icon name="search" />
            </template>
          </q-input>
          <div class="assign-member-list">
            <div
              v-for="m in filteredAssignMembers"
              :key="m.id"
              class="assign-member-row"
              :class="{ selected: assignSelectedMember === m.id }"
              @click="selectAssignMember(m.id, m.name)"
            >
              <div class="assign-member-name">{{ m.name }}</div>
              <q-icon v-if="assignSelectedMember === m.id" name="check_circle" color="primary" size="18px" />
            </div>
            <div v-if="filteredAssignMembers.length === 0" class="assign-empty">
              No members found
            </div>
          </div>
        </div>
      </q-card-section>

      <div class="dialog-btn-row q-px-md q-pb-md">
        <q-btn outline no-caps label="Cancel" color="primary" class="dialog-btn-half" v-close-popup />
        <q-btn
          no-caps
          label="Assign"
          color="primary"
          class="dialog-btn-half"
          :disable="!canSubmitAssign"
          :loading="assigningContribution"
          @click="submitAssign"
        />
      </div>
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
          :rows="3"
          placeholder="Optional note..."
        />
      </q-card-section>
      <div class="dialog-btn-row q-px-md q-pb-md">
        <q-btn outline no-caps label="Cancel" color="primary" class="dialog-btn-half" v-close-popup />
        <q-btn no-caps color="primary" label="Register" class="dialog-btn-half"
          :loading="actionLoading === 'register'"
          @click="handleRegisterInterest" />
      </div>
    </q-card>
  </q-dialog>

  <!-- Offer confirmation dialog -->
  <q-dialog v-model="showOfferConfirmDialog">
    <q-card style="min-width: 400px">
      <q-card-section>
        <div class="text-h6">Confirm Offer</div>
        <p class="text-body2 q-mt-sm" v-if="pendingOfferContributor">
          Are you sure you want to offer this contribution to
          <strong>{{ pendingOfferContributor.user_name }}</strong>?
        </p>
      </q-card-section>
      <div class="dialog-btn-row q-px-md q-pb-md">
        <q-btn outline no-caps label="Cancel" color="primary" class="dialog-btn-half" v-close-popup />
        <q-btn no-caps label="Confirm Offer" color="primary" class="dialog-btn-half" @click="handleConfirmedOffer" />
      </div>
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
    @update="handleChildUpdate"
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
import { useContributionsStore } from 'stores/contributions';
import { useProfilesStore } from 'stores/profiles';
import { uploadFile, getFileUrl } from 'src/lib/api/client';
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
  (e: 'edit-sub-contribution', contribution: Contribution): void;
  (e: 'archive-sub-contribution', contribution: Contribution): void;
}>();

const $q = useQuasar();
const store = useContributionsStore();
const workflow = useContributionWorkflow();

const actionLoading = ref<string | null>(null);

// Dialogs
const showAssignDialog = ref(false);
const assignMode = ref<'group' | 'member' | null>(null);
const assignSelectedGroup = ref<string | null>(null);
const assignSelectedMember = ref<string | null>(null);
const assignSelectedMemberName = ref<string | null>(null);
const assignMemberSearch = ref('');
const assigningContribution = ref(false);

const assignGroupOptions = [
  { label: 'Stewards', value: 'steward' },
  { label: 'Members', value: 'all' },
];

const communityMembersList = computed(() => {
  const map = profilesStore.profilesByAid;
  return Object.entries(map).map(([aid, p]) => ({
    id: aid,
    name: p.displayName || aid.slice(0, 12) + '...',
  }));
});

const filteredAssignMembers = computed(() => {
  const q = assignMemberSearch.value.toLowerCase().trim();
  if (!q) return communityMembersList.value;
  return communityMembersList.value.filter(m => m.name.toLowerCase().includes(q));
});

const canSubmitAssign = computed(() => {
  if (assignMode.value === 'group') return !!assignSelectedGroup.value;
  if (assignMode.value === 'member') return !!assignSelectedMember.value;
  return !!assignSelectedMember.value;
});

const showInterestDialog = ref(false);
const showChangeDialog = ref(false);
const showEvidenceForm = ref(false);
const showReviewForm = ref(false);
const newEvidenceUrl = ref('');
const showOfferConfirmDialog = ref(false);
const pendingOfferContributor = ref<InterestedContributor | null>(null);

// File input template refs
const timeReportInput = ref<HTMLInputElement | null>(null);
const attachmentInput = ref<HTMLInputElement | null>(null);

// Forms
const evidenceForm = ref({
  completion_notes: '',
  evidence_urls: [''],
  actual_duration: undefined as number | undefined,
  acceptance_notes: [] as string[],
  time_report_files: [] as AttachedFile[],
  attachment_files: [] as AttachedFile[],
});

watch(() => props.contribution.id, () => {
  showEvidenceForm.value = false;
  showReviewForm.value = false;
  localChildren.value = [];
}, { immediate: false });

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

const interestNote = ref('');

// Role context
const role = computed(() => props.userRole as ProjectRole);
const isSteward = computed(() => ['community_admin', 'project_steward'].includes(props.userRole));
const isLead = computed(() => ['community_admin', 'project_lead'].includes(props.userRole));

// Child contributions — from allContributions prop + locally fetched children
const localChildren = ref<Contribution[]>([]);

const childContributions = computed<Contribution[]>(() => {
  const ids = props.contribution.child_contributions ?? [];
  if (!ids.length) return [];
  // Prefer allContributions (refreshed from API on archive/update). Fall back
  // to localChildren only when a child id is missing from allContributions
  // (e.g. just-created sub not yet in the parent fetch).
  const localMap = new Map((localChildren.value || []).map(c => [c.id, c]));
  return ids
    .map(id => props.allContributions.find(c => c.id === id) ?? localMap.get(id))
    .filter((c): c is Contribution => !!c)
    // Hide archived sub-contributions from the active sub-list.
    .filter(c => c.status !== 'archived');
});

// Fetch children that aren't in allContributions
watch(
  () => props.contribution.child_contributions,
  async (ids) => {
    if (!ids?.length) return;
    const missing = ids.filter(id => !props.allContributions.some(c => c.id === id));
    if (!missing.length) return;
    for (const id of missing) {
      try {
        const { getContribution } = await import('src/lib/api/contributions');
        const child = await getContribution(id);
        if (!localChildren.value.some(c => c.id === child.id)) {
          localChildren.value.push(child as unknown as Contribution);
        }
      } catch { /* ignore */ }
    }
  },
  { immediate: true },
);

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

// Assigned contributor — resolve from profiles store by AID
const profilesStore = useProfilesStore();
const assignedAid = computed(() =>
  props.contribution.assigned_contributor_id ?? props.contribution.assigned_contributor ?? null,
);
const assignedProfile = computed(() =>
  assignedAid.value ? profilesStore.profilesByAid[assignedAid.value] : null,
);
const assignedName = computed(() => {
  if (!assignedAid.value) return null;
  return assignedProfile.value?.displayName
    ?? props.contribution.assigned_contributor_name
    ?? assignedAid.value.slice(0, 12) + '...';
});
const assignedAvatar = computed(() => {
  const avatar = assignedProfile.value?.avatar;
  if (!avatar) return null;
  return avatar.startsWith('http') ? avatar : getFileUrl(avatar);
});
const assignedInitials = computed(() => {
  const name = assignedName.value;
  if (!name) return '?';
  return name.split(' ').map(w => w[0]).slice(0, 2).join('').toUpperCase();
});

// Evidence form validation
const canSubmitEvidence = computed(() => {
  if (!evidenceForm.value.completion_notes.trim()) return false;
  // All acceptance criteria must have responses if criteria exist
  const criteria = props.contribution.acceptance_criteria;
  if (criteria?.length) {
    const allFilled = criteria.every((_, idx) => evidenceForm.value.acceptance_notes[idx]?.trim());
    if (!allFilled) return false;
  }
  return true;
});

// Permission checks
const canConfirmNow = computed(() =>
  workflow.canConfirm(props.contribution, props.isPlanSignedOff, role.value),
);
const canShareNow = computed(() => workflow.canShare(props.contribution, role.value));
const canOfferNow = computed(() => workflow.canOffer(props.contribution, role.value));
const canRegister = computed(() =>
  workflow.canRegisterInterest(props.contribution, role.value, props.currentUserId),
);
const hasRegistered = computed(() =>
  props.contribution.interested_contributors?.some(ic => ic.user_id === props.currentUserId) ?? false,
);
const canAcceptOffer = computed(() =>
  workflow.canAccept(props.contribution, props.currentUserId),
);
const canSubmitEvidenceNow = computed(() =>
  workflow.canSubmitEvidence(
    props.contribution,
    props.currentUserId,
    allChildrenSignedOff.value,
    role.value,
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
    (props.contribution.evidence_urls?.length ?? 0) > 0 ||
    (props.contribution.acceptance_notes?.length ?? 0) > 0 ||
    !!props.contribution.time_report_file ||
    (props.contribution.attachment_files?.length ?? 0) > 0 ||
    !!props.contribution.actual_duration,
);
const hasReview = computed(() => !!props.contribution.review_outcome);


const outcomeOptions: { value: '' | 'approved' | 'incomplete' | 'declined'; label: string; icon: typeof ThumbsUp }[] = [
  { value: 'approved', label: 'Approve', icon: ThumbsUp },
  { value: 'incomplete', label: 'Send Back', icon: RefreshCw },
  { value: 'declined', label: 'Decline', icon: XCircle },
];

function formatFieldName(field: string): string {
  return field.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
}

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

async function handleConfirm() {
  actionLoading.value = 'confirm';
  try {
    const updated = await store.confirm(props.contribution.id);
    $q.notify({ type: 'positive', message: props.contribution.status === 'changed' ? 'Changes confirmed!' : 'Contribution confirmed!' });
    emit('update', updated as unknown as Contribution);
  } catch (e) {
    $q.notify({ type: 'negative', message: e instanceof Error ? e.message : 'Failed to confirm' });
  } finally {
    actionLoading.value = null;
  }
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

function openAssignDialog() {
  assignMode.value = null;
  assignSelectedGroup.value = null;
  assignSelectedMember.value = null;
  assignSelectedMemberName.value = null;
  assignMemberSearch.value = '';
  showAssignDialog.value = true;
}

function selectAssignMember(id: string, name: string) {
  assignSelectedMember.value = id;
  assignSelectedMemberName.value = name;
  assignMode.value = 'member';
  assignSelectedGroup.value = null;
}

async function submitAssign() {
  assigningContribution.value = true;
  try {
    if (assignMode.value === 'group' && assignSelectedGroup.value) {
      const updated = await store.share(props.contribution.id, {
        shared_with_roles: [assignSelectedGroup.value],
      });
      $q.notify({ type: 'positive', message: 'Contribution shared with group!' });
      emit('update', updated as unknown as Contribution);
    } else if (assignSelectedMember.value) {
      const updated = await store.offer(props.contribution.id, {
        offered_to: assignSelectedMember.value,
        offered_to_name: assignSelectedMemberName.value || assignSelectedMember.value,
      });
      $q.notify({ type: 'positive', message: 'Contribution assigned to member!' });
      emit('update', updated as unknown as Contribution);
    }
    showAssignDialog.value = false;
  } catch (e) {
    $q.notify({ type: 'negative', message: e instanceof Error ? e.message : 'Failed to assign' });
  } finally {
    assigningContribution.value = false;
  }
}

function confirmOfferToContributor(ic: InterestedContributor) {
  pendingOfferContributor.value = ic;
  showOfferConfirmDialog.value = true;
}

async function handleConfirmedOffer() {
  const ic = pendingOfferContributor.value;
  if (!ic) return;
  showOfferConfirmDialog.value = false;
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
    pendingOfferContributor.value = null;
  }
}

async function handleRegisterInterest() {
  actionLoading.value = 'register';
  try {
    const updated = await store.registerInterest(props.contribution.id, {
      interest_note: interestNote.value.trim(),
      user_name: props.currentUserName || undefined,
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

function resolveFileUrl(f: Record<string, string>): string {
  if (f.file_ref) return getFileUrl(f.file_ref);
  if (f.url) return f.url;
  return '#';
}

function fileIcon(mimeType?: string): string {
  if (!mimeType) return 'description';
  if (mimeType.includes('pdf')) return 'picture_as_pdf';
  if (mimeType.includes('spreadsheet') || mimeType.includes('csv') || mimeType.includes('excel')) return 'table_chart';
  if (mimeType.includes('word') || mimeType.includes('document')) return 'article';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'videocam';
  return 'description';
}

const uploadingFiles = ref(false);

function toBackendFileRef(f: AttachedFile): Record<string, string> {
  return {
    file_ref: f.file_ref || f.url,
    file_name: f.name,
    content_type: f.type,
  };
}

async function handleTimeReportUpload(files: FileList | File[]) {
  uploadingFiles.value = true;
  try {
    for (const file of Array.from(files)) {
      const result = await uploadFile(file);
      if (result.fileRef) {
        evidenceForm.value.time_report_files.push({
          name: file.name,
          url: getFileUrl(result.fileRef),
          type: file.type,
          file_ref: result.fileRef,
        });
      } else {
        $q.notify({ type: 'negative', message: result.error || `Failed to upload ${file.name}` });
      }
    }
  } finally {
    uploadingFiles.value = false;
  }
}

async function handleAttachmentUpload(files: FileList | File[]) {
  uploadingFiles.value = true;
  try {
    for (const file of Array.from(files)) {
      const result = await uploadFile(file);
      if (result.fileRef) {
        evidenceForm.value.attachment_files.push({
          name: file.name,
          url: getFileUrl(result.fileRef),
          type: file.type,
          file_ref: result.fileRef,
        });
      } else {
        $q.notify({ type: 'negative', message: result.error || `Failed to upload ${file.name}` });
      }
    }
  } finally {
    uploadingFiles.value = false;
  }
}

function removeTimeReport(idx: number) {
  evidenceForm.value.time_report_files.splice(idx, 1);
}

function removeAttachment(idx: number) {
  evidenceForm.value.attachment_files.splice(idx, 1);
}

async function handleSubmitEvidence() {
  if (!canSubmitEvidence.value) return;
  actionLoading.value = 'submit-evidence';
  try {
    const updated = await store.submitEvidence(props.contribution.id, {
      completion_notes: evidenceForm.value.completion_notes.trim(),
      evidence_urls: evidenceForm.value.evidence_urls.filter((u) => u.trim()),
      actual_duration: evidenceForm.value.actual_duration,
      acceptance_notes: evidenceForm.value.acceptance_notes.filter((n) => n.trim()),
      time_report_file: evidenceForm.value.time_report_files[0] ? toBackendFileRef(evidenceForm.value.time_report_files[0]) as any : undefined,
      attachment_files: evidenceForm.value.attachment_files.length ? evidenceForm.value.attachment_files.map(f => toBackendFileRef(f)) as any : undefined,
    });
    $q.notify({ type: 'positive', message: 'Submitted for review!' });
    showEvidenceForm.value = false;
    evidenceForm.value = { completion_notes: '', evidence_urls: [''], actual_duration: undefined, acceptance_notes: [], time_report_files: [], attachment_files: [] };
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
      decision: reviewForm.value.outcome as 'approved' | 'incomplete' | 'declined',
      review_notes: reviewForm.value.feedback.trim() || undefined,
      quality_rating: reviewForm.value.quality_rating,
    });
    $q.notify({ type: 'positive', message: 'Review submitted!' });
    showReviewForm.value = false;
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

function updateLocalChild(updated: Contribution) {
  const list = localChildren.value || [];
  localChildren.value = [...list.filter(c => c.id !== updated.id), updated];
}

function handleChildUpdate(updated: Contribution) {
  updateLocalChild(updated);
  emit('update', updated);
  // Re-bind selectedChildContribution to the updated reference so the nested
  // dialog re-renders with the new status (review → approved → sign-off panel
  // appears, etc.). Keep the dialog open so multi-step workflows like
  // review-then-signoff can run in the same dialog.
  if (selectedChildContribution.value?.id === updated.id) {
    selectedChildContribution.value = updated;
  }
}

async function handleApproveSub(subId: string) {
  actionLoading.value = `approve-sub-${subId}`;
  try {
    const updated = await store.approveSub(subId);
    $q.notify({ type: 'positive', message: 'Sub-contribution approved and assigned!' });
    updateLocalChild(updated as unknown as Contribution);
    emit('update', updated as unknown as Contribution);
  } catch (e) {
    $q.notify({ type: 'negative', message: e instanceof Error ? e.message : 'Approve failed' });
  } finally {
    actionLoading.value = null;
  }
}

function computeDiff(updates: Record<string, unknown>): { field: string; old_value: string; new_value: string }[] {
  const diffs: { field: string; old_value: string; new_value: string }[] = [];
  const c = props.contribution;
  const fieldMap: Record<string, unknown> = {
    title: c.title,
    description: c.description,
    objectives: c.objectives,
    deliverables: c.deliverables,
    acceptance_criteria: c.acceptance_criteria,
    skill_requirements: c.skill_requirements,
    estimated_hours: c.estimated_hours,
    budget: c.budget,
  };
  for (const [key, newVal] of Object.entries(updates)) {
    if (newVal === undefined) continue;
    const oldVal = fieldMap[key];
    const oldStr = Array.isArray(oldVal) ? oldVal.join(', ') : String(oldVal ?? '');
    const newStr = Array.isArray(newVal) ? (newVal as string[]).join(', ') : String(newVal ?? '');
    if (oldStr !== newStr) {
      diffs.push({ field: key, old_value: oldStr, new_value: newStr });
    }
  }
  return diffs;
}

async function handleChange(data: { updates: Record<string, unknown>; reason: string }) {
  actionLoading.value = 'change';
  try {
    // Compute diff before updating
    const diff = computeDiff(data.updates);

    // Include change tracking fields in the update
    const updatesWithTracking = {
      ...data.updates,
      change_reason: data.reason,
      changed_by: props.currentUserId,
      changed_at: new Date().toISOString(),
      changes_diff: diff,
    };

    const updated = await store.update(props.contribution.id, updatesWithTracking as any);
    // Project lead edits require re-confirmation; steward/admin edits stay assigned
    if (role.value === 'project_lead') {
      const transitioned = await store.transition(props.contribution.id, 'changed');
      emit('update', transitioned);
    } else {
      emit('update', updated);
    }
    showChangeDialog.value = false;
    $q.notify({ type: 'positive', message: role.value === 'project_lead' ? 'Contribution updated — needs re-confirmation' : 'Contribution updated' });
  } catch (err) {
    console.error('[ContribDetail] change failed:', err);
    $q.notify({ type: 'negative', message: 'Failed to update contribution' });
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
  border-radius: 12px;
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

.assigned-avatar {
  position: absolute;
  right: 12px;
  top: 48px;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  overflow: hidden;
  flex-shrink: 0;
  cursor: default;
  background: var(--matou-primary);
  display: flex;
  align-items: center;
  justify-content: center;
}

.avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.avatar-initials {
  font-size: 0.8rem;
  font-weight: 600;
  color: white;
  letter-spacing: 0.03em;
}

.header-title {
  font-size: 1.4rem;
  font-weight: 700;
  margin: 0 0 6px;
  color: var(--matou-foreground);
  line-height: 1.25;
  padding-right: 40px;
}

.close-btn {
  position: absolute;
  top: 12px;
  right: 12px;
}

.edit-btn {
  position: absolute;
  bottom: 10px;
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
  width: 100%;

  .footer-btn {
    flex: 1;
    min-width: 0;
    border-radius: 8px;
    padding: 10px 20px;
    margin: 10px 0;
  }
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
.description-section {
  padding: 0 18px;

  .section-text {
    color: var(--matou-muted-foreground);
  }
}

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
.sub-contributions-section {
  background: rgba(74, 157, 156, 0.04);
  border: 1px solid rgba(74, 157, 156, 0.15);
  border-radius: var(--matou-radius);
  padding: 14px 18px;
}

.sub-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 1rem 0;
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

.register-interest-btn {
  border-radius: 10px;
}

// ── Changes panel ─────────────────────────────────────────────────────────

.changes-panel {
  background: rgba(234, 179, 8, 0.06);
  border: 1px solid rgba(234, 179, 8, 0.3);
  border-radius: var(--matou-radius-sm, 8px);
  padding: 14px 16px;
  margin-bottom: 12px;
}

.changes-panel-header {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-bottom: 12px;
}

.changes-icon {
  color: #ca8a04;
  flex-shrink: 0;
}

.changes-diff-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.changes-diff-item {
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius-sm, 6px);
  padding: 10px 12px;
  background: var(--matou-card);
}

.diff-field {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--matou-foreground);
  margin-bottom: 6px;
}

.diff-values {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.diff-old {
  font-size: 0.8rem;
  color: var(--matou-muted-foreground);
  text-decoration: line-through;
  opacity: 0.7;
}

.diff-new {
  font-size: 0.8rem;
  color: var(--matou-foreground);
}

.diff-label {
  font-weight: 600;
  margin-right: 4px;
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.approve-sub-btn {
  padding: 4px 20px;
  border-radius: 10px;
  font-size: 0.85rem;
}

.add-sub-btn {
  padding: 6px 24px;
  border-radius: 10px;
  font-size: 0.85rem;
}

.offer-interested-btn {
  padding: 4px 20px;
  border-radius: var(--matou-radius-sm, 8px);
  font-size: 0.85rem;
}

// Unified button row for all dialogs and footers
.dialog-btn-row {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.dialog-btn-half {
  flex: 1;
  border-radius: 10px;
}

// Footer action buttons (full-width, stacked)
.footer-action-btn {
  width: 100%;
  border-radius: 10px;
  margin-top: 4px;
  margin-bottom: 4px;
}

// ── Submit Completion Form ────────────────────────────────────────────────────

.submit-completion-form {
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius);
  padding: 20px;
  margin-top: 16px;
  background: var(--matou-card);
}

.completion-form-title {
  font-size: 1rem;
  font-weight: 600;
  margin: 0 0 16px;
  color: var(--matou-foreground);
}

.completion-field {
  margin-bottom: 16px;
}

.completion-field-label {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--matou-foreground);
  margin-bottom: 6px;
}

.criterion-block {
  margin-bottom: 10px;
}

.criterion-label {
  font-size: 0.8rem;
  color: var(--matou-muted-foreground);
  margin-bottom: 4px;
}

.evidence-url-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.evidence-url-input {
  flex: 1;
}

.evidence-url-add-btn {
  border-radius: 10px;
}

// ── Evidence display ──────────────────────────────────────────────────────

.evidence-field {
  margin-bottom: 14px;
}

.evidence-field-label {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--matou-muted-foreground);
  margin-bottom: 4px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.evidence-field-value {
  font-size: 0.875rem;
  color: var(--matou-foreground);
  line-height: 1.5;
}

.evidence-criterion-item {
  padding: 8px 12px;
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius-sm, 6px);
  margin-bottom: 6px;
  background: var(--matou-secondary);
}

.evidence-criterion-label {
  font-size: 0.78rem;
  font-weight: 500;
  color: var(--matou-muted-foreground);
  margin-bottom: 2px;
}

.evidence-criterion-response {
  font-size: 0.85rem;
  color: var(--matou-foreground);
}

.evidence-files-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.evidence-file-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: 1px solid var(--matou-border);
  border-radius: 12px;
  font-size: 0.78rem;
  color: var(--matou-primary);
  background: var(--matou-secondary);
  text-decoration: none;
  transition: border-color 0.12s ease;

  &:hover {
    border-color: var(--matou-primary);
  }
}

// ── Decision buttons (review form) ───────────────────────────────────────

.decision-btns {
  display: flex;
  gap: 8px;
}

.decision-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius-sm, 8px);
  background: transparent;
  cursor: pointer;
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--matou-muted-foreground);
  transition: all 0.12s ease;

  &:hover {
    border-color: var(--matou-accent);
  }

  &.approved.active {
    border-color: #059669;
    background: rgba(16, 185, 129, 0.08);
    color: #059669;
  }

  &.incomplete.active {
    border-color: #d97706;
    background: rgba(245, 158, 11, 0.08);
    color: #d97706;
  }

  &.declined.active {
    border-color: var(--matou-destructive, #c8463a);
    background: rgba(200, 70, 58, 0.08);
    color: var(--matou-destructive, #c8463a);
  }
}

.decision-btn-icon {
  width: 16px;
  height: 16px;
}

// ── Assign dialog ─────────────────────────────────────────────────────────

.assign-dialog {
  min-width: 460px;
  max-width: 540px;
}

.assign-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-height: 60vh;
  overflow-y: auto;
}

.assign-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.assign-section-label {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--matou-muted-foreground);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

.assign-mode-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.assign-mode-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 16px 12px;
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius-sm, 8px);
  background: var(--matou-card);
  cursor: pointer;
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--matou-muted-foreground);
  transition: all 0.12s ease;

  &:hover {
    border-color: var(--matou-accent);
    background: var(--matou-secondary);
  }

  &.active {
    border-color: var(--matou-primary);
    background: rgba(30, 95, 116, 0.06);
    color: var(--matou-primary);
  }
}

.assign-member-list {
  max-height: 240px;
  overflow-y: auto;
}

.assign-member-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius-sm, 8px);
  cursor: pointer;
  transition: all 0.12s ease;
  margin-bottom: 4px;

  &:hover {
    border-color: var(--matou-accent);
    background: var(--matou-secondary);
  }

  &.selected {
    border-color: var(--matou-primary);
    background: rgba(30, 95, 116, 0.06);
  }
}

.assign-member-name {
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--matou-foreground);
}

.assign-member-note {
  font-size: 0.75rem;
  color: var(--matou-muted-foreground);
  margin-top: 2px;
}

.assign-empty {
  text-align: center;
  padding: 16px;
  color: var(--matou-muted-foreground);
  font-size: 0.85rem;
}

.evidence-url-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  font-size: 0.8rem;
  color: var(--matou-muted-foreground);
  margin-top: 4px;
}

.evidence-url-text {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-uploads-row {
  display: flex;
  gap: 16px;
  margin-bottom: 16px;
}

.file-upload-col {
  flex: 1;
  min-width: 0;
}

.file-thumbs-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: flex-start;
}

.file-thumb {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 80px;
  padding: 8px 4px 6px;
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius-sm, 6px);
  background: var(--matou-secondary);
  overflow: hidden;
}

.file-thumb-img {
  width: 48px;
  height: 48px;
  object-fit: cover;
  border-radius: 4px;
}

.file-thumb-icon {
  color: var(--matou-muted-foreground);
  margin-bottom: 2px;
}

.file-thumb-name {
  font-size: 0.65rem;
  color: var(--matou-muted-foreground);
  text-align: center;
  width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-top: 4px;
}

.file-thumb-remove {
  position: absolute;
  top: 2px;
  right: 2px;
}

.file-add-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  width: 80px;
  height: 80px;
  border: 1px dashed var(--matou-border);
  border-radius: var(--matou-radius-sm, 6px);
  background: transparent;
  cursor: pointer;
  color: var(--matou-muted-foreground);
  font-size: 0.7rem;
  transition: all 0.12s ease;

  &:hover {
    border-color: var(--matou-primary);
    color: var(--matou-primary);
  }
}

.registered-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 16px;
  border-radius: 10px;
  background: rgba(16, 185, 129, 0.08);
  border: 1px solid rgba(16, 185, 129, 0.3);
  color: #059669;
  font-size: 0.85rem;
  font-weight: 500;
}
</style>
