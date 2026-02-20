<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="show" class="modal-overlay fixed inset-0 z-50 flex items-center justify-center p-4" @click.self="$emit('close')">
        <div class="modal-content bg-card border border-border rounded-2xl shadow-xl max-w-lg w-full max-h-[90vh] overflow-hidden">
          <!-- Header -->
          <div class="modal-header bg-primary p-4 border-b border-white/20 flex items-center justify-between">
            <h3 class="font-semibold text-lg text-white">{{ headerTitle }}</h3>
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
                <h4 class="text-lg font-medium text-black">{{ profileName }}</h4>
                <p class="text-sm text-black/70 mb-2">
                  {{ formattedDate }}
                </p>
                <div v-if="profileAid" class="flex items-center gap-2">
                  <code class="text-xs bg-secondary px-2 py-1 rounded font-mono truncate flex-1 text-black">
                    {{ profileAid }}
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
                <p class="field-value">{{ profileFields.email || 'Not provided' }}</p>
              </div>

              <!-- About -->
              <div class="profile-field">
                <h5 class="field-label">About</h5>
                <p class="field-value">{{ profileFields.bio || 'Not provided' }}</p>
              </div>

              <!-- Location -->
              <div class="profile-field">
                <h5 class="field-label">Location</h5>
                <p class="field-value">{{ profileFields.location || 'Not provided' }}</p>
              </div>

              <!-- Indigenous Community -->
              <div class="profile-field">
                <h5 class="field-label">Indigenous Community</h5>
                <p class="field-value">{{ profileFields.indigenousCommunity || 'Not provided' }}</p>
              </div>

              <!-- Join Reason -->
              <div class="profile-field">
                <h5 class="field-label">Why they want to join</h5>
                <p class="field-value">{{ profileFields.joinReason || 'Not provided' }}</p>
              </div>

              <!-- Participation Interests -->
              <div class="profile-field">
                <h5 class="field-label">Participation Interests</h5>
                <div v-if="profileFields.interests.length" class="flex flex-wrap gap-2">
                  <span
                    v-for="interest in profileFields.interests"
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
                <p class="field-value">{{ profileFields.customInterests || 'Not provided' }}</p>
              </div>

              <!-- Social Links -->
              <div class="profile-field">
                <h5 class="field-label">Social Links</h5>
                <div v-if="hasSocialLinks" class="flex flex-wrap gap-3">
                  <a
                    v-if="profileFields.facebookUrl"
                    :href="profileFields.facebookUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="social-link"
                  >
                    Facebook
                  </a>
                  <a
                    v-if="profileFields.linkedinUrl"
                    :href="profileFields.linkedinUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="social-link"
                  >
                    LinkedIn
                  </a>
                  <a
                    v-if="profileFields.twitterUrl"
                    :href="profileFields.twitterUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="social-link"
                  >
                    X (Twitter)
                  </a>
                  <a
                    v-if="profileFields.instagramUrl"
                    :href="profileFields.instagramUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="social-link"
                  >
                    Instagram
                  </a>
                  <a
                    v-if="profileFields.githubUrl"
                    :href="profileFields.githubUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="social-link"
                  >
                    GitHub
                  </a>
                  <a
                    v-if="profileFields.gitlabUrl"
                    :href="profileFields.gitlabUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="social-link"
                  >
                    GitLab
                  </a>
                </div>
                <p v-else class="field-value">Not provided</p>
              </div>
            </div>

            <!-- Endorsements Section -->
            <div v-if="props.endorsements.length > 0 || profileStatus === 'pending'" class="endorsements-section mb-6">
              <h5 class="field-label mb-3">
                Community Endorsements
                <span v-if="props.endorsements.length > 0" class="endorsement-count">
                  ({{ props.endorsements.length }})
                </span>
              </h5>
              <div v-if="props.endorsements.length > 0" class="endorsement-list space-y-2">
                <div
                  v-for="endorsement in props.endorsements"
                  :key="endorsement.credentialSaid"
                  class="endorsement-item"
                >
                  <div class="flex items-center gap-2">
                    <ThumbsUp class="w-3.5 h-3.5 text-white shrink-0" />
                    <span class="text-sm font-medium text-white">{{ endorsement.endorserName }}</span>
                    <span class="text-xs text-white/60">{{ formatEndorsementDate(endorsement.endorsedAt) }}</span>
                  </div>
                  <p v-if="endorsement.message" class="text-xs text-white/80 mt-1 ml-5">
                    "{{ endorsement.message }}"
                  </p>
                </div>
              </div>
              <p v-else-if="profileStatus === 'pending'" class="text-sm text-black/50">
                No endorsements yet
              </p>
            </div>

            <!-- Error Message -->
            <div v-if="error" class="mb-4 p-3 bg-destructive/10 border border-destructive/20 rounded-lg">
              <p class="text-sm text-destructive">{{ error }}</p>
            </div>
          </div>

          <!-- Footer Actions -->
          <div v-if="profileStatus === 'pending'" class="modal-footer p-4 border-t border-border">
            <!-- Endorse message textarea -->
            <div v-if="showEndorseMessage" class="mb-4">
              <h5 class="field-label">Endorsement reason</h5>
              <textarea
                v-model="endorseMessage"
                class="field-input"
                rows="2"
                placeholder="Why do you endorse this person?"
                required
              />
            </div>

            <!-- Decline reason textarea (steward only) -->
            <div v-if="showDeclineReason" class="mb-4">
              <h5 class="field-label">Reason for Decline (optional)</h5>
              <textarea
                v-model="declineReason"
                class="field-input"
                rows="2"
                placeholder="Provide a reason for declining..."
              />
            </div>

            <!-- Main action buttons -->
            <div v-if="!showDeclineReason && !showEndorseMessage" class="flex items-center gap-3">
              <button
                v-if="!props.hasEndorsed"
                @click="showEndorseMessage = true"
                class="flex-1 px-4 py-2.5 text-sm rounded-lg bg-accent text-white hover:bg-accent/90 transition-colors"
                :disabled="isProcessing || isEndorsing"
              >
                <ThumbsUp class="w-4 h-4 inline mr-2" />
                Endorse
              </button>
              <button
                v-else
                class="flex-1 px-4 py-2.5 text-sm rounded-lg bg-accent/20 text-accent cursor-default"
                disabled
              >
                <ThumbsUp class="w-4 h-4 inline mr-2" />
                Endorsed
              </button>

              <button
                v-if="props.isSteward && registration"
                @click="handleApprove"
                class="flex-1 px-4 py-2.5 text-sm rounded-lg bg-primary text-white hover:bg-primary/90 transition-colors"
                :disabled="isProcessing"
              >
                <Loader2 v-if="isProcessing && action === 'approve'" class="w-4 h-4 inline mr-2 animate-spin" />
                Admit
              </button>

              <button
                v-if="props.isSteward && registration"
                @click="showDeclineReason = true"
                class="px-4 py-2.5 text-sm rounded-lg bg-orange-500 text-white hover:bg-orange-600 transition-colors"
                :disabled="isProcessing"
              >
                Decline
              </button>
            </div>

            <!-- Endorse confirmation buttons -->
            <div v-if="showEndorseMessage" class="flex items-center gap-3">
              <button
                @click="showEndorseMessage = false; endorseMessage = ''"
                class="flex-1 px-4 py-2.5 text-sm rounded-lg border border-border hover:bg-secondary transition-colors"
                :disabled="props.isEndorsing"
              >
                Cancel
              </button>
              <button
                @click="handleEndorse"
                class="flex-1 px-4 py-2.5 text-sm rounded-lg bg-accent text-white hover:bg-accent/90 transition-colors disabled:opacity-50"
                :disabled="props.isEndorsing || !endorseMessage.trim()"
              >
                <Loader2 v-if="props.isEndorsing" class="w-4 h-4 inline mr-2 animate-spin" />
                <ThumbsUp v-else class="w-4 h-4 inline mr-2" />
                Confirm Endorsement
              </button>
            </div>

            <!-- Decline confirmation buttons (steward only) -->
            <div v-if="showDeclineReason" class="flex items-center gap-3">
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
import { X, Check, Copy, Loader2, ThumbsUp } from 'lucide-vue-next';
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
  registration?: PendingRegistration | null;
  sharedProfile?: Record<string, unknown> | null;
  communityProfile?: Record<string, unknown> | null;
  isProcessing?: boolean;
  error?: string | null;
  isSteward?: boolean;
  currentUserAid?: string;
  endorsements?: Array<{
    endorserAid: string;
    endorserName: string;
    credentialSaid: string;
    endorsedAt: string;
    message?: string;
  }>;
  hasEndorsed?: boolean;
  isEndorsing?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  registration: null,
  sharedProfile: null,
  communityProfile: null,
  isProcessing: false,
  error: null,
  isSteward: false,
  currentUserAid: '',
  endorsements: () => [],
  hasEndorsed: false,
  isEndorsing: false,
});

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'approve', registration: PendingRegistration): void;
  (e: 'decline', registration: PendingRegistration, reason?: string): void;
  (e: 'endorse', message?: string): void;
}>();

// Unified computed properties for both data sources
const profileName = computed(() => {
  if (props.registration) return props.registration.profile.name;
  return (props.sharedProfile?.displayName as string) || 'Unknown';
});

const profileAid = computed(() => {
  if (props.registration) return props.registration.applicantAid;
  return (props.sharedProfile?.aid as string) || '';
});

const profileStatus = computed(() => {
  if (props.registration) return 'pending';
  return (props.sharedProfile?.status as string) || 'approved';
});

const headerTitle = computed(() => {
  if (props.registration) return 'Registration Details';
  if (profileStatus.value === 'pending') return 'Pending Member';
  return 'Member Profile';
});

const profileFields = computed(() => {
  if (props.registration) {
    const p = props.registration.profile;
    return {
      email: p.email || '',
      bio: p.bio || '',
      location: p.location || '',
      indigenousCommunity: p.indigenousCommunity || '',
      joinReason: p.joinReason || '',
      interests: p.interests || [],
      customInterests: p.customInterests || '',
      facebookUrl: p.facebookUrl || '',
      linkedinUrl: p.linkedinUrl || '',
      twitterUrl: p.twitterUrl || '',
      instagramUrl: p.instagramUrl || '',
      githubUrl: p.githubUrl || '',
      gitlabUrl: p.gitlabUrl || '',
    };
  }
  const s = props.sharedProfile || {};
  return {
    email: (s.publicEmail as string) || '',
    bio: (s.bio as string) || '',
    location: (s.location as string) || '',
    indigenousCommunity: (s.indigenousCommunity as string) || '',
    joinReason: (s.joinReason as string) || '',
    interests: (s.participationInterests as string[]) || [],
    customInterests: (s.customInterests as string) || '',
    facebookUrl: (s.facebookUrl as string) || '',
    linkedinUrl: (s.linkedinUrl as string) || '',
    twitterUrl: (s.twitterUrl as string) || '',
    instagramUrl: (s.instagramUrl as string) || '',
    githubUrl: (s.githubUrl as string) || '',
    gitlabUrl: (s.gitlabUrl as string) || '',
  };
});

// Local state
const showDeclineReason = ref(false);
const declineReason = ref('');
const copied = ref(false);
const action = ref<'approve' | 'decline' | null>(null);

// Endorsement state
const showEndorseMessage = ref(false);
const endorseMessage = ref('');

function formatEndorsementDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function handleEndorse() {
  emit('endorse', endorseMessage.value || undefined);
}

// Reset endorsement form after endorsement completes
watch(() => props.isEndorsing, (endorsing, wasEndorsing) => {
  if (wasEndorsing && !endorsing) {
    showEndorseMessage.value = false;
    endorseMessage.value = '';
  }
});

// Reset state when modal closes
watch(() => props.show, (isOpen) => {
  if (!isOpen) {
    showDeclineReason.value = false;
    declineReason.value = '';
    showEndorseMessage.value = false;
    endorseMessage.value = '';
    action.value = null;
  }
});

// Avatar image handling
const avatarError = ref(false);
const hasAvatar = computed(() => {
  if (props.registration) {
    const hasBase64 = !!props.registration.profile.avatarData && !!props.registration.profile.avatarMimeType;
    const hasRef = !!props.registration.profile.avatarFileRef && !avatarError.value;
    return hasBase64 || hasRef;
  }
  const ref = (props.sharedProfile?.avatar as string) || '';
  return !!ref && !avatarError.value;
});
const avatarUrl = computed(() => {
  if (props.registration) {
    if (props.registration.profile.avatarData && props.registration.profile.avatarMimeType) {
      return `data:${props.registration.profile.avatarMimeType};base64,${props.registration.profile.avatarData}`;
    }
    if (props.registration.profile.avatarFileRef) {
      return getFileUrl(props.registration.profile.avatarFileRef);
    }
    return '';
  }
  const ref = (props.sharedProfile?.avatar as string) || '';
  if (!ref) return '';
  if (ref.startsWith('http') || ref.startsWith('data:')) return ref;
  return getFileUrl(ref);
});

// Reset avatar error when data changes
watch(() => [props.registration, props.sharedProfile], () => {
  avatarError.value = false;
});

// Avatar initials (fallback)
const initials = computed(() => {
  const name = profileName.value;
  const parts = name.split(' ');
  if (parts.length >= 2) {
    return `${parts[0].charAt(0)}${parts[1].charAt(0)}`.toUpperCase();
  }
  return name.substring(0, 2).toUpperCase();
});

// Avatar color (fallback)
const avatarClass = computed(() => {
  const colors = ['gradient-1', 'gradient-2', 'gradient-3', 'gradient-4'];
  const name = profileName.value;
  const hash = name.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return colors[hash % colors.length];
});

// Formatted date
const formattedDate = computed(() => {
  if (props.registration) {
    const date = new Date(props.registration.profile.submittedAt);
    return 'Submitted ' + date.toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  }
  // For SharedProfile, use createdAt or memberSince from communityProfile
  const communityData = props.communityProfile || {};
  const memberSince = communityData.memberSince as string;
  if (memberSince) {
    const date = new Date(memberSince);
    return 'Joined ' + date.toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    });
  }
  const createdAt = (props.sharedProfile?.createdAt as string) || '';
  if (createdAt) {
    const date = new Date(createdAt);
    return 'Applied ' + date.toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    });
  }
  return '';
});

// Check if any social links exist
const hasSocialLinks = computed(() => {
  const f = profileFields.value;
  return !!(f.facebookUrl || f.linkedinUrl || f.twitterUrl || f.instagramUrl || f.githubUrl || f.gitlabUrl);
});

// Copy AID to clipboard
function copyAid() {
  const aid = profileAid.value;
  if (aid) {
    navigator.clipboard.writeText(aid);
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
  display: block;
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--matou-muted-foreground, #6b7280);
  margin-bottom: 0.375rem;
  text-transform: uppercase;
  letter-spacing: 0.025em;
}

.field-input {
  background: #f0f9fa;
  border: 1px solid #d1e7ea;
  border-radius: 0.5rem;
  padding: 0.75rem 1rem;
  font-size: 0.875rem;
  color: var(--matou-foreground, #1f2937);
  width: 100%;
  font-family: inherit;
  outline: none;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
  box-sizing: border-box;
}

.field-input:hover {
  border-color: #a8d4da;
}

.field-input:focus {
  border-color: #1a4f5e;
  box-shadow: 0 0 0 2px rgba(26, 79, 94, 0.1);
}

.field-input::placeholder {
  color: #9ca3af;
}

textarea.field-input {
  resize: vertical;
  min-height: 60px;
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

.endorsements-section {
  padding-top: 0.75rem;
  border-top: 1px solid var(--matou-border);
}

.endorsement-count {
  font-weight: 400;
}

.endorsement-item {
  padding: 0.5rem;
  border-radius: 0.5rem;
  background-color: var(--matou-primary, #6366f1);
  color: white;
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
