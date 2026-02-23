<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="show" class="modal-overlay fixed inset-0 z-[60] flex items-center justify-center p-4" @click.self="$emit('close')">
        <div class="modal-content bg-card border border-border rounded-2xl shadow-xl max-w-md w-full overflow-hidden">
          <!-- Header -->
          <div class="modal-header bg-primary p-4 border-b border-white/20 flex items-center justify-between">
            <h3 class="font-semibold text-lg text-white">Change Role</h3>
            <q-btn flat @click="$emit('close')" class="p-1.5 rounded-lg transition-colors">
              <X class="w-5 h-5 text-white" />
            </q-btn>
          </div>

          <!-- Content -->
          <div class="modal-body p-4">
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

          <!-- Footer -->
          <div class="p-4 border-t border-border flex items-center gap-3">
            <button
              @click="$emit('close')"
              class="flex-1 px-4 py-2.5 text-sm rounded-lg border border-border hover:bg-secondary transition-colors"
              :disabled="isUpdating"
            >
              Cancel
            </button>
            <button
              @click="handleConfirm"
              class="flex-1 px-4 py-2.5 text-sm rounded-lg bg-primary text-white hover:bg-primary/90 transition-colors disabled:opacity-50"
              :disabled="isUpdating || selectedRole === currentRole"
            >
              <Loader2 v-if="isUpdating" class="w-4 h-4 inline mr-2 animate-spin" />
              Confirm
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { X, Loader2 } from 'lucide-vue-next';
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

const { addStewardToOrgMultisig } = useAdminActions();

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

const selectedRole = ref(props.currentRole);
const isUpdating = ref(false);
const error = ref<string | null>(null);

watch(() => props.show, (isOpen) => {
  if (isOpen) {
    selectedRole.value = props.currentRole;
    error.value = null;
  }
});

async function handleConfirm() {
  if (selectedRole.value === props.currentRole) return;

  isUpdating.value = true;
  error.value = null;

  try {
    // 1. Update role in backend (CommunityProfile)
    const result = await updateMemberRole(props.memberAid, selectedRole.value);
    if (result.error) {
      error.value = result.error;
      return;
    }

    // 2. If promoting to steward role, add to org multisig
    if (STEWARD_ROLES.includes(selectedRole.value)) {
      console.log(`[ChangeRoleModal] Promoting to ${selectedRole.value}, triggering multisig rotation...`);
      const multisigOk = await addStewardToOrgMultisig(props.memberAid);
      if (!multisigOk) {
        console.warn('[ChangeRoleModal] Multisig rotation failed, role updated but steward cannot yet issue credentials');
      }
    }

    emit('role-updated', selectedRole.value);
    emit('close');
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to update role';
  } finally {
    isUpdating.value = false;
  }
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
