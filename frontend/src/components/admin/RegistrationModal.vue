<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="show" class="modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4" @click.self="$emit('close')">
        <div class="modal-content bg-card border border-border rounded-2xl shadow-xl max-w-lg w-full max-h-[90vh] overflow-hidden">
          <!-- Header -->
          <div class="modal-header bg-primary p-4 border-b border-white/20 flex items-center justify-between">
            <h3 class="font-semibold text-lg text-white">Registration Details</h3>
            <q-btn flat @click="$emit('close')" class="p-1.5 rounded-lg transition-colors">
              <X class="w-5 h-5 text-white" />
            </q-btn>
          </div>

          <!-- Content -->
          <div class="modal-body p-4 overflow-y-auto max-h-[60vh]">
            <!-- Applicant Info -->
            <div class="flex items-start gap-4 mb-6">
              <div class="avatar w-16 h-16 rounded-full flex items-center justify-center shrink-0 overflow-hidden" :class="!hasAvatar && avatarClass">
                <img
                  v-if="hasAvatar"
                  :src="avatarUrl"
                  alt="Profile"
                  class="w-full h-full object-cover"
                  @error="avatarError = true"
                />
                <span v-else class="text-white text-xl font-semibold">{{ initials }}</span>
              </div>
              <div class="flex-1 min-w-0">
                <h4 class="text-lg font-medium text-black">{{ registration?.profile.name }}</h4>
                <p class="text-sm text-black/70 mb-2">
                  Submitted {{ formattedDate }}
                </p>
                <div class="flex items-center gap-2">
                  <code class="text-xs bg-secondary px-2 py-1 rounded font-mono truncate flex-1 text-black">
                    {{ registration?.applicantAid }}
                  </code>
                  <button
                    @click="copyAid"
                    class="p-1.5 rounded hover:bg-secondary transition-colors shrink-0"
                    :title="copied ? 'Copied!' : 'Copy AID'"
                  >
                    <Check v-if="copied" class="w-4 h-4 text-green-600" />
                    <Copy v-else class="w-4 h-4 text-black/60" />
                  </button>
                </div>
              </div>
            </div>

            <!-- Profile Fields -->
            <div class="space-y-4 mb-6">
              <!-- Email -->
              <div class="profile-field">
                <h5 class="field-label">Email</h5>
                <p class="field-value">{{ registration?.profile.email || 'Not provided' }}</p>
              </div>

              <!-- About -->
              <div class="profile-field">
                <h5 class="field-label">About</h5>
                <p class="field-value">{{ registration?.profile.bio || 'Not provided' }}</p>
              </div>

              <!-- Location -->
              <div class="profile-field">
                <h5 class="field-label">Location</h5>
                <p class="field-value">{{ registration?.profile.location || 'Not provided' }}</p>
              </div>

              <!-- Indigenous Community -->
              <div class="profile-field">
                <h5 class="field-label">Indigenous Community</h5>
                <p class="field-value">{{ registration?.profile.indigenousCommunity || 'Not provided' }}</p>
              </div>

              <!-- Join Reason -->
              <div class="profile-field">
                <h5 class="field-label">Why they want to join</h5>
                <p class="field-value">{{ registration?.profile.joinReason || 'Not provided' }}</p>
              </div>

              <!-- Participation Interests -->
              <div class="profile-field">
                <h5 class="field-label">Participation Interests</h5>
                <div v-if="registration?.profile.interests && registration.profile.interests.length" class="flex flex-wrap gap-2">
                  <span
                    v-for="interest in registration.profile.interests"
                    :key="interest"
                    class="interest-chip"
                  >
                    {{ getInterestLabel(interest) }}
                  </span>
                </div>
                <p v-else class="field-value">Not provided</p>
              </div>

              <!-- Custom Interests -->
              <div class="profile-field">
                <h5 class="field-label">Additional Interests</h5>
                <p class="field-value">{{ registration?.profile.customInterests || 'Not provided' }}</p>
              </div>

              <!-- Social Links -->
              <div class="profile-field">
                <h5 class="field-label">Social Links</h5>
                <div v-if="hasSocialLinks" class="flex flex-wrap gap-3">
                  <a
                    v-if="registration?.profile.facebookUrl"
                    :href="registration.profile.facebookUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="social-link"
                  >
                    Facebook
                  </a>
                  <a
                    v-if="registration?.profile.linkedinUrl"
                    :href="registration.profile.linkedinUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="social-link"
                  >
                    LinkedIn
                  </a>
                  <a
                    v-if="registration?.profile.twitterUrl"
                    :href="registration.profile.twitterUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="social-link"
                  >
                    X (Twitter)
                  </a>
                  <a
                    v-if="registration?.profile.instagramUrl"
                    :href="registration.profile.instagramUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="social-link"
                  >
                    Instagram
                  </a>
                </div>
                <p v-else class="field-value">Not provided</p>
              </div>
            </div>

            <!-- Decline Reason -->
            <div v-if="showDeclineReason" class="mb-6">
              <h5 class="text-sm font-medium text-black/70 mb-2">Reason for Decline (optional)</h5>
              <textarea
                v-model="declineReason"
                class="w-full p-3 border border-border rounded-lg bg-background text-black resize-none focus:outline-none focus:ring-2 focus:ring-primary/50"
                rows="2"
                placeholder="Provide a reason for declining..."
              />
            </div>

            <!-- Error Message -->
            <div v-if="error" class="mb-4 p-3 bg-destructive/10 border border-destructive/20 rounded-lg">
              <p class="text-sm text-destructive">{{ error }}</p>
            </div>
          </div>

          <!-- Footer Actions -->
          <div class="modal-footer p-4 border-t border-border">
            <div v-if="!showDeclineReason" class="flex items-center gap-3">
              <button
                @click="handleApprove"
                class="flex-1 px-4 py-2.5 text-sm rounded-lg bg-primary text-white hover:bg-primary/90 transition-colors"
                :disabled="isProcessing"
              >
                <Loader2 v-if="isProcessing && action === 'approve'" class="w-4 h-4 inline mr-2 animate-spin" />
                Approve
              </button>
              <button
                @click="showDeclineReason = true"
                class="flex-1 px-4 py-2.5 text-sm rounded-lg bg-orange-500 text-white hover:bg-orange-600 transition-colors"
                :disabled="isProcessing"
              >
                Decline
              </button>
            </div>

            <!-- Decline Actions -->
            <div v-else class="flex items-center gap-3">
              <button
                @click="showDeclineReason = false; declineReason = ''"
                class="flex-1 px-4 py-2.5 text-sm rounded-lg border border-border hover:bg-secondary transition-colors"
                :disabled="isProcessing"
              >
                Cancel
              </button>
              <button
                @click="handleDecline"
                class="flex-1 px-4 py-2.5 text-sm rounded-lg bg-destructive text-white hover:bg-destructive/90 transition-colors"
                :disabled="isProcessing"
              >
                <Loader2 v-if="isProcessing && action === 'decline'" class="w-4 h-4 inline mr-2 animate-spin" />
                <X v-else class="w-4 h-4 inline mr-2" />
                Confirm Decline
              </button>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { X, Check, Copy, Loader2 } from 'lucide-vue-next';
import type { PendingRegistration } from 'src/composables/useRegistrationPolling';
import { getFileUrl } from 'src/lib/api/client';
import { PARTICIPATION_INTERESTS } from 'stores/onboarding';

// Map interest value to human-readable label
const interestLabelMap: Map<string, string> = new Map(
  PARTICIPATION_INTERESTS.map(i => [i.value, i.label])
);

function getInterestLabel(value: string): string {
  return interestLabelMap.get(value) || value.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

interface Props {
  show: boolean;
  registration: PendingRegistration | null;
  isProcessing?: boolean;
  error?: string | null;
}

const props = withDefaults(defineProps<Props>(), {
  isProcessing: false,
  error: null,
});

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'approve', registration: PendingRegistration): void;
  (e: 'decline', registration: PendingRegistration, reason?: string): void;
}>();

// Local state
const showDeclineReason = ref(false);
const declineReason = ref('');
const copied = ref(false);
const action = ref<'approve' | 'decline' | null>(null);

// Reset state when modal closes
watch(() => props.show, (isOpen) => {
  if (!isOpen) {
    showDeclineReason.value = false;
    declineReason.value = '';
    action.value = null;
  }
});

// Avatar image handling
const avatarError = ref(false);
const hasAvatar = computed(() => {
  // Check for either base64 data (preferred) or file ref
  const hasBase64 = !!props.registration?.profile.avatarData && !!props.registration?.profile.avatarMimeType;
  const hasRef = !!props.registration?.profile.avatarFileRef && !avatarError.value;
  return hasBase64 || hasRef;
});
const avatarUrl = computed(() => {
  // Prefer base64 data URL (works cross-backend)
  if (props.registration?.profile.avatarData && props.registration?.profile.avatarMimeType) {
    return `data:${props.registration.profile.avatarMimeType};base64,${props.registration.profile.avatarData}`;
  }
  // Fallback to file ref URL
  if (props.registration?.profile.avatarFileRef) {
    return getFileUrl(props.registration.profile.avatarFileRef);
  }
  return '';
});

// Reset avatar error when registration changes
watch(() => props.registration, () => {
  avatarError.value = false;
});

// Avatar initials (fallback)
const initials = computed(() => {
  const name = props.registration?.profile.name || '';
  const parts = name.split(' ');
  if (parts.length >= 2) {
    return `${parts[0].charAt(0)}${parts[1].charAt(0)}`.toUpperCase();
  }
  return name.substring(0, 2).toUpperCase();
});

// Avatar color (fallback)
const avatarClass = computed(() => {
  const colors = ['gradient-1', 'gradient-2', 'gradient-3', 'gradient-4'];
  const name = props.registration?.profile.name || '';
  const hash = name.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return colors[hash % colors.length];
});

// Formatted date
const formattedDate = computed(() => {
  if (!props.registration) return '';
  const date = new Date(props.registration.profile.submittedAt);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
});

// Check if any social links exist
const hasSocialLinks = computed(() => {
  if (!props.registration) return false;
  const { facebookUrl, linkedinUrl, twitterUrl, instagramUrl } = props.registration.profile;
  return !!(facebookUrl || linkedinUrl || twitterUrl || instagramUrl);
});

// Copy AID to clipboard
function copyAid() {
  if (props.registration?.applicantAid) {
    navigator.clipboard.writeText(props.registration.applicantAid);
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 2000);
  }
}

// Action handlers
function handleApprove() {
  if (props.registration) {
    action.value = 'approve';
    emit('approve', props.registration);
  }
}

function handleDecline() {
  if (props.registration) {
    action.value = 'decline';
    emit('decline', props.registration, declineReason.value || undefined);
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

.avatar {
  &.gradient-1 {
    background: linear-gradient(135deg, var(--matou-primary), var(--matou-accent));
  }
  &.gradient-2 {
    background: linear-gradient(135deg, var(--matou-accent), var(--matou-chart-2));
  }
  &.gradient-3 {
    background: linear-gradient(135deg, var(--matou-chart-2), var(--matou-primary));
  }
  &.gradient-4 {
    background: linear-gradient(135deg, rgba(30, 95, 116, 0.8), rgba(74, 157, 156, 0.8));
  }
}

.profile-field {
  padding-bottom: 0.75rem;
  border-bottom: 1px solid var(--matou-border);

  &:last-child {
    border-bottom: none;
    padding-bottom: 0;
  }
}

.field-label {
  font-size: 0.75rem;
  font-weight: 500;
  color: rgba(0, 0, 0, 0.7);
  margin-bottom: 0.25rem;
}

.field-value {
  font-size: 0.875rem;
  color: black;
  white-space: pre-wrap;
}

.interest-chip {
  display: inline-flex;
  align-items: center;
  padding: 0.5rem 1rem;
  font-size: 0.875rem;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  border-radius: 9999px;
  background-color: var(--matou-primary);
  color: white;
  opacity: 0.9;
}

.social-link {
  display: inline-flex;
  align-items: center;
  padding: 0.375rem 0.75rem;
  font-size: 0.75rem;
  font-weight: 500;
  border-radius: 0.5rem;
  background-color: var(--matou-secondary);
  color: var(--matou-primary);
  text-decoration: none;
  transition: background-color 0.2s;

  &:hover {
    background-color: var(--matou-primary);
    color: white;
  }
}

// Modal transition
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
