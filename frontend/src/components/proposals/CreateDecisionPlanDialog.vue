<template>
  <q-dialog
    :model-value="modelValue"
    @update:model-value="$emit('update:modelValue', $event)"
    persistent
  >
    <q-card style="min-width: 600px; max-width: 700px">
      <q-card-section class="row items-center q-pb-none">
        <div>
          <div class="text-h6">Create Decision Plan</div>
          <div class="text-caption text-grey">Configure governance actions for each house</div>
        </div>
        <q-space />
        <q-btn icon="close" flat round dense v-close-popup />
      </q-card-section>

      <q-card-section style="max-height: 65vh; overflow-y: auto" class="q-pt-md">
        <div
          v-for="house in houseConfigs"
          :key="house.value"
          class="house-config q-mb-md"
        >
          <div class="house-config-header" :style="{ borderLeftColor: house.color }">
            <q-icon :name="house.icon" size="20px" :style="{ color: house.color }" />
            <span class="text-weight-bold">{{ house.label }}</span>
            <span class="text-caption text-grey q-ml-xs">({{ house.decisionType }})</span>
          </div>

          <q-checkbox
            v-model="house.includeMeeting"
            label="Include pre-decision meeting"
            class="q-mt-sm"
          />

          <transition name="expand">
            <div v-if="house.includeMeeting" class="meeting-fields q-mt-sm">
              <div class="row q-col-gutter-sm">
                <div class="col-4">
                  <q-input
                    v-model="house.meetingDate"
                    label="Date *"
                    outlined
                    dense
                    type="date"
                  />
                </div>
                <div class="col-4">
                  <q-input
                    v-model="house.meetingTime"
                    label="Time *"
                    outlined
                    dense
                    type="time"
                  />
                </div>
                <div class="col-4">
                  <q-input
                    v-model="house.meetingLocation"
                    label="Location / Link"
                    outlined
                    dense
                  />
                </div>
              </div>
            </div>
          </transition>
        </div>
      </q-card-section>

      <q-card-actions align="right" class="q-px-md q-pb-md">
        <q-btn flat no-caps label="Cancel" v-close-popup />
        <q-btn
          flat
          no-caps
          label="Create Plan"
          color="primary"
          :loading="loading"
          @click="handleCreate"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { ref, reactive } from 'vue';
import { useQuasar } from 'quasar';

// ── Public types ─────────────────────────────────────────────────────────────

export interface HouseAction {
  house: string;
  action_type: string;
  description: string;
  meeting_date?: string;
  meeting_time?: string;
  meeting_location?: string;
}

// ── Component interface ──────────────────────────────────────────────────────

defineProps<{
  modelValue: boolean;
  proposalId: string;
  proposalTitle: string;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  created: [actions: HouseAction[]];
}>();

// ── Internal state ───────────────────────────────────────────────────────────

const $q = useQuasar();
const loading = ref(false);

interface HouseConfig {
  value: string;
  label: string;
  icon: string;
  color: string;
  decisionType: string;
  includeMeeting: boolean;
  meetingDate: string;
  meetingTime: string;
  meetingLocation: string;
}

const houseConfigs = reactive<HouseConfig[]>([
  {
    value: 'elders_council',
    label: 'Elder Council',
    icon: 'shield',
    color: '#7c3aed',
    decisionType: 'Veto Decision',
    includeMeeting: true,
    meetingDate: '',
    meetingTime: '',
    meetingLocation: '',
  },
  {
    value: 'community_reps',
    label: 'Community House',
    icon: 'groups',
    color: '#2563eb',
    decisionType: 'Strategic Vote',
    includeMeeting: true,
    meetingDate: '',
    meetingTime: '',
    meetingLocation: '',
  },
  {
    value: 'contributors',
    label: 'Contributor House',
    icon: 'engineering',
    color: '#059669',
    decisionType: 'Operational Vote',
    includeMeeting: false,
    meetingDate: '',
    meetingTime: '',
    meetingLocation: '',
  },
]);

// ── Handlers ─────────────────────────────────────────────────────────────────

function handleCreate() {
  for (const h of houseConfigs) {
    if (h.includeMeeting && (!h.meetingDate || !h.meetingTime)) {
      $q.notify({
        type: 'negative',
        message: `${h.label}: date and time are required when a meeting is included`,
      });
      return;
    }
  }

  const actions: HouseAction[] = [];

  for (const h of houseConfigs) {
    if (h.includeMeeting) {
      const meetingAction: HouseAction = {
        house: h.value,
        action_type: 'meeting',
        description: `${h.label} pre-decision meeting`,
        meeting_date: h.meetingDate,
        meeting_time: h.meetingTime,
      };
      if (h.meetingLocation) meetingAction.meeting_location = h.meetingLocation;
      actions.push(meetingAction);
    }

    actions.push({
      house: h.value,
      action_type: 'decision',
      description: `${h.label} ${h.decisionType.toLowerCase()}`,
    });
  }

  emit('created', actions);
}
</script>

<style scoped lang="scss">
.house-config {
  background: var(--matou-card);
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius-sm);
  padding: 16px;
}

.house-config-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-left: 10px;
  border-left: 3px solid transparent;
}

.meeting-fields {
  border-left: 2px solid var(--matou-border);
  padding-left: 14px;
  margin-left: 4px;
}

// Simple height-based expand transition
.expand-enter-active,
.expand-leave-active {
  transition:
    opacity 0.2s ease,
    max-height 0.25s ease;
  max-height: 200px;
  overflow: hidden;
}

.expand-enter-from,
.expand-leave-to {
  opacity: 0;
  max-height: 0;
}
</style>
