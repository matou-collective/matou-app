<template>
  <div class="attachment-list">
    <div v-for="(att, idx) in attachments" :key="idx" class="attachment-card">
      <Paperclip :size="16" class="attachment-icon" />
      <div class="attachment-info">
        <span class="attachment-name">{{ att.name }}</span>
        <span class="attachment-meta">{{ formatType(att.mimeType) }} &middot; {{ formatSize(att.size) }}</span>
      </div>
      <a :href="getFileUrl(att.fileRef)" target="_blank" rel="noopener noreferrer" class="attachment-download">
        <Download :size="16" />
      </a>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Paperclip, Download } from 'lucide-vue-next';
import { getFileUrl } from 'src/lib/api/client';
import type { NoticeAttachment } from 'src/lib/api/client';

defineProps<{ attachments: NoticeAttachment[] }>();

function formatType(mimeType: string): string {
  const parts = mimeType.split('/');
  return (parts[1] ?? parts[0]).toUpperCase();
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
</script>

<style scoped>
.attachment-list {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

.attachment-card {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border-radius: var(--matou-radius, 8px);
}

.attachment-icon {
  flex-shrink: 0;
  color: var(--matou-muted-foreground);
}

.attachment-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.attachment-name {
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--matou-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.attachment-meta {
  font-size: 0.7rem;
  color: var(--matou-muted-foreground);
}

.attachment-download {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 1.75rem;
  height: 1.75rem;
  border-radius: var(--matou-radius, 6px);
  color: var(--matou-muted-foreground);
  transition: color 0.15s;
}

.attachment-download:hover {
  color: var(--matou-primary);
}
</style>
