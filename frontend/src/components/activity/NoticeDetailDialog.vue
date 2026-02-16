<template>
  <div class="dialog-overlay" @click.self="$emit('close')">
    <div class="dialog-content">
      <div class="dialog-header">
        <div class="dialog-header-badges">
          <span class="notice-type-badge" :class="notice.type">{{ notice.type }}</span>
          <span class="notice-state-badge" :class="notice.state">{{ notice.state }}</span>
        </div>
        <button class="dialog-close" @click="$emit('close')">
          <X :size="18" />
        </button>
      </div>

      <h2 class="dialog-title">{{ notice.title }}</h2>
      <p class="dialog-summary">{{ notice.summary }}</p>

      <div v-if="notice.body" class="dialog-body">
        {{ notice.body }}
      </div>

      <div class="dialog-meta">
        <div v-if="notice.eventStart" class="meta-item">
          <Calendar :size="16" />
          <span>{{ formatDate(notice.eventStart) }}<span v-if="notice.eventEnd"> - {{ formatDate(notice.eventEnd) }}</span></span>
        </div>
        <div v-if="notice.locationText" class="meta-item">
          <MapPin :size="16" />
          <span>{{ notice.locationText }}</span>
        </div>
        <div v-if="notice.issuerDisplayName" class="meta-item">
          <User :size="16" />
          <span>{{ notice.issuerDisplayName }}</span>
        </div>
        <div v-if="notice.createdAt" class="meta-item">
          <Clock :size="16" />
          <span>Created {{ formatDate(notice.createdAt) }}</span>
        </div>
      </div>

      <div class="dialog-interactions">
        <RSVPButton v-if="notice.type === 'event' && notice.rsvpEnabled && notice.state === 'published'" :notice-id="notice.id" />
        <AckButton v-if="notice.ackRequired && notice.state === 'published'" :notice-id="notice.id" />
        <SaveButton :notice-id="notice.id" />
      </div>

      <div v-if="isSteward && notice.state !== 'archived'" class="dialog-admin-actions">
        <button v-if="notice.state === 'draft'" class="admin-btn publish" @click="handlePublish">Publish</button>
        <button v-if="notice.state === 'published'" class="admin-btn archive" @click="handleArchive">Archive</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { X, Calendar, MapPin, User, Clock } from 'lucide-vue-next';
import type { Notice } from 'src/lib/api/client';
import { useActivityStore } from 'stores/activity';
import { useAdminAccess } from 'src/composables/useAdminAccess';
import RSVPButton from './RSVPButton.vue';
import AckButton from './AckButton.vue';
import SaveButton from './SaveButton.vue';

const props = defineProps<{ notice: Notice }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const activityStore = useActivityStore();
const { isSteward } = useAdminAccess();

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return dateStr;
  }
}

async function handlePublish() {
  await activityStore.handlePublish(props.notice.id);
  emit('close');
}

async function handleArchive() {
  await activityStore.handleArchive(props.notice.id);
  emit('close');
}
</script>

<style scoped>
.dialog-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.dialog-content {
  background: var(--matou-card, white);
  border-radius: var(--matou-radius, 12px);
  padding: 1.5rem;
  max-width: 600px;
  width: 90%;
  max-height: 80vh;
  overflow-y: auto;
}

.dialog-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1rem;
}

.dialog-header-badges {
  display: flex;
  gap: 0.5rem;
}

.notice-type-badge {
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  padding: 0.125rem 0.5rem;
  border-radius: 9999px;
}

.notice-type-badge.event { background: #dbeafe; color: #1d4ed8; }
.notice-type-badge.update { background: #f3e8ff; color: #7c3aed; }

.notice-state-badge {
  font-size: 0.7rem;
  font-weight: 500;
  padding: 0.125rem 0.5rem;
  border-radius: 9999px;
}

.notice-state-badge.draft { background: #fef3c7; color: #92400e; }
.notice-state-badge.published { background: #d1fae5; color: #065f46; }
.notice-state-badge.archived { background: #f3f4f6; color: #6b7280; }

.dialog-close {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--matou-muted-foreground);
  padding: 0.25rem;
}

.dialog-title {
  font-size: 1.25rem;
  font-weight: 600;
  margin: 0 0 0.5rem;
}

.dialog-summary {
  color: var(--matou-muted-foreground);
  margin: 0 0 1rem;
  line-height: 1.5;
}

.dialog-body {
  margin-bottom: 1rem;
  line-height: 1.6;
  white-space: pre-wrap;
}

.dialog-meta {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-bottom: 1rem;
  padding: 0.75rem;
  background: var(--matou-background, #f4f4f5);
  border-radius: var(--matou-radius, 8px);
}

.meta-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.85rem;
  color: var(--matou-muted-foreground);
}

.dialog-interactions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  margin-bottom: 1rem;
}

.dialog-admin-actions {
  border-top: 1px solid var(--matou-border, #e5e7eb);
  padding-top: 1rem;
  display: flex;
  gap: 0.5rem;
}

.admin-btn {
  padding: 0.5rem 1rem;
  border: none;
  border-radius: var(--matou-radius, 6px);
  font-size: 0.85rem;
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
</style>
