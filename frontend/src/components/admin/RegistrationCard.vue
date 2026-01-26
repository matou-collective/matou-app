<template>
  <div class="registration-card bg-card border border-border rounded-xl p-4 hover:shadow-md transition-shadow">
    <!-- Header with avatar and name -->
    <div class="flex items-start gap-3 mb-3">
      <div class="avatar w-12 h-12 rounded-full flex items-center justify-center shrink-0" :class="avatarClass">
        <span class="text-white font-semibold">{{ initials }}</span>
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

    <!-- Interests -->
    <div v-if="registration.profile.interests.length > 0" class="flex flex-wrap gap-1.5 mb-4">
      <span
        v-for="interest in displayedInterests"
        :key="interest"
        class="interest-tag px-2 py-0.5 text-xs rounded-full bg-primary/10 text-primary"
      >
        {{ interest }}
      </span>
      <span
        v-if="remainingInterestsCount > 0"
        class="interest-tag px-2 py-0.5 text-xs rounded-full bg-secondary text-muted-foreground"
      >
        +{{ remainingInterestsCount }} more
      </span>
    </div>

    <!-- Actions -->
    <div class="flex items-center gap-2">
      <button
        @click="$emit('message', registration)"
        class="action-btn flex-1 px-3 py-2 text-sm rounded-lg border border-border hover:bg-secondary transition-colors"
        :disabled="disabled"
      >
        <MessageSquare class="w-4 h-4 inline mr-1.5" />
        Message
      </button>
      <button
        @click="$emit('approve', registration)"
        class="action-btn flex-1 px-3 py-2 text-sm rounded-lg bg-primary text-white hover:bg-primary/90 transition-colors"
        :disabled="disabled"
      >
        <Check class="w-4 h-4 inline mr-1.5" />
        Approve
      </button>
      <button
        @click="$emit('decline', registration)"
        class="action-btn px-3 py-2 text-sm rounded-lg border border-destructive/30 text-destructive hover:bg-destructive/10 transition-colors"
        :disabled="disabled"
      >
        <X class="w-4 h-4" />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { MessageSquare, Check, X } from 'lucide-vue-next';
import type { PendingRegistration } from 'src/composables/useRegistrationPolling';

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
  (e: 'message', registration: PendingRegistration): void;
}>();

// Avatar initials from name
const initials = computed(() => {
  const parts = props.registration.profile.name.split(' ');
  if (parts.length >= 2) {
    return `${parts[0].charAt(0)}${parts[1].charAt(0)}`.toUpperCase();
  }
  return props.registration.profile.name.substring(0, 2).toUpperCase();
});

// Avatar color based on name hash
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

.interest-tag {
  white-space: nowrap;
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
