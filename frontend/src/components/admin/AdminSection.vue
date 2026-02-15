<template>
  <div class="admin-section">
    <!-- Section Header -->
    <div class="section-header flex items-center justify-between mb-4">
      <div class="flex items-center gap-3">
        <h3 class="text-lg font-semibold text-foreground">Pending Registrations</h3>
        <span
          v-if="registrations.length > 0"
          class="count-badge px-2 py-0.5 text-xs font-medium rounded-full bg-primary text-white"
        >
          {{ registrations.length }}
        </span>
      </div>
      <div class="flex items-center gap-2">
        <!-- Polling indicator -->
        <span v-if="isPolling" class="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span class="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          Auto-refreshing
        </span>
        <!-- Manual refresh button -->
        <button
          @click="$emit('refresh')"
          class="p-2 rounded-lg hover:bg-secondary transition-colors"
          title="Refresh"
          :disabled="isPolling"
        >
          <RefreshCw class="w-4 h-4 text-muted-foreground" :class="{ 'animate-spin': isRefreshing }" />
        </button>
      </div>
    </div>

    <!-- Error State -->
    <div v-if="error" class="error-box mb-4 p-4 bg-destructive/10 border border-destructive/20 rounded-xl">
      <p class="text-sm text-destructive mb-2">{{ error }}</p>
      <button
        @click="$emit('retry')"
        class="text-sm text-primary hover:underline"
      >
        Try again
      </button>
    </div>

    <!-- Empty State -->
    <div v-else-if="registrations.length === 0" class="empty-state bg-secondary/30 rounded-xl p-8 text-center">
      <div class="icon-box mx-auto mb-4 w-16 h-16 rounded-full bg-secondary flex items-center justify-center">
        <Inbox class="w-8 h-8 text-muted-foreground" />
      </div>
      <h4 class="text-foreground font-medium mb-2">No pending registrations</h4>
      <p class="text-sm text-muted-foreground">
        New registration requests will appear here automatically.
      </p>
    </div>

    <!-- Registrations List -->
    <div v-else class="registrations-list space-y-3">
      <!-- Processing Banner -->
      <div v-if="isProcessing" class="processing-banner p-3 bg-primary/10 border border-primary/20 rounded-xl flex items-center gap-2">
        <Loader2 class="w-4 h-4 text-primary animate-spin" />
        <span class="text-sm text-primary font-medium">Processing membership action... Other actions are disabled until this completes.</span>
      </div>
      <RegistrationCard
        v-for="registration in registrations"
        :key="registration.notificationId"
        :registration="registration"
        :disabled="isProcessing"
        :is-active-processing="processingRegistrationId === registration.notificationId"
        @approve="handleApprove"
        @decline="handleDecline"
        @view="openViewModal"
      />
    </div>

    <!-- Registration Modal -->
    <RegistrationModal
      :show="showModal"
      :registration="selectedRegistration"
      :is-processing="isProcessing"
      :error="actionError"
      @close="closeModal"
      @approve="handleApprove"
      @decline="handleDecline"
    />

    <!-- Success Toast -->
    <Transition name="toast">
      <div v-if="showSuccessToast" class="success-toast fixed bottom-4 right-4 bg-green-600 text-white px-4 py-3 rounded-lg shadow-lg flex items-center gap-2">
        <CheckCircle class="w-5 h-5" />
        <span>{{ successMessage }}</span>
      </div>
    </Transition>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { RefreshCw, Inbox, CheckCircle, Loader2 } from 'lucide-vue-next';
import RegistrationCard from './RegistrationCard.vue';
import RegistrationModal from './RegistrationModal.vue';
import type { PendingRegistration } from 'src/composables/useRegistrationPolling';

interface Props {
  registrations: PendingRegistration[];
  isPolling?: boolean;
  isRefreshing?: boolean;
  isProcessing?: boolean;
  processingRegistrationId?: string | null;
  error?: string | null;
  actionError?: string | null;
}

const props = withDefaults(defineProps<Props>(), {
  isPolling: false,
  isRefreshing: false,
  isProcessing: false,
  processingRegistrationId: null,
  error: null,
  actionError: null,
});

const emit = defineEmits<{
  (e: 'approve', registration: PendingRegistration): void;
  (e: 'decline', registration: PendingRegistration, reason?: string): void;
  (e: 'refresh'): void;
  (e: 'retry'): void;
}>();

// Modal state
const showModal = ref(false);
const selectedRegistration = ref<PendingRegistration | null>(null);

// Success toast
const showSuccessToast = ref(false);
const successMessage = ref('');

// Open modal for viewing registration details
function openViewModal(registration: PendingRegistration) {
  selectedRegistration.value = registration;
  showModal.value = true;
}

// Close modal
function closeModal() {
  showModal.value = false;
  selectedRegistration.value = null;
}

// Handle approve
function handleApprove(registration: PendingRegistration) {
  emit('approve', registration);
}

// Handle decline
function handleDecline(registration: PendingRegistration, reason?: string) {
  emit('decline', registration, reason);
}

// Show success toast
function showSuccess(message: string) {
  successMessage.value = message;
  showSuccessToast.value = true;
  setTimeout(() => {
    showSuccessToast.value = false;
  }, 3000);
}

// Close modal and show success when processing completes
watch(() => props.isProcessing, (processing, wasProcessing) => {
  if (wasProcessing && !processing && !props.actionError) {
    closeModal();
    showSuccess('Action completed successfully');
  }
});

// Expose showSuccess for parent to call
defineExpose({ showSuccess });
</script>

<style lang="scss" scoped>
.admin-section {
  background-color: var(--matou-card);
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius-xl);
  padding: 1.25rem;
}

.count-badge {
  min-width: 1.5rem;
  text-align: center;
}

.error-box {
  background-color: rgba(var(--matou-destructive-rgb, 220, 38, 38), 0.1);
}

.empty-state {
  background-color: rgba(232, 244, 248, 0.3);
}

// Toast animation
.toast-enter-active,
.toast-leave-active {
  transition: all 0.3s ease;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(1rem);
}
</style>
