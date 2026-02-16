<template>
  <div class="notice-card" @click="$emit('click', notice)">
    <div class="notice-card-header">
      <span class="notice-type-badge" :class="notice.type">{{ notice.type }}</span>
      <span class="notice-state-badge" :class="notice.state">{{ notice.state }}</span>
    </div>
    <h3 class="notice-title">{{ notice.title }}</h3>
    <p class="notice-summary">{{ notice.summary }}</p>
    <div class="notice-meta">
      <span v-if="notice.eventStart" class="notice-meta-item">
        <Calendar :size="14" /> {{ formatDate(notice.eventStart) }}
      </span>
      <span v-if="notice.locationText" class="notice-meta-item">
        <MapPin :size="14" /> {{ notice.locationText }}
      </span>
      <span v-if="notice.issuerDisplayName" class="notice-meta-item">
        <User :size="14" /> {{ notice.issuerDisplayName }}
      </span>
    </div>
    <div class="notice-actions">
      <RSVPButton v-if="notice.type === 'event' && notice.rsvpEnabled && notice.state === 'published'" :notice-id="notice.id" />
      <AckButton v-if="notice.ackRequired && notice.state === 'published'" :notice-id="notice.id" />
      <SaveButton :notice-id="notice.id" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { Calendar, MapPin, User } from 'lucide-vue-next';
import type { Notice } from 'src/lib/api/client';
import RSVPButton from './RSVPButton.vue';
import AckButton from './AckButton.vue';
import SaveButton from './SaveButton.vue';

defineProps<{ notice: Notice }>();
defineEmits<{ (e: 'click', notice: Notice): void }>();

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return dateStr;
  }
}
</script>

<style scoped>
.notice-card {
  background: var(--matou-card, white);
  border: 1px solid var(--matou-border, #e5e7eb);
  border-radius: var(--matou-radius, 8px);
  padding: 1rem;
  cursor: pointer;
  transition: box-shadow 0.15s ease;
}

.notice-card:hover {
  box-shadow: 0 2px 8px rgba(0,0,0,0.08);
}

.notice-card-header {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.notice-type-badge {
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  padding: 0.125rem 0.5rem;
  border-radius: 9999px;
}

.notice-type-badge.event {
  background: #dbeafe;
  color: #1d4ed8;
}

.notice-type-badge.update {
  background: #f3e8ff;
  color: #7c3aed;
}

.notice-state-badge {
  font-size: 0.7rem;
  font-weight: 500;
  padding: 0.125rem 0.5rem;
  border-radius: 9999px;
}

.notice-state-badge.draft {
  background: #fef3c7;
  color: #92400e;
}

.notice-state-badge.published {
  background: #d1fae5;
  color: #065f46;
}

.notice-state-badge.archived {
  background: #f3f4f6;
  color: #6b7280;
}

.notice-title {
  font-size: 1rem;
  font-weight: 600;
  margin: 0 0 0.25rem;
  color: var(--matou-foreground);
}

.notice-summary {
  font-size: 0.85rem;
  color: var(--matou-muted-foreground);
  margin: 0 0 0.75rem;
  line-height: 1.4;
}

.notice-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
}

.notice-meta-item {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.75rem;
  color: var(--matou-muted-foreground);
}

.notice-actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}
</style>
