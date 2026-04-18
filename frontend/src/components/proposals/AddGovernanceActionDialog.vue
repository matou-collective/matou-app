<template>
  <q-dialog
    :model-value="modelValue"
    @update:model-value="$emit('update:modelValue', $event)"
    persistent
  >
    <q-card class="governance-action-dialog">
      <q-card-section class="row items-center q-pb-none">
        <div>
          <div class="text-h6">Add Governance Action</div>
          <div class="text-caption text-grey">
            Define a governance action for this proposal's decision plan. Not all houses need actions.
          </div>
        </div>
        <q-space />
        <q-btn icon="close" flat round dense v-close-popup />
      </q-card-section>

      <q-card-section class="form-body q-pt-md">
        <!-- House Selection -->
        <div class="form-section">
          <div class="form-label">House</div>
          <div class="card-grid-3">
            <button
              v-for="h in HOUSE_OPTIONS"
              :key="h.value"
              class="select-card"
              :class="{ active: form.house === h.value }"
              @click="form.house = h.value; form.linkedActionId = ''"
              type="button"
            >
              <q-icon :name="h.icon" size="22px" />
              <span>{{ h.label }}</span>
            </button>
          </div>
        </div>

        <!-- Action Type -->
        <div class="form-section">
          <div class="form-label">Action Type</div>
          <div class="card-grid-3">
            <button
              v-for="t in ACTION_TYPE_OPTIONS"
              :key="t.value"
              class="select-card select-card--compact"
              :class="{ active: form.actionType === t.value }"
              @click="form.actionType = t.value"
              type="button"
            >
              <span>{{ t.label }}</span>
            </button>
          </div>
        </div>

        <!-- Date/Time/Location for meetings and discussions -->
        <div
          v-if="form.actionType === 'meeting' || form.actionType === 'discussion'"
          class="datetime-card"
        >
          <div class="datetime-row">
            <div class="datetime-field">
              <div class="datetime-label">Date *</div>
              <q-input
                v-model="form.meetingDate"
                outlined
                dense
                mask="##-##-####"
                placeholder="dd-mm-yyyy"
              >
                <template #append>
                  <q-icon name="event" class="cursor-pointer">
                    <q-popup-proxy ref="dateProxy" cover transition-show="scale" transition-hide="scale">
                      <q-date
                        :model-value="toQDateFormat(form.meetingDate)"
                        @update:model-value="onDatePicked($event)"
                        mask="YYYY/MM/DD"
                      >
                        <div class="row items-center justify-end">
                          <q-btn v-close-popup label="Close" color="primary" flat />
                        </div>
                      </q-date>
                    </q-popup-proxy>
                  </q-icon>
                </template>
              </q-input>
            </div>
            <div class="datetime-field">
              <div class="datetime-label">Time *</div>
              <q-input
                v-model="form.meetingTime"
                outlined
                dense
                mask="##:##"
                placeholder="HH:mm"
              >
                <template #append>
                  <q-icon name="access_time" class="cursor-pointer">
                    <q-popup-proxy ref="timeProxy" cover transition-show="scale" transition-hide="scale">
                      <q-time
                        v-model="form.meetingTime"
                        mask="HH:mm"
                        format24h
                      >
                        <div class="row items-center justify-end">
                          <q-btn v-close-popup label="Close" color="primary" flat />
                        </div>
                      </q-time>
                    </q-popup-proxy>
                  </q-icon>
                </template>
              </q-input>
            </div>
          </div>
          <div class="datetime-field">
            <div class="datetime-label">Location/Link *</div>
            <q-input
              v-model="form.meetingLocation"
              outlined
              dense
              placeholder="e.g., Virtual - Zoom link or Community Center"
            />
          </div>
        </div>

        <!-- Linked Action for Decisions -->
        <div v-if="form.actionType === 'decision'" class="linked-section">
          <div class="form-label">Select Meeting or Discussion</div>
          <div v-if="availableLinkedActions.length > 0" class="linked-list">
            <button
              v-for="action in availableLinkedActions"
              :key="action.value"
              class="linked-card"
              :class="{ active: form.linkedActionId === action.value }"
              @click="form.linkedActionId = action.value"
              type="button"
            >
              <q-icon :name="action.icon" size="16px" />
              <span>{{ action.label }}</span>
            </button>
          </div>
          <div v-else class="linked-empty">
            <span>No meetings or discussions found for {{ houseLabel(form.house) }}</span>
            <q-btn
              outline
              size="sm"
              no-caps
              label="Create Meeting First"
              icon="add"
              color="primary"
              class="q-mt-sm"
              @click="form.actionType = 'meeting'"
            />
          </div>

          <!-- Voting End Date/Time for Decisions -->
          <div class="datetime-card q-mt-md">
            <div class="datetime-row">
              <div class="datetime-field">
                <div class="datetime-label">Voting End Date *</div>
                <q-input
                  v-model="form.endDate"
                  outlined
                  dense
                  mask="##-##-####"
                  placeholder="dd-mm-yyyy"
                >
                  <template #append>
                    <q-icon name="event" class="cursor-pointer">
                      <q-popup-proxy ref="endDateProxy" cover transition-show="scale" transition-hide="scale">
                        <q-date
                          :model-value="toQDateFormat(form.endDate)"
                          @update:model-value="onEndDatePicked($event)"
                          mask="YYYY/MM/DD"
                        >
                          <div class="row items-center justify-end">
                            <q-btn v-close-popup label="Close" color="primary" flat />
                          </div>
                        </q-date>
                      </q-popup-proxy>
                    </q-icon>
                  </template>
                </q-input>
              </div>
              <div class="datetime-field">
                <div class="datetime-label">Voting End Time *</div>
                <q-input
                  v-model="form.endTime"
                  outlined
                  dense
                  mask="##:##"
                  placeholder="HH:mm"
                >
                  <template #append>
                    <q-icon name="access_time" class="cursor-pointer">
                      <q-popup-proxy ref="endTimeProxy" cover transition-show="scale" transition-hide="scale">
                        <q-time
                          v-model="form.endTime"
                          mask="HH:mm"
                          format24h
                        >
                          <div class="row items-center justify-end">
                            <q-btn v-close-popup label="Close" color="primary" flat />
                          </div>
                        </q-time>
                      </q-popup-proxy>
                    </q-icon>
                  </template>
                </q-input>
              </div>
            </div>
          </div>
        </div>

        <!-- Title -->
        <div class="form-section">
          <div class="form-label">Title *</div>
          <q-input
            v-model="form.title"
            outlined
            dense
          />
        </div>

        <!-- Description -->
        <div class="form-section">
          <div class="form-label">Description *</div>
          <q-input
            v-model="form.description"
            type="textarea"
            outlined
            autogrow
            :rows="3"
            :placeholder="descriptionPlaceholder"
          />
          <div class="form-hint">{{ descriptionHint }}</div>
        </div>

        <!-- Preview -->
        <div v-if="form.house && form.actionType && form.title.trim()" class="preview-card">
          <q-icon :name="currentHouseIcon" size="16px" class="preview-icon" />
          <span class="preview-house">{{ form.title }}</span>
          <span class="preview-type">{{ form.actionType.charAt(0).toUpperCase() + form.actionType.slice(1) }}</span>
        </div>
      </q-card-section>

      <div class="dialog-footer">
        <q-btn no-caps label="Add Action" color="primary" class="dialog-footer-btn" @click="handleAdd" />
        <q-btn outline no-caps label="Cancel" color="primary" class="dialog-footer-btn" v-close-popup />
      </div>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useQuasar } from 'quasar';
import type { GovernanceAction } from 'src/lib/api/decisionPlans';

// ── Public types ─────────────────────────────────────────────────────────────

export interface NewGovernanceAction {
  house: string;
  action_type: string;
  title: string;
  description: string;
  meeting_date?: string;
  meeting_time?: string;
  meeting_location?: string;
  linked_action_id?: string;
  voting_end_date?: string;
  voting_end_time?: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const HOUSE_OPTIONS = [
  { label: 'Elders Council', value: 'elders_council', icon: 'shield' },
  { label: 'Community Representatives', value: 'community_reps', icon: 'groups' },
  { label: 'Contributors', value: 'contributors', icon: 'engineering' },
];

const ACTION_TYPE_OPTIONS = [
  { label: 'Discussion', value: 'discussion' },
  { label: 'Meeting', value: 'meeting' },
  { label: 'Decision', value: 'decision' },
];

// ── Component interface ──────────────────────────────────────────────────────

const props = defineProps<{
  modelValue: boolean;
  existingActions: GovernanceAction[];
  proposalTitle?: string;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  add: [action: NewGovernanceAction];
}>();

// ── Internal state ───────────────────────────────────────────────────────────

const $q = useQuasar();
const dateProxy = ref<{ hide: () => void } | null>(null);
const timeProxy = ref<{ show: () => void } | null>(null);
const endDateProxy = ref<{ hide: () => void } | null>(null);
const endTimeProxy = ref<{ show: () => void } | null>(null);

function onDatePicked(qdate: string) {
  form.value.meetingDate = fromQDateFormat(qdate);
  dateProxy.value?.hide();
  // Auto-open time picker after date is selected
  setTimeout(() => timeProxy.value?.show(), 300);
}

function onEndDatePicked(qdate: string) {
  form.value.endDate = fromQDateFormat(qdate);
  endDateProxy.value?.hide();
  setTimeout(() => endTimeProxy.value?.show(), 300);
}

interface FormState {
  house: string;
  actionType: string;
  title: string;
  meetingDate: string;
  meetingTime: string;
  meetingLocation: string;
  linkedActionId: string;
  description: string;
  endDate: string;
  endTime: string;
}

function toQDateFormat(ddmmyyyy: string): string {
  if (!ddmmyyyy || ddmmyyyy.length !== 10) return '';
  const [dd, mm, yyyy] = ddmmyyyy.split('-');
  return `${yyyy}/${mm}/${dd}`;
}

function fromQDateFormat(qdate: string): string {
  if (!qdate) return '';
  const [yyyy, mm, dd] = qdate.split('/');
  return `${dd}-${mm}-${yyyy}`;
}

function toISODate(ddmmyyyy: string): string {
  if (!ddmmyyyy || ddmmyyyy.length !== 10) return '';
  const [dd, mm, yyyy] = ddmmyyyy.split('-');
  return `${yyyy}-${mm}-${dd}`;
}

function generateTitle(house: string, actionType: string, meetingDate?: string): string {
  const houseName = houseLabel(house);
  const typeName = actionType.charAt(0).toUpperCase() + actionType.slice(1);
  const proposalName = props.proposalTitle || 'Proposal';
  let datePart = '';
  // Use meeting date (dd-mm-yyyy) if available, otherwise leave blank
  if (meetingDate && meetingDate.length === 10) {
    const [dd, mm, yyyy] = meetingDate.split('-');
    datePart = `${dd}-${mm}-${yyyy.slice(2)}`;
  }
  return datePart
    ? `${houseName} ${typeName}: ${proposalName} - ${datePart}`
    : `${houseName} ${typeName}: ${proposalName}`;
}

function makeDefaultForm(): FormState {
  return {
    house: 'elders_council',
    actionType: 'discussion',
    title: generateTitle('elders_council', 'discussion', ''),
    meetingDate: '',
    meetingTime: '',
    meetingLocation: '',
    linkedActionId: '',
    description: '',
    endDate: '',
    endTime: '',
  };
}

const form = ref<FormState>(makeDefaultForm());

// Track previous auto-generated title so we know when to auto-update
let lastAutoTitle = generateTitle('elders_council', 'discussion', '');

// Update title when house, action type, or meeting date changes
watch(
  [() => form.value.house, () => form.value.actionType, () => form.value.meetingDate],
  ([house, actionType, meetingDate]) => {
    const newTitle = generateTitle(house, actionType, meetingDate);
    // Only auto-update if user hasn't manually edited the title
    if (!form.value.title || form.value.title === lastAutoTitle) {
      form.value.title = newTitle;
    }
    lastAutoTitle = newTitle;
  },
);

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      form.value = makeDefaultForm();
      lastAutoTitle = generateTitle('elders_council', 'discussion', '');
    }
  },
);

// ── Computed ─────────────────────────────────────────────────────────────────

const availableLinkedActions = computed(() =>
  props.existingActions
    .filter(
      (a) =>
        a.house === form.value.house &&
        (a.action_type === 'meeting' || a.action_type === 'discussion'),
    )
    .map((a) => ({
      label: a.title || a.description,
      value: a.id,
      icon: a.action_type === 'meeting' ? 'event' : 'chat',
    })),
);

const currentHouseIcon = computed(() =>
  HOUSE_OPTIONS.find((h) => h.value === form.value.house)?.icon ?? 'shield',
);

const descriptionPlaceholder = computed(() => {
  if (form.value.actionType === 'decision') return 'Describe what will be decided and the decision criteria...';
  return 'Describe the agenda and purpose of this discussion/meeting...';
});

const descriptionHint = computed(() => {
  if (form.value.actionType === 'decision') return 'Include decision criteria and voting requirements';
  return 'Include agenda items and expected outcomes';
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function houseLabel(value: string): string {
  return HOUSE_OPTIONS.find((h) => h.value === value)?.label ?? value;
}

// ── Handlers ─────────────────────────────────────────────────────────────────

function handleAdd() {
  if (!form.value.title.trim()) {
    $q.notify({ type: 'negative', message: 'Title is required' });
    return;
  }

  if (!form.value.description.trim()) {
    $q.notify({ type: 'negative', message: 'Description is required' });
    return;
  }

  if (
    (form.value.actionType === 'meeting' || form.value.actionType === 'discussion') &&
    !form.value.meetingDate
  ) {
    $q.notify({ type: 'negative', message: 'Date is required for meetings and discussions' });
    return;
  }

  if (form.value.actionType === 'decision' && !form.value.endDate) {
    $q.notify({ type: 'negative', message: 'Voting end date is required for decisions' });
    return;
  }

  // Validate end date is after linked meeting date
  if (form.value.actionType === 'decision' && form.value.linkedActionId && form.value.endDate) {
    const linked = props.existingActions.find((a) => a.id === form.value.linkedActionId);
    if (linked?.meeting_date) {
      const endISO = toISODate(form.value.endDate) + (form.value.endTime ? 'T' + form.value.endTime : 'T23:59');
      const meetISO = linked.meeting_date + (linked.meeting_time ? 'T' + linked.meeting_time : 'T00:00');
      if (endISO <= meetISO) {
        $q.notify({ type: 'negative', message: 'Voting end date must be after the linked meeting date/time' });
        return;
      }
    }
  }

  const action: NewGovernanceAction = {
    house: form.value.house,
    action_type: form.value.actionType,
    title: form.value.title.trim(),
    description: form.value.description.trim(),
  };

  if (form.value.meetingDate) action.meeting_date = toISODate(form.value.meetingDate) || form.value.meetingDate;
  if (form.value.meetingTime) action.meeting_time = form.value.meetingTime;
  if (form.value.meetingLocation) action.meeting_location = form.value.meetingLocation;
  if (form.value.linkedActionId) action.linked_action_id = form.value.linkedActionId;
  if (form.value.endDate) action.voting_end_date = toISODate(form.value.endDate) || form.value.endDate;
  if (form.value.endTime) action.voting_end_time = form.value.endTime;

  emit('add', action);
}
</script>

<style scoped lang="scss">
.governance-action-dialog {
  min-width: 480px;
  max-width: 540px;
}

.form-body {
  max-height: 65vh;
  overflow-y: auto;
}

.form-section {
  margin-bottom: 16px;
}

.form-label {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--matou-foreground);
  margin-bottom: 8px;
}

.form-hint {
  font-size: 0.75rem;
  font-style: italic;
  color: var(--matou-muted-foreground);
  margin-top: 4px;
}

// House + Action Type card grids
.card-grid-3 {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 8px;
}

.select-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 14px 8px;
  border: 2px solid var(--matou-border);
  border-radius: 10px;
  background: transparent;
  color: var(--matou-muted-foreground);
  cursor: pointer;
  font-size: 0.8rem;
  font-weight: 500;
  transition: all 0.12s ease;

  &:hover {
    border-color: var(--matou-accent);
    color: var(--matou-foreground);
  }

  &.active {
    border-color: var(--matou-primary);
    background: rgba(30, 95, 116, 0.06);
    color: var(--matou-primary);
  }
}

.select-card--compact {
  flex-direction: row;
  padding: 10px 12px;
}

// Date/Time/Location card
.datetime-card {
  background: rgba(30, 95, 116, 0.04);
  border: 1px solid rgba(30, 95, 116, 0.12);
  border-radius: 10px;
  padding: 16px;
  margin-bottom: 16px;
}

.datetime-row {
  display: flex;
  gap: 12px;

  > .datetime-field {
    flex: 1;
  }
}

.datetime-field {
  margin-bottom: 12px;

  &:last-child {
    margin-bottom: 0;
  }
}

.datetime-label {
  font-size: 0.78rem;
  font-weight: 500;
  color: var(--matou-muted-foreground);
  margin-bottom: 4px;
}

// Linked action section
.linked-section {
  margin-bottom: 16px;
}

.linked-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.linked-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--matou-border);
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  font-size: 0.82rem;
  color: var(--matou-muted-foreground);
  text-align: left;
  transition: all 0.12s ease;

  &:hover {
    border-color: var(--matou-accent);
  }

  &.active {
    border-color: var(--matou-primary);
    background: rgba(30, 95, 116, 0.06);
    color: var(--matou-primary);
  }
}

.linked-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 16px;
  background: var(--matou-secondary);
  border: 1px solid var(--matou-border);
  border-radius: 8px;
  font-size: 0.82rem;
  color: var(--matou-muted-foreground);
  text-align: center;
}

// Preview
.preview-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: var(--matou-secondary);
  border: 1px solid var(--matou-border);
  border-radius: 10px;
}

.preview-icon {
  color: var(--matou-primary);
}

.preview-house {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--matou-foreground);
}

.preview-type {
  font-size: 0.75rem;
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--matou-muted);
  color: var(--matou-muted-foreground);
}

// Footer
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
</style>
