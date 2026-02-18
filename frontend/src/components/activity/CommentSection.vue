<template>
  <div class="comment-section">
    <button class="comment-toggle" @click.stop="toggleExpanded">
      <span>{{ commentCount }} comment{{ commentCount !== 1 ? 's' : '' }}</span>
      <ChevronDown :size="18" class="toggle-icon" :class="{ expanded }" />
    </button>

    <div v-if="expanded" class="comment-list">
      <div v-for="comment in comments" :key="comment.id" class="comment-item">
        <div class="comment-avatar" :class="getAvatarColor(getCommentAuthorName(comment))">
          <img v-if="getCommentAvatarUrl(comment.userId)" :src="getCommentAvatarUrl(comment.userId)" alt="" class="comment-avatar-img" />
          <span v-else>{{ getInitials(getCommentAuthorName(comment)) }}</span>
        </div>
        <div class="comment-body">
          <div class="comment-header">
            <span class="comment-author">{{ getCommentAuthorName(comment) }}</span>
            <span class="comment-time">{{ relativeTime(comment.createdAt) }}</span>
          </div>
          <p class="comment-text">{{ comment.text }}</p>
        </div>
      </div>

      <div class="comment-input-row">
        <textarea
          v-model="newComment"
          class="comment-input"
          placeholder="Write a comment..."
          rows="2"
          @keydown.ctrl.enter.prevent="submitComment"
          @keydown.meta.enter.prevent="submitComment"
        />
        <button
          class="comment-send"
          :disabled="!newComment.trim() || sending"
          @click.stop="submitComment"
        >
          <Send :size="18" />
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue';
import { ChevronDown, Send } from 'lucide-vue-next';
import { useActivityStore } from 'stores/activity';
import { useProfilesStore } from 'stores/profiles';
import { getFileUrl } from 'src/lib/api/client';

const props = defineProps<{ noticeId: string }>();
const activityStore = useActivityStore();
const profilesStore = useProfilesStore();

const expanded = ref(false);
const newComment = ref('');
const sending = ref(false);

const comments = computed(() => activityStore.commentsByNotice[props.noticeId] ?? []);
const commentCount = computed(() => activityStore.getCommentCount(props.noticeId));

// Load comments on mount so the count is visible immediately
onMounted(() => {
  activityStore.loadComments(props.noticeId);
});

function toggleExpanded() {
  expanded.value = !expanded.value;
}

async function submitComment() {
  const text = newComment.value.trim();
  if (!text || sending.value) return;
  sending.value = true;
  await activityStore.handleAddComment(props.noticeId, text);
  newComment.value = '';
  sending.value = false;
}

// --- Comment author: match userId (AID) to SharedProfile for image and name ---

function profileMatchesAid(profile: { id: string; data: Record<string, unknown> }, aid: string): boolean {
  if (profile.id === `SharedProfile-${aid}`) return true;
  if (profile.id.startsWith(`SharedProfile-${aid}-`)) return true;
  const dataAid = profile.data?.aid as string | undefined;
  return dataAid === aid;
}

function getCommentProfile(userId: string): { id: string; data: Record<string, unknown> } | null {
  if (!userId) return null;
  return profilesStore.communityProfiles.find((p) => profileMatchesAid(p, userId)) ?? null;
}

function getCommentAvatarUrl(userId: string): string {
  const profile = getCommentProfile(userId);
  if (!profile) return '';
  const avatar = profile.data?.avatar as string | undefined;
  if (!avatar) return '';
  if (avatar.startsWith('http') || avatar.startsWith('data:')) return avatar;
  return getFileUrl(avatar);
}

function getCommentAuthorName(comment: { userId: string; userDisplayName: string }): string {
  const profile = getCommentProfile(comment.userId);
  if (profile) {
    const name = profile.data?.displayName as string | undefined;
    if (name) return name;
  }
  return comment.userDisplayName || shortenId(comment.userId);
}

const avatarColors = ['gradient-1', 'gradient-2', 'gradient-3', 'gradient-4'];
function getAvatarColor(name: string): string {
  if (!name) return avatarColors[0];
  const hash = name.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return avatarColors[hash % avatarColors.length];
}

function getInitials(name: string): string {
  if (!name) return '??';
  return name
    .split(' ')
    .map(w => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

function shortenId(id: string): string {
  if (!id || id.length <= 10) return id || 'Unknown';
  return id.substring(0, 6) + '...' + id.substring(id.length - 4);
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
</script>

<style scoped>
.comment-section {
  padding-top: 0.5rem;
}

.comment-toggle {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 0.9rem;
  color: var(--matou-muted-foreground);
  padding: 0.25rem 0;
}

.comment-toggle:hover {
  color: var(--matou-foreground);
}

.toggle-icon {
  transition: transform 0.2s;
}

.toggle-icon.expanded {
  transform: rotate(180deg);
}

.comment-list {
  margin-top: 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.625rem;
}

.comment-item {
  display: flex;
  gap: 0.5rem;
}

.comment-avatar {
  flex-shrink: 0;
  width: 2rem;
  height: 2rem;
  border-radius: 50%;
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.7rem;
  font-weight: 600;
  overflow: hidden;
}

.comment-avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 50%;
}

.gradient-1 { background: linear-gradient(135deg, #6366f1, #8b5cf6); }
.gradient-2 { background: linear-gradient(135deg, #ec4899, #f43f5e); }
.gradient-3 { background: linear-gradient(135deg, #14b8a6, #06b6d4); }
.gradient-4 { background: linear-gradient(135deg, #f59e0b, #ef4444); }

.comment-body {
  flex: 1;
  min-width: 0;
  padding: 0.5rem 0.75rem;
  background: white;
  border-radius: var(--matou-radius, 6px);
}

.comment-header {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
}

.comment-author {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--matou-foreground);
}

.comment-time {
  font-size: 0.8rem;
  color: var(--matou-muted-foreground);
}

.comment-text {
  font-size: 0.9rem;
  color: var(--matou-foreground);
  margin: 0.25rem 0 0;
  line-height: 1.4;
}

.comment-input-row {
  display: flex;
  gap: 0.375rem;
  align-items: flex-end;
  margin-top: 0.5rem;
}

.comment-input {
  flex: 1;
  padding: 0.375rem 0.5rem;
  border: 1px solid var(--matou-border, #e5e7eb);
  border-radius: var(--matou-radius, 6px);
  font-size: 0.9rem;
  resize: none;
  color: var(--matou-foreground);
  background: var(--matou-background, white);
}

.comment-input:focus {
  outline: none;
  border-color: var(--matou-primary);
}

.comment-send {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  border: none;
  border-radius: var(--matou-radius, 6px);
  background: var(--matou-primary);
  color: white;
  cursor: pointer;
  transition: opacity 0.15s;
}

.comment-send:hover:not(:disabled) {
  opacity: 0.9;
}

.comment-send:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
