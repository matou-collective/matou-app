<template>
  <q-dialog :model-value="modelValue" @update:model-value="$emit('update:modelValue', $event)">
    <q-card style="min-width: 500px; max-width: 600px">
      <q-card-section class="row items-center q-pb-none">
        <div class="row items-center q-gutter-sm">
          <q-icon :name="getActionIcon(action.action_type)" size="22px" color="primary" />
          <span class="text-h6">
            {{ formatLabel(action.action_type) }} &mdash; {{ formatHouse(action.house) }}
          </span>
        </div>
        <q-space />
        <q-btn icon="close" flat round dense v-close-popup />
      </q-card-section>

      <q-card-section class="q-pt-md modal-body">
        <!-- Title -->
        <div v-if="action.title" class="text-subtitle1 text-weight-medium q-mb-sm">{{ action.title }}</div>

        <p class="text-body1 q-mb-md">{{ action.description }}</p>

        <!-- ── Meeting / Discussion ───────────────────────────────────────── -->
        <template v-if="action.action_type === 'meeting' || action.action_type === 'discussion'">
          <div v-if="action.meeting_date" class="detail-card">
            <div class="detail-row">
              <q-icon name="event" size="16px" color="primary" />
              <span>
                {{ action.meeting_date }}{{ action.meeting_time ? ' at ' + action.meeting_time : '' }}
              </span>
            </div>
            <div v-if="action.meeting_location" class="detail-row">
              <q-icon name="location_on" size="16px" color="primary" />
              <span>{{ action.meeting_location }}</span>
            </div>
          </div>

          <!-- Completed / archived state -->
          <template v-if="action.status === 'completed'">
            <div class="completed-badge completed-badge--positive q-mt-md">
              <q-icon name="check_circle" />
              <span>Completed</span>
            </div>
            <CompletionDetails :action="action" />
          </template>
          <template v-else-if="action.status === 'archived'">
            <div class="completed-badge completed-badge--archived q-mt-md">
              <q-icon name="archive" />
              <span>Archived</span>
            </div>
            <CompletionDetails :action="action" />
          </template>

          <!-- Completion form (shown for managers on open actions) -->
          <template v-else-if="canManage">
            <div v-if="!canCompleteAction" class="voting-locked q-mt-md">
              <q-icon name="lock" size="20px" />
              <div>
                <div class="text-weight-bold">Plan Sign-Off Required</div>
                <div class="text-caption">
                  The decision plan must be signed off before this action can be completed.
                </div>
              </div>
            </div>
            <div class="completion-fields q-mt-md">
              <div class="completion-field">
                <div class="completion-field-label">Notes *</div>
                <q-input
                  v-model="notes"
                  type="textarea"
                  outlined
                  autogrow
                  input-style="min-height: 4.5em"
                  placeholder="Summarize what happened, key decisions, and outcomes..."
                />
              </div>

              <div class="completion-field">
                <div class="completion-field-label">Notes URLs</div>
                <div class="evidence-url-row">
                  <q-input
                    v-model="newLink"
                    outlined
                    dense
                    placeholder="https://..."
                    class="evidence-url-input"
                    @keyup.enter="addLink"
                  />
                  <q-btn
                    unelevated
                    no-caps
                    icon="link"
                    label="Add"
                    color="primary"
                    class="evidence-url-add-btn"
                    :disable="!newLink.trim()"
                    @click="addLink"
                  />
                </div>
                <div v-for="(url, i) in links" :key="i" class="evidence-url-item">
                  <q-icon name="link" size="14px" />
                  <span class="evidence-url-text">{{ url }}</span>
                  <q-btn flat round dense icon="close" size="xs" @click="links.splice(i, 1)" />
                </div>
              </div>

              <div class="completion-field">
                <div class="completion-field-label">Attachments</div>
                <div class="file-thumbs-row">
                  <div
                    v-for="(f, idx) in files"
                    :key="'f-' + idx"
                    class="file-thumb"
                  >
                    <img v-if="f.content_type?.startsWith('image/')" :src="getFileUrl(f.file_ref)" class="file-thumb-img" />
                    <q-icon v-else :name="fileIcon(f.content_type)" size="28px" class="file-thumb-icon" />
                    <div class="file-thumb-name">{{ f.file_name }}</div>
                    <q-btn flat round dense icon="close" size="xs" class="file-thumb-remove" @click="files.splice(idx, 1)" />
                  </div>
                  <button class="file-add-btn" :disabled="uploading" @click="fileInputEl?.click()">
                    <q-spinner-dots v-if="uploading" size="20px" />
                    <q-icon v-else name="upload_file" size="24px" />
                    <span>{{ uploading ? 'Uploading...' : 'Add' }}</span>
                  </button>
                  <input ref="fileInputEl" type="file" multiple style="display: none" @change="handleUpload" />
                </div>
              </div>
            </div>
          </template>
        </template>

        <!-- ── Decision / Vote ───────────────────────────────────────────── -->
        <template v-if="action.action_type === 'decision'">
          <!-- Linked action info -->
          <div v-if="linkedAction" class="detail-card q-mb-md">
            <div class="text-caption text-weight-bold q-mb-xs text-grey">Linked to:</div>
            <div class="detail-row">
              <q-icon :name="getActionIcon(linkedAction.action_type)" size="16px" color="primary" />
              <span class="ellipsis">{{ linkedAction.description }}</span>
              <span class="status-badge" :class="`status-badge--${linkedAction.status}`">
                {{ linkedAction.status }}
              </span>
            </div>
          </div>

          <!-- Voting not yet open -->
          <div v-if="votingNotOpen" class="voting-locked">
            <q-icon name="schedule" size="20px" />
            <div>
              <div class="text-weight-bold">Voting Not Yet Open</div>
              <div class="text-caption">
                Voting begins when the proposal moves to the voting process.
              </div>
            </div>
          </div>

          <!-- Voting locked (linked meeting not complete) -->
          <div v-else-if="votingLocked" class="voting-locked">
            <q-icon name="lock" size="20px" />
            <div>
              <div class="text-weight-bold">Voting Locked</div>
              <div class="text-caption">
                The linked meeting must be completed before voting can begin.
              </div>
            </div>
          </div>

          <!-- Vote form (comment + vote buttons in footer) -->
          <template v-else-if="action.status !== 'completed' && action.status !== 'archived'">
            <!-- Voting deadline -->
            <div v-if="action.voting_end_date" class="detail-card q-mb-md">
              <div class="detail-row">
                <q-icon name="timer" size="16px" color="warning" />
                <span>Voting ends: {{ action.voting_end_date }}{{ action.voting_end_time ? ' at ' + action.voting_end_time : '' }}</span>
                <span v-if="isVotingExpired" class="voting-result-badge voting-result-badge--negative">Expired</span>
              </div>
            </div>

            <!-- Already voted indicator -->
            <div v-if="hasVoted" class="completed-badge completed-badge--positive q-mb-md">
              <q-icon name="check_circle" />
              <span>You voted: {{ formatOutcome(myVote!) }}</span>
            </div>

            <!-- Vote comment input (only if not yet voted) -->
            <div v-if="!hasVoted" class="completion-fields q-mt-md">
              <div class="completion-field">
                <div class="completion-field-label">Comment</div>
                <q-input
                  v-model="notes"
                  type="textarea"
                  outlined
                  autogrow
                  input-style="min-height: 4.5em"
                  placeholder="Feel free to add a comment about your decision"
                />
              </div>
            </div>
          </template>

          <!-- Completed outcome -->
          <template v-else>
            <div
              class="completed-badge q-mt-md"
              :class="action.status === 'archived' ? 'completed-badge--archived' : (outcomePositive ? 'completed-badge--positive' : 'completed-badge--negative')"
            >
              <q-icon :name="action.status === 'archived' ? 'archive' : (outcomePositive ? 'check_circle' : 'cancel')" />
              <span>{{ action.status === 'archived' ? 'Archived' : (action.outcome ? formatOutcome(action.outcome) : 'Decided') }}</span>
            </div>
            <CompletionDetails :action="action" />
          </template>

          <!-- Voting Results Summary -->
          <div v-if="completedDecisions.length > 0 || action.votes?.length" class="voting-results q-mt-md">
            <div class="voting-results-header">
              <q-icon name="how_to_vote" size="16px" />
              <span class="text-weight-medium">Voting Results</span>
            </div>

            <!-- Totals -->
            <div class="voting-totals">
              <div class="voting-total voting-total--positive">
                <q-icon name="thumb_up" size="16px" />
                <span>{{ approvedCount }} Approved</span>
              </div>
              <div class="voting-total voting-total--negative">
                <q-icon name="thumb_down" size="16px" />
                <span>{{ rejectedCount }} Declined</span>
              </div>
            </div>

            <!-- House results -->
            <div v-for="d in completedDecisions" :key="d.id" class="voting-result-row">
              <span class="voting-result-house">{{ formatHouse(d.house) }}</span>
              <span
                class="voting-result-badge"
                :class="d.outcome === 'approved' || d.outcome === 'no_veto' ? 'voting-result-badge--positive' : 'voting-result-badge--negative'"
              >
                {{ d.outcome ? formatOutcome(d.outcome) : 'Pending' }}
              </span>
            </div>
            <div v-for="house in pendingHouses" :key="house" class="voting-result-row">
              <span class="voting-result-house">{{ formatHouse(house) }}</span>
              <span class="voting-result-badge voting-result-badge--pending">Pending</span>
            </div>

            <!-- Individual vote comments -->
            <template v-if="allVotes.length > 0">
              <div class="vote-comments-header">Comments</div>
              <div v-for="(v, i) in allVotes" :key="i" class="vote-comment">
                <div class="vote-comment-header">
                  <div class="vote-comment-avatar">
                    <q-icon name="person" size="14px" />
                  </div>
                  <span class="vote-comment-name">{{ v.voter_name || v.voter_id }}</span>
                  <span
                    class="voting-result-badge"
                    :class="v.decision === 'approved' || v.decision === 'no_veto' ? 'voting-result-badge--positive' : 'voting-result-badge--negative'"
                  >
                    {{ formatOutcome(v.decision) }}
                  </span>
                </div>
                <p v-if="v.comment" class="vote-comment-text">{{ v.comment }}</p>
              </div>
            </template>
          </div>
        </template>
      </q-card-section>

      <!-- ── Footer ──────────────────────────────────────────────────────── -->
      <div class="dialog-footer">
        <template v-if="canManage && isActionOpen && !isDecision">
          <!-- Meeting/Discussion: Mark as Complete + Archive -->
          <q-btn
            no-caps
            label="Mark as Complete"
            color="positive"
            icon="check_circle"
            class="dialog-footer-btn"
            :disable="!notes.trim() || !canCompleteAction"
            :loading="submitting"
            @click="submitComplete()"
          />
          <q-btn
            outline
            no-caps
            label="Archive"
            color="warning"
            icon="archive"
            class="dialog-footer-btn"
            :disable="!notes.trim()"
            :loading="submitting"
            @click="submitArchive()"
          />
        </template>
        <template v-else-if="isDecision && isActionOpen">
          <!-- Decision: vote buttons (only if not yet voted) -->
          <template v-if="!hasVoted">
            <template v-if="action.house === 'elders_council'">
              <q-btn
                outline no-caps label="No Veto" color="positive" icon="thumb_up"
                class="dialog-footer-btn"
                :disable="submitting" :loading="submitting"
                @click="submitVote('no_veto')"
              />
              <q-btn
                outline no-caps label="Veto" color="negative" icon="block"
                class="dialog-footer-btn"
                :disable="submitting" :loading="submitting"
                @click="submitVote('veto')"
              />
            </template>
            <template v-else>
              <q-btn
                outline no-caps label="Approve" color="positive" icon="thumb_up"
                class="dialog-footer-btn"
                :disable="submitting" :loading="submitting"
                @click="submitVote('approved')"
              />
              <q-btn
                outline no-caps label="Reject" color="negative" icon="thumb_down"
                class="dialog-footer-btn"
                :disable="submitting" :loading="submitting"
                @click="submitVote('rejected')"
              />
            </template>
          </template>
          <!-- Manager: Close Voting button -->
          <q-btn
            v-if="canManage && (action.votes?.length ?? 0) > 0"
            no-caps
            label="Close Voting"
            color="primary"
            icon="gavel"
            class="dialog-footer-btn"
            :disable="submitting"
            :loading="submitting"
            @click="submitResolve()"
          />
          <q-btn v-if="hasVoted && !canManage" outline no-caps label="Close" color="primary" class="dialog-footer-btn" v-close-popup />
        </template>
        <template v-else>
          <q-btn outline no-caps label="Close" color="primary" class="dialog-footer-btn" v-close-popup />
        </template>
      </div>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch, h as createVNode } from 'vue';
import { useQuasar } from 'quasar';
import type { GovernanceAction } from 'src/lib/api/decisionPlans';
import { uploadFile, getFileUrl } from 'src/lib/api/client';
import { useIdentityStore } from 'stores/identity';

// ── CompletionDetails sub-component ──────────────────────────────────────────

const CompletionDetails = {
  name: 'CompletionDetails',
  props: {
    action: { type: Object, required: true },
  },
  setup(props: { action: GovernanceAction }) {
    return () => {
      const a = props.action;
      if (!a.completion_notes && !(a.completion_files?.length) && !(a.completion_links?.length)) return null;

      const children = [];
      children.push(
        createVNode('div', { class: 'completion-details-header' }, [
          createVNode('span', { class: 'q-icon notranslate material-icons', style: 'font-size: 16px' }, 'description'),
          createVNode('span', { class: 'text-weight-medium', style: 'margin-left: 6px' }, 'Notes'),
        ]),
      );
      if (a.completion_notes) {
        children.push(createVNode('p', { class: 'completion-notes-text' }, a.completion_notes));
      }
      const attachChildren: ReturnType<typeof createVNode>[] = [];
      for (const link of a.completion_links || []) {
        attachChildren.push(
          createVNode('a', { href: link, target: '_blank', rel: 'noopener', class: 'completion-link' }, [
            createVNode('span', { class: 'q-icon notranslate material-icons', style: 'font-size: 14px' }, 'link'),
            createVNode('span', null, link),
          ]),
        );
      }
      for (const f of a.completion_files || []) {
        attachChildren.push(
          createVNode('a', { href: getFileUrl(f.file_ref), target: '_blank', rel: 'noopener', class: 'completion-link' }, [
            createVNode('span', { class: 'q-icon notranslate material-icons', style: 'font-size: 14px' }, 'description'),
            createVNode('span', null, f.file_name),
          ]),
        );
      }
      if (attachChildren.length) {
        children.push(createVNode('div', { class: 'completion-attachments' }, attachChildren));
      }

      return createVNode('div', { class: 'completion-details q-mt-md' }, children);
    };
  },
};

// ── Component interface ──────────────────────────────────────────────────────

const props = defineProps<{
  modelValue: boolean;
  action: GovernanceAction;
  allActions: GovernanceAction[];
  proposalStatus?: string;
  decisionPlanStatus?: string;
  canManage?: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  complete: [actionId: string, data: { outcome?: string; completion_notes: string; completion_files?: unknown[]; completion_links?: string[] }];
  archive: [actionId: string, data: { completion_notes: string; completion_files?: unknown[]; completion_links?: string[] }];
  vote: [actionId: string, decision: string, comment: string];
  resolve: [actionId: string];
}>();

// ── State ────────────────────────────────────────────────────────────────────

const $q = useQuasar();
const identityStore = useIdentityStore();
const showForm = ref(false);
const formMode = ref<'complete' | 'archive'>('complete');
const submitting = ref(false);

// Reset loading state when the parent swaps in a refreshed action object after
// vote/complete/archive/resolve completes.
watch(
  () => props.action,
  () => {
    submitting.value = false;
  },
);
const notes = ref('');
const newLink = ref('');
const links = ref<string[]>([]);
const files = ref<{ file_ref: string; file_name: string; content_type: string; size: number; category: string; uploaded_by: string; uploaded_at: string }[]>([]);
const uploading = ref(false);
const fileInputEl = ref<HTMLInputElement | null>(null);

// ── Computed ─────────────────────────────────────────────────────────────────

const linkedAction = computed<GovernanceAction | null>(() => {
  if (!props.action.linked_action_id) return null;
  return props.allActions.find((a) => a.id === props.action.linked_action_id) ?? null;
});

const votingLocked = computed<boolean>(() => {
  if (!linkedAction.value) return false;
  return linkedAction.value.status !== 'completed';
});

const votingNotOpen = computed<boolean>(() => {
  if (props.action.action_type !== 'decision') return false;
  // Don't block if the action is already completed/archived — always show results
  if (props.action.status === 'completed' || props.action.status === 'archived') return false;
  // Don't block if proposal has passed through voting (approved/rejected)
  if (['voting_process', 'approved', 'rejected'].includes(props.proposalStatus ?? '')) return false;
  return true;
});

const outcomePositive = computed<boolean>(() => {
  const o = props.action.outcome;
  return o === 'approved' || o === 'no_veto';
});

const isActionOpen = computed(() => props.action.status === 'planned');
const isDecision = computed(() => props.action.action_type === 'decision' && !votingNotOpen.value && !votingLocked.value);
const canCompleteAction = computed(() => props.decisionPlanStatus === 'signed_off');

const currentAID = computed(() => identityStore.currentAID?.prefix ?? '');
const hasVoted = computed(() => (props.action.votes ?? []).some((v) => v.voter_id === currentAID.value));
const myVote = computed(() => (props.action.votes ?? []).find((v) => v.voter_id === currentAID.value)?.decision);

const isVotingExpired = computed(() => {
  if (!props.action.voting_end_date) return false;
  const endStr = props.action.voting_end_date + 'T' + (props.action.voting_end_time || '23:59');
  return new Date(endStr) < new Date();
});

type HouseValue = GovernanceAction['house'];
const HOUSE_ORDER: HouseValue[] = ['elders_council', 'community_reps', 'contributors'];

const housesInPlan = computed<HouseValue[]>(() => {
  const set = new Set<HouseValue>(
    props.allActions
      .filter((a) => a.action_type === 'decision')
      .map((a) => a.house),
  );
  return HOUSE_ORDER.filter((h) => set.has(h));
});

const completedDecisions = computed(() =>
  props.allActions.filter((a) => a.action_type === 'decision' && a.status === 'completed'),
);

const pendingHouses = computed(() => {
  const decided = new Set(completedDecisions.value.map((a) => a.house));
  return housesInPlan.value.filter((h) => !decided.has(h));
});

const approvedCount = computed(
  () =>
    (props.action.votes ?? []).filter(
      (v) => v.decision === 'approved' || v.decision === 'no_veto',
    ).length,
);

const rejectedCount = computed(
  () =>
    (props.action.votes ?? []).filter(
      (v) => v.decision === 'rejected' || v.decision === 'veto',
    ).length,
);

const allVotes = computed(() =>
  completedDecisions.value.flatMap((d) => d.votes ?? []).filter((v) => v.comment),
);

// ── Helpers ───────────────────────────────────────────────────────────────────

function getActionIcon(type: GovernanceAction['action_type']): string {
  switch (type) {
    case 'discussion': return 'chat';
    case 'meeting': return 'event';
    case 'decision': return 'how_to_vote';
  }
}

function formatLabel(raw: string): string {
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function formatHouse(house: string): string {
  return house.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
}

function formatOutcome(outcome: string): string {
  return outcome.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
}

function addLink() {
  const url = newLink.value.trim();
  if (url) {
    links.value.push(url);
    newLink.value = '';
  }
}

function fileIcon(mimeType: string): string {
  if (!mimeType) return 'description';
  if (mimeType.includes('pdf')) return 'picture_as_pdf';
  if (mimeType.includes('spreadsheet') || mimeType.includes('csv')) return 'table_chart';
  if (mimeType.includes('word') || mimeType.includes('document')) return 'article';
  if (mimeType.startsWith('image/')) return 'image';
  return 'description';
}

async function handleUpload(e: Event) {
  const input = e.target as HTMLInputElement;
  if (!input.files?.length) return;
  uploading.value = true;
  try {
    for (const file of Array.from(input.files)) {
      const result = await uploadFile(file);
      if (result.fileRef) {
        files.value.push({
          file_ref: result.fileRef,
          file_name: file.name,
          content_type: file.type,
          size: file.size,
          category: 'completion_notes',
          uploaded_by: '',
          uploaded_at: new Date().toISOString(),
        });
      } else {
        $q.notify({ type: 'negative', message: result.error || `Failed to upload ${file.name}` });
      }
    }
  } finally {
    uploading.value = false;
    if (input) input.value = '';
  }
}

function buildData() {
  return {
    completion_notes: notes.value.trim(),
    completion_files: files.value.length ? [...files.value] : undefined,
    completion_links: links.value.length ? [...links.value] : undefined,
  };
}

// ── Handlers ─────────────────────────────────────────────────────────────────

function submitComplete() {
  if (!notes.value.trim()) {
    $q.notify({ type: 'negative', message: 'Notes are required' });
    return;
  }
  submitting.value = true;
  emit('complete', props.action.id, buildData());
}

function submitArchive() {
  if (!notes.value.trim()) {
    $q.notify({ type: 'negative', message: 'Notes are required' });
    return;
  }
  submitting.value = true;
  emit('archive', props.action.id, buildData());
}

function submitVote(decision: string) {
  submitting.value = true;
  emit('vote', props.action.id, decision, notes.value.trim());
}

function submitResolve() {
  submitting.value = true;
  emit('resolve', props.action.id);
}
</script>

<style scoped lang="scss">
.modal-body {
  max-height: 65vh;
  overflow-y: auto;
}

.dialog-footer {
  display: flex;
  gap: 8px;
  padding: 12px 20px 16px;
  border-top: 1px solid var(--matou-border);
}

.dialog-footer-btn {
  flex: 1;
  border-radius: 10px;
}

.detail-card {
  background: var(--matou-secondary);
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius-sm);
  padding: 12px 14px;
}

.detail-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  font-size: 0.9rem;

  &:last-child {
    margin-bottom: 0;
  }

  .ellipsis {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }
}

// ── Status badge ─────────────────────────────────────────────────────────────

.status-badge {
  font-size: 0.7rem;
  padding: 2px 8px;
  border-radius: 10px;
  flex-shrink: 0;
  text-transform: capitalize;
  background: var(--matou-muted);
  color: var(--matou-muted-foreground);

  &--completed {
    background: #d1fae5;
    color: #059669;
  }

  &--planned {
    background: var(--matou-muted);
    color: var(--matou-muted-foreground);
  }
}

// ── Voting locked ─────────────────────────────────────────────────────────────

.voting-locked {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px 16px;
  background: #fef3c7;
  border-radius: var(--matou-radius-sm);
  color: #92400e;
}

// ── Outcome badge ─────────────────────────────────────────────────────────────

.completed-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border-radius: var(--matou-radius-sm);
  font-weight: 500;
  font-size: 0.9rem;

  &--positive {
    background: #d1fae5;
    color: #059669;
  }

  &--negative {
    background: #fee2e2;
    color: #dc2626;
  }

  &--archived {
    background: #fef3c7;
    color: #d97706;
  }
}

// ── Completion form fields (evidence-style) ─────────────────────────────────

.completion-fields {
  border-top: 1px solid var(--matou-border);
  padding-top: 12px;
}

.completion-field {
  margin-bottom: 14px;
}

.completion-field-label {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--matou-muted-foreground);
  margin-bottom: 4px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
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

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
}

// ── Completion details (read-only) ──────────────────────────────────────────

.completion-details {
  background: var(--matou-secondary);
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius-sm);
  padding: 14px;
}

.completion-details-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  font-size: 0.88rem;
}

.completion-notes-text {
  font-size: 0.88rem;
  color: var(--matou-foreground);
  margin: 0 0 8px;
  line-height: 1.5;
  white-space: pre-wrap;
}

.completion-attachments {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.completion-link {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.82rem;
  color: var(--matou-primary);
  text-decoration: none;
  padding: 4px 0;

  &:hover {
    text-decoration: underline;
  }

  span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

// ── Voting results ──────────────────────────────────────────────────────────

.voting-results {
  background: var(--matou-secondary);
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius-sm);
  padding: 14px;
}

.voting-results-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
  font-size: 0.88rem;
}

.voting-result-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 0;
  border-bottom: 1px solid var(--matou-border);

  &:last-child {
    border-bottom: none;
  }
}

.voting-result-house {
  font-size: 0.85rem;
  font-weight: 500;
}

.voting-result-badge {
  font-size: 0.75rem;
  padding: 2px 10px;
  border-radius: 10px;
  font-weight: 500;

  &--positive {
    background: #d1fae5;
    color: #059669;
  }

  &--negative {
    background: #fee2e2;
    color: #dc2626;
  }

  &--pending {
    background: var(--matou-muted);
    color: var(--matou-muted-foreground);
  }
}

// ── Voting totals ────────────────────────────────────────────────────────────

.voting-totals {
  display: flex;
  gap: 12px;
  margin-bottom: 12px;
}

.voting-total {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 0.85rem;
  font-weight: 600;

  &--positive {
    color: #059669;
  }

  &--negative {
    color: #dc2626;
  }

  &--pending {
    color: var(--matou-muted-foreground);
  }
}

// ── Vote comments ────────────────────────────────────────────────────────────

.vote-comments-header {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--matou-muted-foreground);
  text-transform: uppercase;
  letter-spacing: 0.03em;
  margin-top: 12px;
  margin-bottom: 8px;
  padding-top: 10px;
  border-top: 1px solid var(--matou-border);
}

.vote-comment {
  padding: 8px 10px;
  background: var(--matou-card);
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius-sm);
  margin-bottom: 6px;

  &:last-child {
    margin-bottom: 0;
  }
}

.vote-comment-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.vote-comment-avatar {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: #dbeafe;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.vote-comment-name {
  font-size: 0.82rem;
  font-weight: 500;
}

.vote-comment-text {
  font-size: 0.85rem;
  color: var(--matou-muted-foreground);
  margin: 0;
  line-height: 1.4;
}
</style>
