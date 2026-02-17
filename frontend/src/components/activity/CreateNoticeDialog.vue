<template>
  <div class="dialog-overlay" @click.self="$emit('close')">
    <div class="dialog-content">
      <div class="dialog-header">
        <h2 class="dialog-title">Create Notice</h2>
        <button class="dialog-close" @click="$emit('close')">
          <X :size="20" />
        </button>
      </div>

      <form @submit.prevent="handleSubmit">
        <div class="form-group">
          <label class="form-label">Type</label>
          <div class="type-selector">
            <button type="button" class="type-btn" :class="{ active: form.type === 'event' }" @click="form.type = 'event'">
              <Calendar :size="16" /> Event
            </button>
            <button type="button" class="type-btn" :class="{ active: form.type === 'announcement' }" @click="form.type = 'announcement'">
              <Megaphone :size="16" /> Announcement
            </button>
            <button type="button" class="type-btn" :class="{ active: form.type === 'update' }" @click="form.type = 'update'">
              <FileText :size="16" /> Update
            </button>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Title *</label>
          <input v-model="form.title" class="form-input" placeholder="Notice title" required />
        </div>

        <div class="form-group">
          <label class="form-label">Description *</label>
          <textarea v-model="form.summary" class="form-input form-textarea" placeholder="Describe this notice..." required rows="4" />
        </div>

        <!-- Images upload -->
        <div class="form-group">
          <label class="form-label">Images</label>
          <FileUploadInput
            accept="image/*"
            :multiple="true"
            drop-text="Drop images here or click to browse"
            @update="handleImagesUpdate"
          />
        </div>

        <!-- Attachments upload -->
        <div class="form-group">
          <label class="form-label">Attachments</label>
          <FileUploadInput
            :multiple="true"
            drop-text="Drop files here or click to browse"
            @update="handleAttachmentsUpdate"
          />
        </div>

        <!-- Links section -->
        <div class="form-group">
          <label class="form-label">Links</label>
          <div v-for="(link, idx) in form.links" :key="idx" class="link-row">
            <input v-model="link.label" class="form-input link-input" placeholder="Label" />
            <input v-model="link.url" class="form-input link-input" placeholder="https://..." />
            <button type="button" class="link-remove" @click="removeLink(idx)">
              <X :size="16" />
            </button>
          </div>
          <button type="button" class="add-link-btn" @click="addLink">+ Add link</button>
        </div>

        <div v-if="form.type === 'event'" class="form-section">
          <h3 class="form-section-title">Event Details</h3>

          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Start</label>
              <input v-model="form.eventStart" type="datetime-local" class="form-input" :min="minStart" />
            </div>
            <div class="form-group">
              <label class="form-label">End</label>
              <input v-model="form.eventEnd" type="datetime-local" class="form-input" :min="minEnd" />
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">Location</label>
            <input v-model="form.locationText" class="form-input" placeholder="Where is this event?" />
          </div>

          <div class="form-group">
            <label class="form-label">
              <input type="checkbox" v-model="form.rsvpEnabled" /> Enable RSVP
            </label>
          </div>
        </div>

        <div v-if="form.type === 'update' || form.type === 'announcement'" class="form-section">
          <div class="form-group">
            <label class="form-label">
              <input type="checkbox" v-model="form.ackRequired" /> Require Acknowledgment
            </label>
          </div>
        </div>

        <div v-if="submitError" class="form-error">{{ submitError }}</div>

        <div class="form-actions">
          <button type="button" class="form-btn secondary" @click="$emit('close')">Cancel</button>
          <button type="submit" class="form-btn secondary" :disabled="submitting" @click="publishOnSubmit = false">Save Draft</button>
          <button type="submit" class="form-btn primary" :disabled="submitting" @click="publishOnSubmit = true">Publish</button>
        </div>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, watch, computed } from 'vue';
import { X, Calendar, Megaphone, FileText } from 'lucide-vue-next';
import { useActivityStore } from 'stores/activity';
import FileUploadInput from './FileUploadInput.vue';

const emit = defineEmits<{ (e: 'close'): void }>();
const activityStore = useActivityStore();

const form = reactive({
  type: 'event' as 'event' | 'update' | 'announcement',
  title: '',
  summary: '',
  eventStart: '',
  eventEnd: '',
  locationText: '',
  rsvpEnabled: false,
  ackRequired: false,
  images: [] as string[],
  attachments: [] as { name: string; fileRef: string; mimeType: string; size: number }[],
  links: [] as { label: string; url: string }[],
});

// Format a Date as datetime-local value (YYYY-MM-DDTHH:MM)
function toDatetimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Min values for date inputs: start >= now, end >= start
const minStart = computed(() => toDatetimeLocal(new Date()));
const minEnd = computed(() => form.eventStart || minStart.value);

// Auto-set end date to 1 hour after start when start is filled and end is empty
watch(() => form.eventStart, (val) => {
  if (val && !form.eventEnd) {
    const start = new Date(val);
    start.setHours(start.getHours() + 1);
    form.eventEnd = toDatetimeLocal(start);
  }
  // Clamp end if it's now before start
  if (val && form.eventEnd && form.eventEnd < val) {
    const start = new Date(val);
    start.setHours(start.getHours() + 1);
    form.eventEnd = toDatetimeLocal(start);
  }
});

const submitting = ref(false);
const submitError = ref('');
const publishOnSubmit = ref(false);

function handleImagesUpdate(files: { name: string; fileRef: string; mimeType: string; size: number }[]) {
  form.images = files.map(f => f.fileRef);
}

function handleAttachmentsUpdate(files: { name: string; fileRef: string; mimeType: string; size: number }[]) {
  form.attachments = files;
}

function addLink() {
  form.links.push({ label: '', url: '' });
}

function removeLink(idx: number) {
  form.links.splice(idx, 1);
}

async function handleSubmit() {
  submitting.value = true;
  submitError.value = '';

  const validLinks = form.links.filter(l => l.label.trim() && l.url.trim());

  const result = await activityStore.handleCreateNotice({
    type: form.type,
    title: form.title,
    summary: form.summary,
    state: publishOnSubmit.value ? 'published' : 'draft',
    eventStart: form.eventStart ? new Date(form.eventStart).toISOString() : undefined,
    eventEnd: form.eventEnd ? new Date(form.eventEnd).toISOString() : undefined,
    locationText: form.locationText || undefined,
    rsvpEnabled: form.rsvpEnabled || undefined,
    ackRequired: form.ackRequired || undefined,
    images: form.images.length > 0 ? form.images : undefined,
    attachments: form.attachments.length > 0 ? form.attachments : undefined,
    links: validLinks.length > 0 ? validLinks : undefined,
  });

  submitting.value = false;

  if (result.success) {
    emit('close');
  } else {
    submitError.value = result.error || 'Failed to create notice';
  }
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
  margin-bottom: 1.25rem;
}

.dialog-title {
  font-size: 1.2rem;
  font-weight: 600;
  margin: 0;
}

.dialog-close {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--matou-muted-foreground);
  padding: 0.25rem;
}

.form-group {
  margin-bottom: 1rem;
}

.form-label {
  display: block;
  font-size: 0.85rem;
  font-weight: 500;
  margin-bottom: 0.25rem;
  color: var(--matou-foreground);
}

.form-input {
  width: 100%;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--matou-border, #e5e7eb);
  border-radius: var(--matou-radius, 6px);
  font-size: 0.85rem;
  color: var(--matou-foreground);
  background: var(--matou-background, white);
  box-sizing: border-box;
}

.form-textarea {
  resize: vertical;
}

.type-selector {
  display: flex;
  gap: 0.5rem;
}

.type-btn {
  flex: 1;
  padding: 0.5rem;
  border: 1px solid var(--matou-border, #e5e7eb);
  border-radius: var(--matou-radius, 6px);
  background: transparent;
  cursor: pointer;
  font-size: 0.85rem;
  transition: all 0.15s;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.375rem;
}

.type-btn.active {
  background: var(--matou-primary);
  color: white;
  border-color: var(--matou-primary);
}

.form-section {
  border-top: 1px solid var(--matou-border, #e5e7eb);
  padding-top: 1rem;
  margin-top: 0.5rem;
}

.form-section-title {
  font-size: 0.9rem;
  font-weight: 600;
  margin: 0 0 0.75rem;
}

.form-row {
  display: flex;
  gap: 1rem;
}

.form-row .form-group {
  flex: 1;
}

.link-row {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
  align-items: center;
}

.link-input {
  flex: 1;
}

.link-remove {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 1.75rem;
  height: 1.75rem;
  border: none;
  border-radius: 50%;
  background: var(--matou-background, #f4f4f5);
  cursor: pointer;
  color: var(--matou-muted-foreground);
}

.link-remove:hover {
  color: var(--matou-destructive, #ef4444);
}

.add-link-btn {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 0.8rem;
  color: var(--matou-primary);
  padding: 0.25rem 0;
}

.form-error {
  color: #ef4444;
  font-size: 0.85rem;
  margin-bottom: 0.75rem;
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 1rem;
}

.form-btn {
  padding: 0.5rem 1rem;
  border: none;
  border-radius: var(--matou-radius, 6px);
  font-size: 0.85rem;
  font-weight: 500;
  cursor: pointer;
}

.form-btn.primary {
  background: var(--matou-primary);
  color: white;
}

.form-btn.secondary {
  background: var(--matou-background, #f4f4f5);
  color: var(--matou-foreground);
}

.form-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
