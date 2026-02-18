<template>
  <div
    class="file-upload-input"
    :class="{ dragging }"
    @dragover.prevent="dragging = true"
    @dragleave.prevent="dragging = false"
    @drop.prevent="handleDrop"
    @click="triggerPicker"
  >
    <input
      ref="fileInput"
      type="file"
      :accept="accept"
      :multiple="multiple"
      class="hidden-input"
      @change="handleFileChange"
    />

    <div v-if="uploads.length === 0" class="drop-zone">
      <Upload :size="22" class="drop-icon" />
      <span class="drop-text">{{ dropText }}</span>
    </div>

    <div v-else class="file-previews">
      <div v-for="(item, idx) in uploads" :key="idx" class="preview-item">
        <img
          v-if="item.previewUrl"
          :src="item.previewUrl"
          class="preview-thumb"
          alt="Preview"
        />
        <div v-else class="preview-file-icon">
          <Paperclip :size="16" />
        </div>
        <div class="preview-info">
          <span class="preview-name">{{ item.name }}</span>
          <div v-if="item.uploading" class="progress-bar">
            <div class="progress-fill" :style="{ width: item.progress + '%' }" />
          </div>
          <span v-else-if="item.error" class="preview-error">{{ item.error }}</span>
        </div>
        <button class="preview-remove" @click.stop="removeFile(idx)">
          <X :size="14" />
        </button>
      </div>
      <button class="add-more" @click.stop="triggerPicker">+ Add more</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { Upload, Paperclip, X } from 'lucide-vue-next';
import { uploadFile } from 'src/lib/api/client';

interface Props {
  accept?: string;
  multiple?: boolean;
  dropText?: string;
}

const props = withDefaults(defineProps<Props>(), {
  accept: '',
  multiple: false,
  dropText: 'Drop files here or click to browse',
});

const emit = defineEmits<{
  (e: 'update', files: { name: string; fileRef: string; mimeType: string; size: number }[]): void;
}>();

interface UploadItem {
  name: string;
  mimeType: string;
  size: number;
  fileRef?: string;
  previewUrl?: string;
  uploading: boolean;
  progress: number;
  error?: string;
}

const fileInput = ref<HTMLInputElement | null>(null);
const dragging = ref(false);
const uploads = ref<UploadItem[]>([]);

function triggerPicker() {
  fileInput.value?.click();
}

function handleDrop(e: DragEvent) {
  dragging.value = false;
  const files = e.dataTransfer?.files;
  if (files) processFiles(files);
}

function handleFileChange(e: Event) {
  const input = e.target as HTMLInputElement;
  if (input.files) processFiles(input.files);
  input.value = '';
}

async function processFiles(files: FileList) {
  for (const file of Array.from(files)) {
    const item: UploadItem = {
      name: file.name,
      mimeType: file.type,
      size: file.size,
      uploading: true,
      progress: 0,
    };

    // Create preview for images
    if (file.type.startsWith('image/')) {
      item.previewUrl = URL.createObjectURL(file);
    }

    uploads.value.push(item);
    const idx = uploads.value.length - 1;

    // Simulate progress
    const interval = setInterval(() => {
      if (uploads.value[idx] && uploads.value[idx].progress < 90) {
        uploads.value[idx].progress += 10;
      }
    }, 100);

    const result = await uploadFile(file);
    clearInterval(interval);

    if (result.fileRef) {
      uploads.value[idx].fileRef = result.fileRef;
      uploads.value[idx].uploading = false;
      uploads.value[idx].progress = 100;
    } else {
      uploads.value[idx].uploading = false;
      uploads.value[idx].error = result.error ?? 'Upload failed';
    }

    emitUpdate();
  }
}

function removeFile(idx: number) {
  const item = uploads.value[idx];
  if (item.previewUrl) {
    URL.revokeObjectURL(item.previewUrl);
  }
  uploads.value.splice(idx, 1);
  emitUpdate();
}

function emitUpdate() {
  const completed = uploads.value
    .filter(u => u.fileRef)
    .map(u => ({
      name: u.name,
      fileRef: u.fileRef!,
      mimeType: u.mimeType,
      size: u.size,
    }));
  emit('update', completed);
}

// Emit on any change
watch(uploads, () => emitUpdate(), { deep: true });
</script>

<style scoped>
.file-upload-input {
  border: 2px dashed var(--matou-border, #e5e7eb);
  border-radius: var(--matou-radius, 8px);
  padding: 0.75rem;
  cursor: pointer;
  transition: border-color 0.15s;
}

.file-upload-input:hover,
.file-upload-input.dragging {
  border-color: var(--matou-primary);
}

.hidden-input {
  display: none;
}

.drop-zone {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.375rem;
  padding: 1rem;
}

.drop-icon {
  color: var(--matou-muted-foreground);
}

.drop-text {
  font-size: 0.8rem;
  color: var(--matou-muted-foreground);
}

.file-previews {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.preview-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.preview-thumb {
  width: 2.5rem;
  height: 2.5rem;
  object-fit: cover;
  border-radius: var(--matou-radius, 4px);
}

.preview-file-icon {
  width: 2.5rem;
  height: 2.5rem;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--matou-background, #f4f4f5);
  border-radius: var(--matou-radius, 4px);
  color: var(--matou-muted-foreground);
}

.preview-info {
  flex: 1;
  min-width: 0;
}

.preview-name {
  font-size: 0.8rem;
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.progress-bar {
  height: 3px;
  background: var(--matou-border, #e5e7eb);
  border-radius: 2px;
  margin-top: 0.25rem;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: var(--matou-primary);
  transition: width 0.2s;
}

.preview-error {
  font-size: 0.7rem;
  color: var(--matou-destructive, #ef4444);
}

.preview-remove {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 1.25rem;
  height: 1.25rem;
  border: none;
  border-radius: 50%;
  background: var(--matou-background, #f4f4f5);
  cursor: pointer;
  color: var(--matou-muted-foreground);
}

.preview-remove:hover {
  color: var(--matou-destructive, #ef4444);
}

.add-more {
  align-self: flex-start;
  background: none;
  border: none;
  cursor: pointer;
  font-size: 0.8rem;
  color: var(--matou-primary);
  padding: 0.25rem 0;
}
</style>
