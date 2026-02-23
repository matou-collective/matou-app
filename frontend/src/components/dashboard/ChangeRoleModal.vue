<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="show" class="modal-overlay fixed inset-0 z-[60] flex items-center justify-center p-4" @click.self="!isUpdating && $emit('close')">
        <div class="modal-content bg-card border border-border rounded-2xl shadow-xl max-w-md w-full overflow-hidden">
          <!-- Header -->
          <div class="modal-header bg-primary p-4 border-b border-white/20 flex items-center justify-between">
            <h3 class="font-semibold text-lg text-white">Change Role</h3>
            <q-btn v-if="!isUpdating" flat @click="$emit('close')" class="p-1.5 rounded-lg transition-colors">
              <X class="w-5 h-5 text-white" />
            </q-btn>
          </div>

          <!-- Role selection (hidden once upgrade starts) -->
          <div v-if="!upgradeStarted" class="modal-body p-4">
            <p class="text-sm text-black/70 mb-4">
              Select a new role for <strong>{{ memberName }}</strong>
            </p>

            <div class="space-y-2">
              <label
                v-for="role in roles"
                :key="role"
                class="flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors"
                :class="selectedRole === role
                  ? 'border-primary bg-primary/10'
                  : 'border-border hover:bg-secondary'"
              >
                <input
                  type="radio"
                  :value="role"
                  v-model="selectedRole"
                  class="accent-[var(--matou-primary)]"
                />
                <span class="text-sm font-medium" :class="role === currentRole ? 'text-primary' : 'text-black'">
                  {{ role }}
                  <span v-if="role === currentRole" class="text-xs text-black/50 ml-1">(current)</span>
                </span>
              </label>
            </div>

            <!-- Error -->
            <div v-if="error" class="mt-4 p-3 bg-destructive/10 border border-destructive/20 rounded-lg">
              <p class="text-sm text-destructive">{{ error }}</p>
            </div>
          </div>

          <!-- Progress stepper (shown once steward upgrade starts) -->
          <div v-if="upgradeStarted" class="modal-body p-4">
            <p class="text-sm text-black/70 mb-4">
              Upgrading <strong>{{ memberName }}</strong> to <strong>{{ selectedRole }}</strong>
            </p>

            <div class="space-y-3">
              <div
                v-for="(step, index) in upgradeSteps"
                :key="step.id"
                class="flex items-center gap-3 p-3 rounded-lg border transition-colors"
                :class="stepClass(index)"
              >
                <!-- Step icon -->
                <div class="flex-shrink-0 w-6 h-6 flex items-center justify-center">
                  <CheckCircle2 v-if="step.status === 'done'" class="w-5 h-5 text-green-600" />
                  <Loader2 v-else-if="step.status === 'active'" class="w-5 h-5 text-primary animate-spin" />
                  <XCircle v-else-if="step.status === 'error'" class="w-5 h-5 text-destructive" />
                  <Circle v-else class="w-5 h-5 text-black/20" />
                </div>

                <!-- Step text -->
                <div class="flex-1 min-w-0">
                  <p class="text-sm font-medium" :class="step.status === 'pending' ? 'text-black/40' : 'text-black'">
                    {{ step.label }}
                  </p>
                  <p v-if="step.status === 'active' && step.detail" class="text-xs text-black/50 mt-0.5">
                    {{ step.detail }}
                  </p>
                </div>
              </div>
            </div>

            <!-- Error during upgrade -->
            <div v-if="error" class="mt-4 p-3 bg-destructive/10 border border-destructive/20 rounded-lg">
              <p class="text-sm text-destructive">{{ error }}</p>
            </div>
          </div>

          <!-- Footer -->
          <div class="p-4 border-t border-border flex items-center gap-3">
            <button
              v-if="!upgradeStarted"
              @click="$emit('close')"
              class="flex-1 px-4 py-2.5 text-sm rounded-lg border border-border hover:bg-secondary transition-colors"
            >
              Cancel
            </button>
            <button
              v-if="!upgradeStarted"
              @click="handleConfirm"
              class="flex-1 px-4 py-2.5 text-sm rounded-lg bg-primary text-white hover:bg-primary/90 transition-colors disabled:opacity-50"
              :disabled="selectedRole === currentRole"
            >
              Confirm
            </button>
            <button
              v-if="upgradeStarted && !isUpdating"
              @click="handleDone"
              class="flex-1 px-4 py-2.5 text-sm rounded-lg bg-primary text-white hover:bg-primary/90 transition-colors"
            >
              {{ upgradeComplete ? 'Done' : 'Close' }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, reactive, watch } from 'vue';
import { X, Loader2, CheckCircle2, Circle, XCircle } from 'lucide-vue-next';
import { updateMemberRole } from 'src/lib/api/client';
import { useAdminActions } from 'src/composables/useAdminActions';

interface Props {
  show: boolean;
  memberName: string;
  memberAid: string;
  currentRole: string;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'role-updated', role: string): void;
}>();

const { upgradeMemberToSteward } = useAdminActions();

const STEWARD_ROLES = ['Founding Member', 'Community Steward'];

const roles = [
  'Member',
  'Contributor',
  'Community Steward',
  'Operations Steward',
  'Founding Member',
  'Financial Steward',
  'Governance Steward',
  'Treasury Steward',
  'Technical Steward',
  'Cultural Steward',
];

interface UpgradeStep {
  id: string;
  label: string;
  detail?: string;
  status: 'pending' | 'active' | 'done' | 'error';
}

const selectedRole = ref(props.currentRole);
const isUpdating = ref(false);
const upgradeStarted = ref(false);
const upgradeComplete = ref(false);
const error = ref<string | null>(null);

const upgradeSteps = reactive<UpgradeStep[]>([
  { id: 'role', label: 'Updating role', status: 'pending' },
  { id: 'resolve', label: 'Resolving steward identity', status: 'pending' },
  { id: 'rotation', label: 'Performing key rotation', status: 'pending' },
  { id: 'revoke', label: 'Revoking old credential', status: 'pending' },
  { id: 'issue', label: 'Issuing new credential', status: 'pending' },
]);

function stepClass(index: number) {
  const step = upgradeSteps[index];
  if (step.status === 'done') return 'border-green-200 bg-green-50';
  if (step.status === 'active') return 'border-primary/30 bg-primary/5';
  if (step.status === 'error') return 'border-destructive/30 bg-destructive/5';
  return 'border-border';
}

function resetSteps() {
  for (const step of upgradeSteps) {
    step.status = 'pending';
    step.detail = undefined;
  }
}

const stepMap: Record<string, string> = {
  'Resolving steward identity...': 'resolve',
  'Performing key rotation...': 'rotation',
  'Revoking old credential...': 'revoke',
  'Issuing new credential...': 'issue',
  'Complete': 'done',
};

function advanceStep(stepMessage: string) {
  const stepId = stepMap[stepMessage];
  if (!stepId) return;

  // Mark the matched step as active, all previous as done
  let foundActive = false;
  for (const step of upgradeSteps) {
    if (step.id === stepId && stepId !== 'done') {
      step.status = 'active';
      foundActive = true;
    } else if (!foundActive) {
      step.status = 'done';
    }
    if (stepId === 'done') {
      step.status = 'done';
    }
  }
}

watch(() => props.show, (isOpen) => {
  if (isOpen) {
    selectedRole.value = props.currentRole;
    error.value = null;
    upgradeStarted.value = false;
    upgradeComplete.value = false;
    resetSteps();
  }
});

async function handleConfirm() {
  if (selectedRole.value === props.currentRole) return;

  isUpdating.value = true;
  error.value = null;
  resetSteps();

  const isStewardRole = STEWARD_ROLES.includes(selectedRole.value);

  try {
    // Step 1: Update role in backend (CommunityProfile)
    upgradeSteps[0].status = 'active';
    const result = await updateMemberRole(props.memberAid, selectedRole.value);
    if (result.error) {
      upgradeSteps[0].status = 'error';
      error.value = result.error;
      isUpdating.value = false;
      return;
    }
    upgradeSteps[0].status = 'done';

    // For non-steward roles, we're done after the API call
    if (!isStewardRole) {
      upgradeComplete.value = true;
      emit('role-updated', selectedRole.value);
      isUpdating.value = false;
      return;
    }

    // Step 2-5: Full steward upgrade (multisig + credential rotation)
    upgradeStarted.value = true;
    const ok = await upgradeMemberToSteward(props.memberAid, selectedRole.value, advanceStep);

    if (ok) {
      upgradeComplete.value = true;
      emit('role-updated', selectedRole.value);
    } else {
      // Mark remaining pending steps as errors
      for (const step of upgradeSteps) {
        if (step.status === 'active') step.status = 'error';
      }
      error.value = 'Steward upgrade failed. The role was updated but key rotation or credential re-issuance may not have completed.';
    }
  } catch (err) {
    for (const step of upgradeSteps) {
      if (step.status === 'active') step.status = 'error';
    }
    error.value = err instanceof Error ? err.message : 'Failed to update role';
  } finally {
    isUpdating.value = false;
  }
}

function handleDone() {
  emit('close');
}
</script>

<style lang="scss" scoped>
.modal-overlay {
  background-color: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px);
}

.modal-content {
  background-color: var(--matou-card);
}

.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.2s ease;
  .modal-content {
    transition: transform 0.2s ease;
  }
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
  .modal-content {
    transform: scale(0.95);
  }
}
</style>
