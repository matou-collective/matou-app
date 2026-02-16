<template>
  <div class="dialog-overlay" @click.self="$emit('close')">
    <div class="dialog-content">
      <div class="dialog-header">
        <h2 class="dialog-title">Create Notice</h2>
        <button class="dialog-close" @click="$emit('close')">
          <X :size="18" />
        </button>
      </div>

      <form @submit.prevent="handleSubmit">
        <div class="form-group">
          <label class="form-label">Type</label>
          <div class="type-selector">
            <button type="button" class="type-btn" :class="{ active: form.type === 'event' }" @click="form.type = 'event'">Event</button>
            <button type="button" class="type-btn" :class="{ active: form.type === 'update' }" @click="form.type = 'update'">Update</button>
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Title *</label>
          <input v-model="form.title" class="form-input" placeholder="Notice title" required />
        </div>

        <div class="form-group">
          <label class="form-label">Summary *</label>
          <textarea v-model="form.summary" class="form-input form-textarea" placeholder="Brief summary..." required rows="2" />
        </div>

        <div class="form-group">
          <label class="form-label">Body</label>
          <textarea v-model="form.body" class="form-input form-textarea" placeholder="Full details..." rows="4" />
        </div>

        <div v-if="form.type === 'event'" class="form-section">
          <h3 class="form-section-title">Event Details</h3>

          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Start</label>
              <input v-model="form.eventStart" type="datetime-local" class="form-input" />
            </div>
            <div class="form-group">
              <label class="form-label">End</label>
              <input v-model="form.eventEnd" type="datetime-local" class="form-input" />
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

        <div v-if="form.type === 'update'" class="form-section">
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
import { ref, reactive } from 'vue';
import { X } from 'lucide-vue-next';
import { useActivityStore } from 'stores/activity';

const emit = defineEmits<{ (e: 'close'): void }>();
const activityStore = useActivityStore();

const form = reactive({
  type: 'event' as 'event' | 'update',
  title: '',
  summary: '',
  body: '',
  eventStart: '',
  eventEnd: '',
  locationText: '',
  rsvpEnabled: false,
  ackRequired: false,
});

const submitting = ref(false);
const submitError = ref('');
const publishOnSubmit = ref(false);

async function handleSubmit() {
  submitting.value = true;
  submitError.value = '';

  const result = await activityStore.handleCreateNotice({
    type: form.type,
    title: form.title,
    summary: form.summary,
    body: form.body || undefined,
    state: publishOnSubmit.value ? 'published' : 'draft',
    eventStart: form.eventStart ? new Date(form.eventStart).toISOString() : undefined,
    eventEnd: form.eventEnd ? new Date(form.eventEnd).toISOString() : undefined,
    locationText: form.locationText || undefined,
    rsvpEnabled: form.rsvpEnabled || undefined,
    ackRequired: form.ackRequired || undefined,
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
