<template>
  <Teleport to="body">
    <div class="modal-overlay" @click.self="$emit('close')">
      <div class="modal-content">
        <header class="modal-header">
          <h2>Create Channel</h2>
          <button class="close-btn" @click="$emit('close')">
            <X class="icon" />
          </button>
        </header>

        <form @submit.prevent="handleSubmit" class="modal-body">
          <div class="form-group">
            <label for="name">Channel Name</label>
            <input
              id="name"
              v-model="form.name"
              type="text"
              placeholder="e.g., general"
              required
              :disabled="loading"
            />
          </div>

          <div class="form-group">
            <label for="description">Description (optional)</label>
            <textarea
              id="description"
              v-model="form.description"
              placeholder="What is this channel about?"
              rows="3"
              :disabled="loading"
            ></textarea>
          </div>

          <div class="form-group">
            <label>Icon (optional)</label>
            <div class="icon-selector">
              <div class="icon-preview" :class="{ empty: !form.icon }">
                {{ form.icon || '💬' }}
              </div>
              <div class="icon-grid">
                <button
                  v-for="emoji in channelEmojis"
                  :key="emoji"
                  type="button"
                  class="icon-option"
                  :class="{ selected: form.icon === emoji }"
                  :disabled="loading"
                  @click="form.icon = form.icon === emoji ? '' : emoji"
                >
                  {{ emoji }}
                </button>
              </div>
            </div>
          </div>

          <div class="form-group">
            <label>Visibility</label>
            <div class="radio-group">
              <label class="radio-option">
                <input
                  type="radio"
                  v-model="visibility"
                  value="all"
                  :disabled="loading"
                />
                <span>All members</span>
              </label>
              <label class="radio-option">
                <input
                  type="radio"
                  v-model="visibility"
                  value="admin"
                  :disabled="loading"
                />
                <span>Admins only</span>
              </label>
            </div>
          </div>

          <div v-if="error" class="error-message">
            {{ error }}
          </div>

          <div class="modal-actions">
            <button type="button" class="btn-secondary" @click="$emit('close')" :disabled="loading">
              Cancel
            </button>
            <button type="submit" class="btn-primary" :disabled="loading || !form.name.trim()">
              <Loader2 v-if="loading" class="icon spin" />
              <span>{{ loading ? 'Creating...' : 'Create Channel' }}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, reactive } from 'vue';
import { X, Loader2 } from 'lucide-vue-next';
import { useChatStore } from 'stores/chat';

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'created', channelId: string): void;
}>();

const chatStore = useChatStore();

const channelEmojis = [
  '💬', '📢', '🎯', '🚀', '💡', '🔥', '⭐', '🎉',
  '📌', '🛠️', '📋', '🤝', '🌿', '🏠', '🎨', '📚',
];

const form = reactive({
  name: '',
  description: '',
  icon: '',
});

const visibility = ref<'all' | 'admin'>('all');
const loading = ref(false);
const error = ref<string | null>(null);

async function handleSubmit() {
  if (!form.name.trim()) return;

  loading.value = true;
  error.value = null;

  try {
    const channelId = await chatStore.createChannel({
      name: form.name.trim(),
      description: form.description.trim() || undefined,
      icon: form.icon.trim() || undefined,
      allowedRoles: visibility.value === 'admin' ? ['admin', 'steward'] : undefined,
    });

    if (channelId) {
      emit('created', channelId);
    } else {
      error.value = chatStore.error || 'Failed to create channel';
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to create channel';
  } finally {
    loading.value = false;
  }
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
  max-width: 480px;
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

  label {
    display: block;
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--matou-foreground);
    margin-bottom: 0.375rem;
  }

  input,
  textarea {
    width: 100%;
    padding: 0.625rem 0.75rem;
    border: 1px solid var(--matou-border);
    border-radius: var(--matou-radius);
    background-color: var(--matou-background);
    color: var(--matou-foreground);
    font-size: 0.875rem;
    font-family: inherit;
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

  textarea {
    resize: vertical;
    min-height: 80px;
  }

  .hint {
    display: block;
    font-size: 0.75rem;
    color: var(--matou-muted-foreground);
    margin-top: 0.25rem;
  }
}

.icon-selector {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
}

.icon-preview {
  flex-shrink: 0;
  width: 3rem;
  height: 3rem;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.5rem;
  border: 1px solid var(--matou-border);
  border-radius: var(--matou-radius);
  background-color: var(--matou-background);

  &.empty {
    opacity: 0.4;
  }
}

.icon-grid {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 0.25rem;
}

.icon-option {
  width: 2rem;
  height: 2rem;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  border-radius: var(--matou-radius);
  background: transparent;
  cursor: pointer;
  font-size: 1rem;
  transition: all 0.15s ease;

  &:hover:not(:disabled) {
    background-color: var(--matou-secondary);
  }

  &.selected {
    border-color: var(--matou-primary);
    background-color: rgba(0, 100, 0, 0.06);
  }

  &:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
}

.radio-group {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.radio-option {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
  font-size: 0.875rem;

  input[type="radio"] {
    width: 16px;
    height: 16px;
    margin: 0;
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
  margin-top: 1.5rem;
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
