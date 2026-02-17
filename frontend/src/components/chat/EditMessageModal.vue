<template>
  <Teleport to="body">
    <div class="modal-overlay" @click.self="$emit('close')">
      <div class="modal-content">
        <header class="modal-header">
          <h2>Edit Message</h2>
          <button class="close-btn" @click="$emit('close')">
            <X class="icon" />
          </button>
        </header>

        <form @submit.prevent="handleSubmit" class="modal-body">
          <div class="form-group">
            <textarea
              ref="textareaRef"
              v-model="content"
              rows="4"
              placeholder="Edit your message..."
              :disabled="loading"
              @keydown="handleKeydown"
            ></textarea>
          </div>

          <div v-if="error" class="error-message">
            {{ error }}
          </div>

          <div class="modal-actions">
            <button type="button" class="btn-secondary" @click="$emit('close')" :disabled="loading">
              Cancel
            </button>
            <button type="submit" class="btn-primary" :disabled="loading || !content.trim()">
              <Loader2 v-if="loading" class="icon spin" />
              <span>{{ loading ? 'Saving...' : 'Save Changes' }}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, onMounted, nextTick } from 'vue';
import { X, Loader2 } from 'lucide-vue-next';
import type { ChatMessage } from 'src/lib/api/chat';

const props = defineProps<{
  message: ChatMessage;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'save', messageId: string, content: string): void;
}>();

const content = ref('');
const loading = ref(false);
const error = ref<string | null>(null);
const textareaRef = ref<HTMLTextAreaElement | null>(null);

onMounted(async () => {
  content.value = props.message.content;
  await nextTick();
  textareaRef.value?.focus();
  // Move cursor to end
  if (textareaRef.value) {
    textareaRef.value.selectionStart = textareaRef.value.value.length;
    textareaRef.value.selectionEnd = textareaRef.value.value.length;
  }
});

function handleKeydown(e: KeyboardEvent) {
  // Save on Cmd/Ctrl + Enter
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    handleSubmit();
  }
  // Close on Escape
  if (e.key === 'Escape') {
    emit('close');
  }
}

function handleSubmit() {
  if (!content.value.trim() || loading.value) return;

  loading.value = true;
  error.value = null;

  emit('save', props.message.id, content.value.trim());
  // The parent will handle closing the modal after successful save
}
</script>

<style lang="scss" scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background-color: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal-content {
  width: 90%;
  max-width: 500px;
  background-color: var(--matou-card);
  border-radius: var(--matou-radius-xl);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.2);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--matou-border);

  h2 {
    margin: 0;
    font-size: 1.125rem;
    font-weight: 600;
  }
}

.close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--matou-radius);
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--matou-muted-foreground);
  transition: all 0.15s ease;

  &:hover {
    background-color: var(--matou-secondary);
    color: var(--matou-foreground);
  }

  .icon {
    width: 18px;
    height: 18px;
  }
}

.modal-body {
  padding: 1.25rem;
}

.form-group {
  margin-bottom: 1rem;

  textarea {
    width: 100%;
    padding: 0.75rem;
    border: 1px solid var(--matou-border);
    border-radius: var(--matou-radius);
    background-color: var(--matou-background);
    color: var(--matou-foreground);
    font-size: 0.875rem;
    font-family: inherit;
    line-height: 1.5;
    resize: vertical;
    min-height: 100px;
    transition: border-color 0.15s ease;

    &:focus {
      outline: none;
      border-color: var(--matou-primary);
    }

    &:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    &::placeholder {
      color: var(--matou-muted-foreground);
    }
  }
}

.error-message {
  background-color: rgba(239, 68, 68, 0.1);
  border: 1px solid var(--matou-destructive);
  color: var(--matou-destructive);
  padding: 0.75rem;
  border-radius: var(--matou-radius);
  font-size: 0.875rem;
  margin-bottom: 1rem;
}

.modal-actions {
  display: flex;
  gap: 0.75rem;
  justify-content: flex-end;
}

.btn-secondary,
.btn-primary {
  padding: 0.625rem 1rem;
  border-radius: var(--matou-radius);
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
  display: flex;
  align-items: center;
  gap: 0.5rem;

  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
}

.btn-secondary {
  background-color: transparent;
  border: 1px solid var(--matou-border);
  color: var(--matou-foreground);

  &:hover:not(:disabled) {
    background-color: var(--matou-secondary);
  }
}

.btn-primary {
  background-color: var(--matou-primary);
  border: none;
  color: white;

  &:hover:not(:disabled) {
    opacity: 0.9;
  }

  .icon {
    width: 16px;
    height: 16px;
  }

  .spin {
    animation: spin 1s linear infinite;
  }
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
