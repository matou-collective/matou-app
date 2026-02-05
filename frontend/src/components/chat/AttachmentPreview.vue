<template>
  <div class="attachment-preview" :class="{ image: isImage }">
    <template v-if="isImage">
      <img :src="fileUrl" :alt="attachment.fileName" class="attachment-image" @click="openFullscreen" />
    </template>
    <template v-else>
      <a :href="fileUrl" target="_blank" class="attachment-file" :download="attachment.fileName">
        <FileIcon class="file-icon" />
        <div class="file-info">
          <span class="file-name">{{ attachment.fileName }}</span>
          <span class="file-size">{{ formatSize(attachment.size) }}</span>
        </div>
        <Download class="download-icon" />
      </a>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { File as FileIcon, Download } from 'lucide-vue-next';
import type { AttachmentRef } from 'src/lib/api/chat';
import { getFileUrl } from 'src/lib/api/client';

const props = defineProps<{
  attachment: AttachmentRef;
}>();

const isImage = computed(() => {
  return props.attachment.contentType?.startsWith('image/');
});

const fileUrl = computed(() => {
  return getFileUrl(props.attachment.fileRef);
});

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function openFullscreen() {
  window.open(fileUrl.value, '_blank');
}
</script>

<style lang="scss" scoped>
.attachment-preview {
  border-radius: var(--matou-radius);
  overflow: hidden;

  &.image {
    max-width: 300px;
  }
}

.attachment-image {
  width: 100%;
  height: auto;
  display: block;
  cursor: pointer;
  transition: opacity 0.15s ease;

  &:hover {
    opacity: 0.9;
  }
}

.attachment-file {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem;
  background-color: var(--matou-secondary);
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius);
  text-decoration: none;
  color: inherit;
  transition: background-color 0.15s ease;

  &:hover {
    background-color: var(--matou-muted);
  }
}

.file-icon {
  width: 24px;
  height: 24px;
  color: var(--matou-primary);
  flex-shrink: 0;
}

.file-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.file-name {
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--matou-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-size {
  font-size: 0.75rem;
  color: var(--matou-muted-foreground);
}

.download-icon {
  width: 18px;
  height: 18px;
  color: var(--matou-muted-foreground);
  flex-shrink: 0;
}
</style>
