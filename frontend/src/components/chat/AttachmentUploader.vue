<template>
  <div
    class="attachment-uploader"
    :class="{ 'drag-over': isDragging }"
    @dragover.prevent="isDragging = true"
    @dragleave.prevent="isDragging = false"
    @drop.prevent="handleDrop"
  >
    <input
      ref="inputRef"
      type="file"
      multiple
      class="hidden-input"
      @change="handleFileSelect"
    />

    <div class="uploader-content" @click="openFilePicker">
      <Upload class="upload-icon" />
      <p>
        <span class="upload-link">Click to upload</span> or drag and drop
      </p>
      <span class="upload-hint">Images, documents, up to 10MB each</span>
    </div>

    <!-- Pending uploads -->
    <div v-if="pendingFiles.length > 0" class="pending-files">
      <div
        v-for="(file, idx) in pendingFiles"
        :key="idx"
        class="pending-file"
      >
        <div class="file-info">
          <File class="file-icon" />
          <span class="file-name">{{ file.name }}</span>
          <span class="file-size">{{ formatSize(file.size) }}</span>
        </div>
        <button class="remove-btn" @click="removeFile(idx)">
          <X class="icon" />
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { Upload, File, X } from 'lucide-vue-next';
import { uploadFile } from 'src/lib/api/client';
import type { AttachmentRef } from 'src/lib/api/chat';

const emit = defineEmits<{
  (e: 'upload', attachments: AttachmentRef[]): void;
  (e: 'error', message: string): void;
  (e: 'change', count: number): void;
}>();

const inputRef = ref<HTMLInputElement | null>(null);
const isDragging = ref(false);
const pendingFiles = ref<File[]>([]);

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

function openFilePicker() {
  inputRef.value?.click();
}

function handleFileSelect(event: Event) {
  const input = event.target as HTMLInputElement;
  if (input.files) {
    addFiles(Array.from(input.files));
  }
  input.value = '';
}

function handleDrop(event: DragEvent) {
  isDragging.value = false;
  if (event.dataTransfer?.files) {
    addFiles(Array.from(event.dataTransfer.files));
  }
}

function addFiles(files: File[]) {
  for (const file of files) {
    if (file.size > MAX_FILE_SIZE) {
      emit('error', `File "${file.name}" exceeds 10MB limit`);
      continue;
    }
    pendingFiles.value.push(file);
  }
  emit('change', pendingFiles.value.length);
}

function removeFile(index: number) {
  pendingFiles.value.splice(index, 1);
  emit('change', pendingFiles.value.length);
}

async function uploadAll(): Promise<AttachmentRef[]> {
  const attachments: AttachmentRef[] = [];

  for (const file of pendingFiles.value) {
    const result = await uploadFile(file);
    if (result.fileRef) {
      attachments.push({
        fileRef: result.fileRef,
        fileName: file.name,
        contentType: file.type,
        size: file.size,
      });
    } else {
      emit('error', result.error || `Failed to upload ${file.name}`);
    }
  }

  pendingFiles.value = [];
  emit('change', 0);
  return attachments;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Expose for parent to call
defineExpose({
  uploadAll,
  hasPendingFiles: () => pendingFiles.value.length > 0,
});
</script>

<style lang="scss" scoped>
.attachment-uploader {
  border: 2px dashed var(--matou-border);
  border-radius: var(--matou-radius);
  padding: 1rem;
  transition: all 0.15s ease;

  &.drag-over {
    border-color: var(--matou-primary);
    background-color: rgba(30, 95, 116, 0.05);
  }
}

.hidden-input {
  display: none;
}

.uploader-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  cursor: pointer;
  padding: 1rem;

  p {
    margin: 0.5rem 0 0;
    font-size: 0.875rem;
    color: var(--matou-foreground);
  }
}

.upload-icon {
  width: 32px;
  height: 32px;
  color: var(--matou-muted-foreground);
}

.upload-link {
  color: var(--matou-primary);
  font-weight: 500;
}

.upload-hint {
  font-size: 0.75rem;
  color: var(--matou-muted-foreground);
}

.pending-files {
  margin-top: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.pending-file {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem;
  background-color: var(--matou-secondary);
  border-radius: var(--matou-radius);
}

.file-info {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
}

.file-icon {
  width: 18px;
  height: 18px;
  color: var(--matou-primary);
  flex-shrink: 0;
}

.file-name {
  font-size: 0.875rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-size {
  font-size: 0.75rem;
  color: var(--matou-muted-foreground);
  flex-shrink: 0;
}

.remove-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: var(--matou-radius);
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--matou-muted-foreground);
  transition: all 0.15s ease;

  &:hover {
    background-color: var(--matou-muted);
    color: var(--matou-destructive);
  }

  .icon {
    width: 14px;
    height: 14px;
  }
}
</style>
