<template>
  <div class="profile-card" :class="status === 'pending' ? 'border-pending' : 'border-approved'" @click="$emit('click')">
    <div class="card-avatar">
      <img
        v-if="avatarUrl"
        :src="avatarUrl"
        :alt="displayName"
        class="avatar-img"
      />
      <div v-else class="avatar-placeholder" :class="colorClass">
        {{ initials }}
      </div>
    </div>
    <div class="card-info">
      <span class="card-name">{{ displayName }}</span>
      <span v-if="role" class="card-role">{{ role }}</span>
      <span v-if="dateLabel" class="card-date">{{ dateLabel }}</span>
      <span v-if="endorsements.length > 0" class="card-endorsements">
        <q-icon name="thumb_up" size="0.7rem" /> {{ endorsements.length }} {{ endorsements.length === 1 ? 'endorsement' : 'endorsements' }}
      </span>
    </div>
    <div v-if="status === 'pending'" class="card-status status-pending" title="Pending approval">
      <q-icon name="help" size="1.25rem" />
    </div>
    <div v-else-if="status === 'approved'" class="card-status status-approved" title="Approved">
      <q-icon name="check_circle" size="1.25rem" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { getFileUrl } from 'src/lib/api/client';

const props = defineProps<{
  profile: Record<string, unknown>;
  communityProfile?: Record<string, unknown>;
}>();

defineEmits<{
  (e: 'click'): void;
}>();

const displayName = computed(() => (props.profile?.displayName as string) || 'Unknown');

const avatarUrl = computed(() => {
  // Check SharedProfile avatar first, then CommunityProfile avatar as fallback
  const ref = (props.profile?.avatar as string) || (props.communityProfile?.avatar as string);
  if (!ref) return '';
  if (ref.startsWith('http') || ref.startsWith('data:')) return ref;
  return getFileUrl(ref);
});

const initials = computed(() => {
  const name = displayName.value;
  const parts = name.split(' ');
  if (parts.length >= 2) {
    return `${parts[0].charAt(0)}${parts[1].charAt(0)}`.toUpperCase();
  }
  return name.substring(0, 2).toUpperCase();
});

const status = computed(() => (props.profile?.status as string) || '');

const role = computed(() => (props.communityProfile?.role as string) || '');

const memberSince = computed(() => (props.communityProfile?.memberSince as string) || '');

const dateLabel = computed(() => {
  if (memberSince.value) return formatDate(memberSince.value, 'Joined');
  const createdAt = props.profile?.createdAt as string;
  if (createdAt) return formatDate(createdAt, 'Applied');
  return '';
});

const endorsements = computed(() => {
  return (props.profile?.endorsements as Array<unknown>) || [];
});

const colorClass = computed(() => {
  const colors = ['gradient-1', 'gradient-2', 'gradient-3', 'gradient-4'];
  const hash = displayName.value.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return colors[hash % colors.length];
});

function formatDate(dateStr: string, verb: string): string {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return `${verb} today`;
  if (diffDays === 1) return `${verb} yesterday`;
  if (diffDays < 7) return `${verb} ${diffDays} days ago`;
  if (diffDays < 30) return `${verb} ${Math.floor(diffDays / 7)} weeks ago`;
  return `${verb} ${date.toLocaleDateString('en-NZ', { month: 'short', year: 'numeric' })}`;
}
</script>

<style scoped>
.profile-card {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem;
  border-radius: 0.5rem;
  border: 1px solid transparent;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}

.border-pending {
  border-color: var(--matou-warning, #f59e0b);
}

.border-approved {
  border-color: var(--matou-accent, #4a9d9c);
}

.border-pending:hover {
  background: rgba(245, 158, 11, 0.08);
}

.border-approved:hover {
  background: rgba(74, 157, 156, 0.08);
}

.card-avatar {
  flex-shrink: 0;
}

.avatar-img {
  width: 2.5rem;
  height: 2.5rem;
  border-radius: 50%;
  object-fit: cover;
}

.avatar-placeholder {
  width: 2.5rem;
  height: 2.5rem;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  font-size: 0.75rem;
  color: white;
}

.gradient-1 { background: linear-gradient(135deg, #6366f1, #8b5cf6); }
.gradient-2 { background: linear-gradient(135deg, #ec4899, #f43f5e); }
.gradient-3 { background: linear-gradient(135deg, #14b8a6, #06b6d4); }
.gradient-4 { background: linear-gradient(135deg, #f59e0b, #ef4444); }

.card-info {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}

.card-status {
  flex-shrink: 0;
  margin-left: auto;
}

.status-pending {
  color: var(--matou-warning, #f59e0b);
}

.status-approved {
  color: var(--matou-success, #22c55e);
}

.card-name {
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--matou-text, #1f2937);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.card-role {
  font-size: 0.75rem;
  color: var(--matou-primary, #6366f1);
}

.card-date {
  font-size: 0.75rem;
  color: var(--matou-text-secondary, #6b7280);
}

.card-endorsements {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.7rem;
  color: var(--matou-accent, #4a9d9c);
  font-weight: 500;
}
</style>
