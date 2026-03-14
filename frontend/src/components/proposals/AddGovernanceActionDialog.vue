<template>
  <q-dialog
    :model-value="modelValue"
    @update:model-value="$emit('update:modelValue', $event)"
    persistent
  >
    <q-card style="min-width: 550px; max-width: 650px">
      <q-card-section class="row items-center q-pb-none">
        <div class="text-h6">Add Governance Action</div>
        <q-space />
        <q-btn icon="close" flat round dense v-close-popup />
      </q-card-section>

      <q-card-section class="q-gutter-md q-pt-md">
        <!-- House selection -->
        <div>
          <div class="text-subtitle2 q-mb-sm">House</div>
          <q-btn-toggle
            v-model="form.house"
            :options="HOUSE_OPTIONS"
            spread
            no-caps
            unelevated
            toggle-color="primary"
          />
        </div>

        <!-- Action type -->
        <div>
          <div class="text-subtitle2 q-mb-sm">Action Type</div>
          <q-btn-toggle
            v-model="form.actionType"
            :options="ACTION_TYPE_OPTIONS"
            spread
            no-caps
            unelevated
            toggle-color="primary"
          />
        </div>

        <!-- Meeting / discussion date fields -->
        <template v-if="form.actionType === 'meeting' || form.actionType === 'discussion'">
          <div class="row q-col-gutter-sm">
            <div class="col-4">
              <q-input v-model="form.meetingDate" label="Date *" outlined dense type="date" />
            </div>
            <div class="col-4">
              <q-input v-model="form.meetingTime" label="Time *" outlined dense type="time" />
            </div>
            <div class="col-4">
              <q-input
                v-model="form.meetingLocation"
                label="Location / Link"
                outlined
                dense
              />
            </div>
          </div>
        </template>

        <!-- Decision: link to a completed meeting -->
        <template v-if="form.actionType === 'decision'">
          <q-select
            v-model="form.linkedActionId"
            :options="availableLinkedActions"
            label="Linked Meeting / Discussion (optional)"
            outlined
            dense
            emit-value
            map-options
            clearable
            :hint="
              availableLinkedActions.length === 0
                ? 'No completed meetings available for this house yet'
                : ''
            "
          />
        </template>

        <!-- Description -->
        <q-input
          v-model="form.description"
          label="Description *"
          type="textarea"
          outlined
          autogrow
        />

        <!-- Live preview -->
        <div v-if="form.house && form.actionType && form.description.trim()" class="preview-card">
          <div class="preview-title">Preview</div>
          <div class="preview-row">
            <span class="preview-label">House</span>
            <span>{{ houseLabel(form.house) }}</span>
          </div>
          <div class="preview-row">
            <span class="preview-label">Type</span>
            <span class="text-capitalize">{{ form.actionType }}</span>
          </div>
          <div v-if="form.meetingDate" class="preview-row">
            <span class="preview-label">When</span>
            <span>{{ form.meetingDate }}{{ form.meetingTime ? ' at ' + form.meetingTime : '' }}</span>
          </div>
          <div class="preview-row">
            <span class="preview-label">Description</span>
            <span>{{ form.description }}</span>
          </div>
        </div>
      </q-card-section>

      <q-card-actions align="right" class="q-px-md q-pb-md">
        <q-btn flat no-caps label="Cancel" v-close-popup />
        <q-btn
          flat
          no-caps
          label="Add Action"
          color="primary"
          @click="handleAdd"
        />
      </q-card-actions>
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
  description: string;
  meeting_date?: string;
  meeting_time?: string;
  meeting_location?: string;
  linked_action_id?: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const HOUSE_OPTIONS = [
  { label: 'Elder Council', value: 'elders_council' },
  { label: 'Community', value: 'community_reps' },
  { label: 'Contributors', value: 'contributors' },
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
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  add: [action: NewGovernanceAction];
}>();

// ── Internal state ───────────────────────────────────────────────────────────

const $q = useQuasar();

interface FormState {
  house: string;
  actionType: string;
  meetingDate: string;
  meetingTime: string;
  meetingLocation: string;
  linkedActionId: string;
  description: string;
}

function makeDefaultForm(): FormState {
  return {
    house: 'elders_council',
    actionType: 'discussion',
    meetingDate: '',
    meetingTime: '',
    meetingLocation: '',
    linkedActionId: '',
    description: '',
  };
}

const form = ref<FormState>(makeDefaultForm());

// Reset form whenever dialog opens
watch(
  () => props.modelValue,
  (open) => {
    if (open) form.value = makeDefaultForm();
  },
);

// ── Computed ─────────────────────────────────────────────────────────────────

const availableLinkedActions = computed(() =>
  props.existingActions
    .filter(
      (a) =>
        a.house === form.value.house &&
        (a.action_type === 'meeting' || a.action_type === 'discussion') &&
        a.status === 'completed',
    )
    .map((a) => ({
      label: `${a.action_type.charAt(0).toUpperCase() + a.action_type.slice(1)}: ${a.description}`,
      value: a.id,
    })),
);

// ── Helpers ───────────────────────────────────────────────────────────────────

function houseLabel(value: string): string {
  return HOUSE_OPTIONS.find((h) => h.value === value)?.label ?? value;
}

// ── Handlers ─────────────────────────────────────────────────────────────────

function handleAdd() {
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

  const action: NewGovernanceAction = {
    house: form.value.house,
    action_type: form.value.actionType,
    description: form.value.description.trim(),
  };

  if (form.value.meetingDate) action.meeting_date = form.value.meetingDate;
  if (form.value.meetingTime) action.meeting_time = form.value.meetingTime;
  if (form.value.meetingLocation) action.meeting_location = form.value.meetingLocation;
  if (form.value.linkedActionId) action.linked_action_id = form.value.linkedActionId;

  emit('add', action);
}
</script>

<style scoped lang="scss">
.preview-card {
  background: var(--matou-secondary);
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius-sm);
  padding: 12px 14px;
}

.preview-title {
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--matou-muted-foreground);
  margin-bottom: 8px;
}

.preview-row {
  display: flex;
  gap: 8px;
  margin-bottom: 4px;
  font-size: 0.85rem;

  &:last-child {
    margin-bottom: 0;
  }
}

.preview-label {
  font-weight: 500;
  min-width: 80px;
  flex-shrink: 0;
  color: var(--matou-muted-foreground);
}
</style>
