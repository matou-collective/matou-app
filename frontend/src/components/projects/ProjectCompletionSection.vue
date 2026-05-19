<template>
  <q-card flat bordered class="completion-section">
    <q-card-section>
      <div class="row items-center q-mb-md">
        <q-icon name="task_alt" color="primary" size="20px" />
        <div class="text-h6 q-ml-sm">Project Completion</div>
      </div>

      <!-- COMPLETED -->
      <div v-if="project.status === 'completed'">
        <q-banner class="bg-green-1">
          <template #avatar>
            <q-icon name="verified" color="positive" />
          </template>
          Completed by {{ project.completed_by || 'a steward' }}
          <span v-if="project.completed_at"> on {{ formatDate(project.completed_at) }}</span>.
        </q-banner>
      </div>

      <!-- PENDING_COMPLETION -->
      <div v-else-if="project.status === 'pending_completion'">
        <q-banner class="bg-orange-1 q-mb-sm">
          <template #avatar><q-icon name="hourglass_top" color="warning" /></template>
          {{ canApprove ? 'Awaiting your signoff.' : 'Awaiting steward signoff.' }}
        </q-banner>
        <div v-if="canApprove" class="row q-gutter-sm">
          <q-btn
            color="positive"
            unelevated
            no-caps
            icon="check"
            label="Approve Completion"
            :loading="approving"
            @click="onApprove"
          />
          <q-btn
            outline
            color="negative"
            no-caps
            icon="undo"
            label="Send Back"
            @click="showRejectDialog = true"
          />
        </div>
      </div>

      <!-- ACTIVE -->
      <div v-else-if="project.status === 'active'">
        <div v-if="project.rejection_reason" class="q-mb-sm">
          <q-banner class="bg-yellow-1">
            <template #avatar><q-icon name="info" color="warning" /></template>
            <strong>Steward sent back:</strong> {{ project.rejection_reason }}
          </q-banner>
        </div>
        <div v-if="!allSignedOff" class="text-grey-8">
          {{ signedOffCount }} / {{ totalContributions }} contributions signed off.
          <span v-if="totalContributions > 0">Submit for review once all are complete.</span>
        </div>
        <div v-else>
          <p class="q-mb-sm">All contributions are signed off and ready for steward review.</p>
          <div v-if="canSubmit">
            <q-btn
              color="primary"
              unelevated
              no-caps
              icon="send"
              label="Submit for Steward Review"
              :loading="submitting"
              @click="onSubmit"
            />
          </div>
          <div v-else class="text-grey-8">
            Awaiting the project lead to submit for steward review.
          </div>
        </div>
      </div>
    </q-card-section>

    <!-- Reject dialog -->
    <q-dialog v-model="showRejectDialog">
      <q-card style="min-width: 420px">
        <q-card-section>
          <div class="text-h6">Send Back for Revision</div>
        </q-card-section>
        <q-card-section>
          <q-input
            v-model="rejectReason"
            label="Reason (optional)"
            type="textarea"
            outlined
            autogrow
          />
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat label="Cancel" v-close-popup />
          <q-btn
            color="negative"
            unelevated
            label="Send Back"
            :loading="rejecting"
            @click="onReject"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </q-card>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import type { Project, Contribution } from 'src/types/projects';

const props = defineProps<{
  project: Project;
  contributions: Contribution[];
  canSubmit: boolean;
  canApprove: boolean;
}>();

const emit = defineEmits<{
  submit: [];
  approve: [];
  reject: [reason: string];
}>();

const submitting = ref(false);
const approving = ref(false);
const rejecting = ref(false);
const showRejectDialog = ref(false);
const rejectReason = ref('');

const activeContributions = computed(() =>
  props.contributions.filter((c) => c.status !== 'archived'),
);
const totalContributions = computed(() => activeContributions.value.length);
const signedOffCount = computed(
  () => activeContributions.value.filter((c) => c.status === 'signed_off' || c.status === 'rewarded').length,
);
const allSignedOff = computed(
  () => totalContributions.value > 0 && signedOffCount.value === totalContributions.value,
);

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString();
}

async function onSubmit() {
  submitting.value = true;
  try {
    emit('submit');
  } finally {
    submitting.value = false;
  }
}

async function onApprove() {
  approving.value = true;
  try {
    emit('approve');
  } finally {
    approving.value = false;
  }
}

async function onReject() {
  rejecting.value = true;
  try {
    emit('reject', rejectReason.value);
    showRejectDialog.value = false;
    rejectReason.value = '';
  } finally {
    rejecting.value = false;
  }
}
</script>

<style scoped lang="scss">
.completion-section {
  margin: 16px 0;
}
</style>
