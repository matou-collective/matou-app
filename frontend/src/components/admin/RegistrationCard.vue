<template>
  <div
    class="registration-card bg-card border border-border rounded-xl p-4 hover:shadow-md transition-shadow cursor-pointer"
    @click="$emit('view', registration)"
  >
    <!-- Header with avatar and name -->
    <div class="flex items-start gap-3 mb-3">
      <!-- Avatar with image or initials fallback -->
      <div class="avatar w-12 h-12 rounded-full flex items-center justify-center shrink-0 overflow-hidden" :class="!hasAvatar && avatarClass">
        <img
          v-if="hasAvatar"
          :src="avatarUrl"
          alt="Profile"
          class="w-full h-full object-cover"
          @error="avatarError = true"
        />
        <span v-else class="text-white font-semibold">{{ initials }}</span>
      </div>
      <div class="flex-1 min-w-0">
        <h4 class="font-medium text-foreground truncate">{{ registration.profile.name }}</h4>
        <p class="text-sm text-muted-foreground truncate" :title="registration.applicantAid">
          {{ shortenedAid }}
        </p>
      </div>
      <span class="text-xs text-muted-foreground whitespace-nowrap">
        {{ timeAgo }}
      </span>
    </div>

    <!-- Bio -->
    <p v-if="registration.profile.bio" class="text-sm text-muted-foreground mb-3 line-clamp-2">
      {{ registration.profile.bio }}
    </p>

    <!-- Interests as pills -->
    <div v-if="registration.profile.interests.length > 0" class="flex flex-wrap gap-2 mb-4">
      <span
        v-for="interest in displayedInterests"
        :key="interest"
        class="interest-chip"
      >
        {{ getInterestLabel(interest) }}
      </span>
      <span
        v-if="remainingInterestsCount > 0"
        class="interest-chip interest-chip--more"
      >
        +{{ remainingInterestsCount }} more
      </span>
    </div>

    <!-- Actions -->
    <div class="flex items-center gap-2" @click.stop>
      <button
        @click="$emit('approve', registration)"
        class="action-btn flex-1 px-3 py-2 text-sm rounded-lg bg-primary text-white hover:bg-primary/90 transition-colors"
        :disabled="disabled"
      >
        Approve
      </button>
      <button
        @click="$emit('decline', registration)"
        class="action-btn flex-1 px-3 py-2 text-sm rounded-lg bg-orange-500 text-white hover:bg-orange-600 transition-colors"
        :disabled="disabled"
      >
        Decline
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { Check, X } from 'lucide-vue-next';
import type { PendingRegistration } from 'src/composables/useRegistrationPolling';
import { getFileUrl } from 'src/lib/api/client';
import { PARTICIPATION_INTERESTS } from 'stores/onboarding';

// Map interest value to human-readable label
const interestLabelMap = new Map(
  PARTICIPATION_INTERESTS.map(i => [i.value, i.label])
);

function getInterestLabel(value: string): string {
  return interestLabelMap.get(value) || value.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

interface Props {
  registration: PendingRegistration;
  disabled?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  disabled: false,
});

defineEmits<{
  (e: 'approve', registration: PendingRegistration): void;
  (e: 'decline', registration: PendingRegistration): void;
  (e: 'view', registration: PendingRegistration): void;
}>();

// Avatar image handling
const avatarError = ref(false);
const hasAvatar = computed(() => {
  // Check for either base64 data (preferred) or file ref
  const hasBase64 = !!props.registration.profile.avatarData && !!props.registration.profile.avatarMimeType;
  const hasRef = !!props.registration.profile.avatarFileRef && !avatarError.value;
  return hasBase64 || hasRef;
});
const avatarUrl = computed(() => {
  // Prefer base64 data URL (works cross-backend)
  if (props.registration.profile.avatarData && props.registration.profile.avatarMimeType) {
    return `data:${props.registration.profile.avatarMimeType};base64,${props.registration.profile.avatarData}`;
  }
  // Fallback to file ref URL
  if (props.registration.profile.avatarFileRef) {
    return getFileUrl(props.registration.profile.avatarFileRef);
  }
  return '';
});

// Avatar initials from name (fallback)
const initials = computed(() => {
  const parts = props.registration.profile.name.split(' ');
  if (parts.length >= 2) {
    return `${parts[0].charAt(0)}${parts[1].charAt(0)}`.toUpperCase();
  }
  return props.registration.profile.name.substring(0, 2).toUpperCase();
});

// Avatar color based on name hash (fallback)
const avatarClass = computed(() => {
  const colors = ['gradient-1', 'gradient-2', 'gradient-3', 'gradient-4'];
  const hash = props.registration.profile.name.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return colors[hash % colors.length];
});

// Shortened AID for display
const shortenedAid = computed(() => {
  const aid = props.registration.applicantAid;
  if (aid.length <= 20) return aid;
  return `${aid.substring(0, 8)}...${aid.substring(aid.length - 8)}`;
});

// Time ago from submission
const timeAgo = computed(() => {
  const submitted = new Date(props.registration.profile.submittedAt);
  const now = new Date();
  const diffMs = now.getTime() - submitted.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return 'Yesterday';
  return `${diffDays}d ago`;
});

// Show first 3 interests, then "+X more"
const maxDisplayedInterests = 3;
const displayedInterests = computed(() =>
  props.registration.profile.interests.slice(0, maxDisplayedInterests)
);
const remainingInterestsCount = computed(() =>
  Math.max(0, props.registration.profile.interests.length - maxDisplayedInterests)
);
</script>

<style lang="scss" scoped>
.registration-card {
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

.interest-chip {
  display: inline-flex;
  align-items: center;
  padding: 0.375rem 0.75rem;
  font-size: 0.75rem;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  border-radius: 9999px;
  background-color: var(--matou-primary);
  color: white;
  opacity: 0.9;

  &:hover {
    opacity: 1;
  }

  &--more {
    background-color: var(--matou-secondary);
    color: var(--matou-muted-foreground);
  }
}

.action-btn {
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
}

.line-clamp-2 {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
