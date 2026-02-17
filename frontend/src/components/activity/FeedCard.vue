<template>
  <div class="feed-card">
    <div class="feed-card-top">
      <component :is="typeIcon" :size="28" class="type-icon" />
      <div class="feed-card-content">
      <div class="feed-card-header">
        <div class="feed-card-header-left">
          <span class="notice-type-badge" :class="notice.type">{{ notice.type }}</span>
          <span class="notice-state-badge" :class="notice.state">{{ notice.state }}</span>
          <span class="feed-card-time">{{ relativeTime(notice.publishedAt ?? notice.createdAt) }}</span>
        </div>
        <div class="feed-card-header-right">
          <button
            v-if="isSteward"
            class="pin-btn"
            :class="{ pinned: notice.pinned }"
            @click="handlePin"
            title="Pin notice"
          >
            <Pin :size="26" />
          </button>
          <SaveButton :notice-id="notice.id" />
        </div>
      </div>

      <!-- Title -->
      <h3 class="feed-card-title">{{ notice.title }}</h3>

      <!-- Author (profile image + name, below title, above description) -->
      <div class="feed-card-author">
        <div class="author-avatar" :class="avatarColorClass">
          <img v-if="authorAvatarUrl" :src="authorAvatarUrl" alt="" class="author-avatar-img" />
          <span v-else>{{ getInitials(authorDisplayName) }}</span>
        </div>
        <span class="author-name">{{ authorDisplayName }}</span>
      </div>

      <!-- Body -->
      <div v-if="notice.body || notice.summary" class="feed-card-body">{{ notice.body || notice.summary }}</div>

      <!-- Image Gallery -->
      <ImageGallery v-if="notice.images?.length" :images="notice.images" />

      <!-- Link Preview -->
      <LinkPreview v-if="notice.links?.length" :links="notice.links" />

      <!-- Attachment List -->
      <div v-if="notice.attachments?.length" class="card-section card-section-white">
        <AttachmentList :attachments="notice.attachments" />
      </div>

      <!-- Event Details -->
      <div v-if="notice.type === 'event' && (notice.eventStart || notice.locationText)" class="event-details-card">
        <div v-if="notice.eventStart" class="event-detail-row">
          <Calendar :size="18" />
          <span>{{ formatDateOnly(notice.eventStart) }}</span>
        </div>
        <div v-if="notice.eventStart" class="event-detail-row">
          <Clock :size="18" />
          <span>{{ formatTimeOnly(notice.eventStart) }}<span v-if="notice.eventEnd"> - {{ formatTimeOnly(notice.eventEnd) }}</span><span v-if="notice.timezone"> {{ notice.timezone }}</span></span>
        </div>
        <div v-if="notice.locationText" class="event-detail-row">
          <MapPin :size="18" />
          <span>{{ notice.locationText }}</span>
        </div>
      </div>

      <!-- RSVP for events -->
      <div v-if="notice.type === 'event' && notice.rsvpEnabled && notice.state === 'published'" class="card-section card-section-white">
        <RSVPButton :notice-id="notice.id" />
      </div>
      <AckButton
          v-if="notice.ackRequired && notice.state === 'published'"
          :notice-id="notice.id"
        />
        <ReactionBar v-if="notice.state === 'published'" :notice-id="notice.id" />
        <CommentSection v-if="notice.state === 'published'" :notice-id="notice.id" />

      <!-- Admin actions -->
      <div v-if="isSteward && notice.state !== 'archived'" class="feed-card-admin">
        <button
          v-if="notice.state === 'draft'"
          class="admin-btn publish"
          @click="handlePublish"
        >
          Publish
        </button>
        <button
          v-if="notice.state === 'published'"
          class="admin-btn archive"
          @click="handleArchive"
        >
          Archive
        </button>
      </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Calendar, Clock, MapPin, Pin, Megaphone, FileText } from 'lucide-vue-next';
import type { Notice } from 'src/lib/api/client';
import { getFileUrl } from 'src/lib/api/client';
import { useActivityStore } from 'stores/activity';
import { useProfilesStore } from 'stores/profiles';
import { useAdminAccess } from 'src/composables/useAdminAccess';
import SaveButton from './SaveButton.vue';
import RSVPButton from './RSVPButton.vue';
import AckButton from './AckButton.vue';
import ReactionBar from './ReactionBar.vue';
import CommentSection from './CommentSection.vue';
import ImageGallery from './ImageGallery.vue';
import LinkPreview from './LinkPreview.vue';
import AttachmentList from './AttachmentList.vue';

const props = defineProps<{ notice: Notice; isSteward: boolean }>();

const activityStore = useActivityStore();
const profilesStore = useProfilesStore();

const typeIcon = computed(() => {
  switch (props.notice.type) {
    case 'event': return Calendar;
    case 'announcement': return Megaphone;
    default: return FileText;
  }
});

// --- Author: match aid (issuerId) to SharedProfile for image and name ---
// Backend stores profiles with id "SharedProfile-{aid}" or "SharedProfile-{aid}-{timestamp}";
// ownerKey is hex pubkey, so we match by id or data.aid, not ownerKey.

function profileMatchesAid(profile: { id: string; data: Record<string, unknown> }, aid: string): boolean {
  if (profile.id === `SharedProfile-${aid}`) return true;
  if (profile.id.startsWith(`SharedProfile-${aid}-`)) return true;
  const dataAid = profile.data?.aid as string | undefined;
  return dataAid === aid;
}

const authorSharedProfile = computed(() => {
  const aid = props.notice.issuerId;
  if (!aid) return null;
  return (
    profilesStore.communityProfiles.find((p) => profileMatchesAid(p, aid)) ?? null
  );
});

const authorAvatarUrl = computed(() => {
  const profile = authorSharedProfile.value;
  if (!profile) return '';
  const data = profile.data as Record<string, unknown>;
  const avatar = data?.avatar as string | undefined;
  if (!avatar) return '';
  if (avatar.startsWith('http') || avatar.startsWith('data:')) return avatar;
  return getFileUrl(avatar);
});

const authorDisplayName = computed(() => {
  const profile = authorSharedProfile.value;
  if (profile) {
    const name = (profile.data as Record<string, unknown>)?.displayName as string | undefined;
    if (name) return name;
  }
  return props.notice.issuerDisplayName || (props.notice.issuerId ? `${props.notice.issuerId.slice(0, 6)}…` : 'Author');
});

const avatarColors = ['gradient-1', 'gradient-2', 'gradient-3', 'gradient-4'];
const avatarColorClass = computed(() => {
  const name = authorDisplayName.value;
  const hash = name.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return avatarColors[hash % avatarColors.length];
});

function getInitials(name: string): string {
  return name
    .split(' ')
    .map(w => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function formatDateOnly(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString(undefined, {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

function formatTimeOnly(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return dateStr;
  }
}

async function handlePublish() {
  await activityStore.handlePublish(props.notice.id);
}

async function handleArchive() {
  await activityStore.handleArchive(props.notice.id);
}

async function handlePin() {
  await activityStore.handleTogglePin(props.notice.id);
}
</script>

<style scoped>
.feed-card {
  background: var(--matou-secondary, #e8f4f8);
  border: 1px solid var(--matou-border, #e5e7eb);
  border-radius: var(--matou-radius, 8px);
  padding: 1rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
}

.feed-card-top {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  gap: 0.75rem;
}

.feed-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.feed-card-header-left {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.type-icon {
  flex-shrink: 0;
  padding: 0.375rem;
  border-radius: var(--matou-radius, 8px);
  background: var(--matou-primary);
  color: var(--matou-primary-foreground, white);
}

.notice-type-badge {
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  padding: 0.1rem 0.4rem;
  border-radius: 9999px;
}

.notice-type-badge.event { background: #d1fae5; color: #065f46; }
.notice-type-badge.update { background: #d1fae5; color: #065f46; }
.notice-type-badge.announcement { background: #d1fae5; color: #065f46; }

.notice-state-badge {
  font-size: 0.75rem;
  font-weight: 500;
  padding: 0.1rem 0.4rem;
  border-radius: 9999px;
}

.notice-state-badge.draft { background: #fef3c7; color: #92400e; }
.notice-state-badge.published { background: #d1fae5; color: #065f46; }
.notice-state-badge.archived { background: #f3f4f6; color: #6b7280; }

.feed-card-time {
  font-size: 0.8rem;
  color: var(--matou-muted-foreground);
}

.feed-card-header-right {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

.pin-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0.25rem;
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--matou-muted-foreground);
  transition: color 0.15s;
}

.pin-btn:hover {
  color: var(--matou-primary);
}

.pin-btn.pinned {
  color: var(--matou-primary);
}

.feed-card-title {
  font-size: 1.2rem;
  font-weight: 600;
  margin: 0;
  color: var(--matou-foreground);
}

.feed-card-author {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.author-avatar {
  width: 2rem;
  height: 2rem;
  border-radius: 50%;
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.65rem;
  font-weight: 600;
  overflow: hidden;
}

.author-avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 50%;
}

.gradient-1 { background: linear-gradient(135deg, #6366f1, #8b5cf6); }
.gradient-2 { background: linear-gradient(135deg, #ec4899, #f43f5e); }
.gradient-3 { background: linear-gradient(135deg, #14b8a6, #06b6d4); }
.gradient-4 { background: linear-gradient(135deg, #f59e0b, #ef4444); }

.author-name {
  font-size: 0.9rem;
  color: var(--matou-muted-foreground);
}

.feed-card-body {
  font-size: 0.95rem;
  color: var(--matou-foreground);
  line-height: 1.6;
  white-space: pre-wrap;
}

.event-details-card {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  padding: 1.5rem;
  background: var(--matou-card, white);
  border: 1px solid var(--matou-border, #e5e7eb);
  border-radius: var(--matou-radius, 8px);
}

.event-detail-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.9rem;
  color: var(--matou-muted-foreground);
}

.feed-card-admin {
  border-top: 1px solid var(--matou-border, #e5e7eb);
  padding-top: 0.625rem;
  display: flex;
  gap: 0.5rem;
}

.admin-btn {
  padding: 0.375rem 0.75rem;
  border: none;
  border-radius: var(--matou-radius, 6px);
  font-size: 0.9rem;
  font-weight: 500;
  cursor: pointer;
}

.admin-btn.publish {
  background: var(--matou-primary);
  color: white;
}

.admin-btn.archive {
  background: #f3f4f6;
  color: #6b7280;
}

.card-section.card-section-white {
  background: white;
  padding: 0.75rem 1rem;
  border-radius: var(--matou-radius, 8px);
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.feed-card-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
</style>
