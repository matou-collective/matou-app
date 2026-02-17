<template>
  <Teleport to="body">
    <div class="modal-overlay" @click.self="$emit('close')">
      <div class="modal-content">
        <header class="modal-header">
          <h2>Channel Settings</h2>
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
              required
              :disabled="loading"
            />
          </div>

          <div class="form-group">
            <label for="description">Description</label>
            <textarea
              id="description"
              v-model="form.description"
              placeholder="What is this channel about?"
              rows="3"
              :disabled="loading"
            ></textarea>
          </div>

          <div class="form-group">
            <label for="icon">Icon</label>
            <input
              id="icon"
              v-model="form.icon"
              type="text"
              placeholder="e.g., 💬"
              maxlength="10"
              :disabled="loading"
            />
          </div>

          <div v-if="error" class="error-message">
            {{ error }}
          </div>

          <div class="modal-actions">
            <button
              type="button"
              class="btn-danger"
              @click="handleArchive"
              :disabled="loading || archiving"
            >
              <Loader2 v-if="archiving" class="icon spin" />
              <Archive v-else class="icon" />
              <span>Archive Channel</span>
            </button>
            <div class="spacer"></div>
            <button type="button" class="btn-secondary" @click="$emit('close')" :disabled="loading">
              Cancel
            </button>
            <button type="submit" class="btn-primary" :disabled="loading || !form.name.trim()">
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
import { ref, reactive, onMounted } from 'vue';
import { X, Loader2, Archive } from 'lucide-vue-next';
import { useChatStore } from 'stores/chat';
import type { Channel } from 'src/lib/api/chat';

const props = defineProps<{
  channel: Channel;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'updated'): void;
}>();

const chatStore = useChatStore();

const form = reactive({
  name: '',
  description: '',
  icon: '',
});

const loading = ref(false);
const archiving = ref(false);
const error = ref<string | null>(null);

onMounted(() => {
  form.name = props.channel.name;
  form.description = props.channel.description || '';
  form.icon = props.channel.icon || '';
});

async function handleSubmit() {
  if (!form.name.trim()) return;

  loading.value = true;
  error.value = null;

  try {
    const success = await chatStore.updateChannel(props.channel.id, {
      name: form.name.trim(),
      description: form.description.trim() || undefined,
      icon: form.icon.trim() || undefined,
    });

    if (success) {
      emit('updated');
    } else {
      error.value = chatStore.error || 'Failed to update channel';
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to update channel';
  } finally {
    loading.value = false;
  }
}

async function handleArchive() {
  if (!confirm('Are you sure you want to archive this channel? Members will no longer be able to see it.')) {
    return;
  }

  archiving.value = true;
  error.value = null;

  try {
    const success = await chatStore.archiveChannel(props.channel.id);

    if (success) {
      emit('close');
    } else {
      error.value = chatStore.error || 'Failed to archive channel';
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Failed to archive channel';
  } finally {
    archiving.value = false;
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
  align-items: center;
  margin-top: 1.5rem;
}

.spacer {
  flex: 1;
}

.btn-secondary,
.btn-primary,
.btn-danger {
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

  .icon {
    width: 16px;
    height: 16px;
  }

  .spin {
    animation: spin 1s linear infinite;
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
}

.btn-danger {
  background-color: transparent;
  border: 1px solid var(--matou-destructive);
  color: var(--matou-destructive);

  &:hover:not(:disabled) {
    background-color: rgba(239, 68, 68, 0.1);
  }
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
