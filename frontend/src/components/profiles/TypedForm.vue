<template>
  <form @submit.prevent="handleSubmit" class="typed-form">
    <div v-for="field in visibleFields" :key="field.name" class="form-field">
      <label :for="field.name" class="field-label">
        {{ field.uiHints?.label || field.name }}
        <span v-if="field.required" class="required">*</span>
      </label>

      <!-- Text input -->
      <input
        v-if="getInputType(field) === 'text'"
        :id="field.name"
        v-model="formData[field.name]"
        type="text"
        :placeholder="field.uiHints?.placeholder"
        :readonly="field.readOnly"
        class="field-input"
      />

      <!-- Textarea -->
      <textarea
        v-else-if="getInputType(field) === 'textarea'"
        :id="field.name"
        v-model="formData[field.name]"
        :placeholder="field.uiHints?.placeholder"
        :readonly="field.readOnly"
        rows="3"
        class="field-textarea"
      />

      <!-- Select dropdown -->
      <select
        v-else-if="getInputType(field) === 'select'"
        :id="field.name"
        v-model="formData[field.name]"
        :disabled="field.readOnly"
        class="field-select"
      >
        <option value="">Select...</option>
        <option v-for="opt in field.validation?.enum" :key="opt" :value="opt">
          {{ opt }}
        </option>
      </select>

      <!-- Toggle -->
      <label v-else-if="getInputType(field) === 'toggle'" class="field-toggle">
        <input
          type="checkbox"
          v-model="formData[field.name]"
          :disabled="field.readOnly"
        />
        <span class="toggle-slider"></span>
      </label>

      <!-- Tags input -->
      <div v-else-if="getInputType(field) === 'tags'" class="field-tags">
        <div class="tags-list">
          <span
            v-for="(tag, i) in (formData[field.name] as string[] || [])"
            :key="i"
            class="tag"
          >
            {{ tag }}
            <button v-if="!field.readOnly" type="button" @click="removeTag(field.name, i)" class="tag-remove">&times;</button>
          </span>
        </div>
        <input
          v-if="!field.readOnly"
          type="text"
          :placeholder="field.uiHints?.placeholder || 'Add tag...'"
          @keydown.enter.prevent="addTag(field.name, $event)"
          class="tag-input"
        />
      </div>

      <!-- Image upload -->
      <div v-else-if="getInputType(field) === 'image-upload'" class="field-image-upload">
        <div v-if="formData[field.name]" class="image-preview">
          <img :src="getImageUrl(formData[field.name] as string)" alt="Preview" />
          <button v-if="!field.readOnly" type="button" @click="formData[field.name] = ''" class="remove-image">&times;</button>
        </div>
        <input
          v-if="!field.readOnly"
          type="file"
          accept="image/*"
          @change="handleImageUpload(field.name, $event)"
          class="file-input"
        />
      </div>

      <!-- Default: text input -->
      <input
        v-else
        :id="field.name"
        v-model="formData[field.name]"
        type="text"
        :placeholder="field.uiHints?.placeholder"
        :readonly="field.readOnly"
        class="field-input"
      />

      <p v-if="errors[field.name]" class="field-error">{{ errors[field.name] }}</p>
    </div>

    <div class="form-actions">
      <button type="submit" :disabled="submitting" class="submit-btn">
        {{ submitting ? 'Saving...' : 'Save' }}
      </button>
    </div>
  </form>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useTypesStore } from 'stores/types';
import { uploadFile, getFileUrl, type FieldDef } from 'src/lib/api/client';

const props = withDefaults(defineProps<{
  typeName: string;
  layout?: string;
  initialData?: Record<string, unknown>;
}>(), {
  layout: 'form',
});

const emit = defineEmits<{
  (e: 'submit', data: Record<string, unknown>): void;
}>();

const typesStore = useTypesStore();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const formData = ref<Record<string, any>>({});
const errors = ref<Record<string, string>>({});
const submitting = ref(false);

const visibleFields = computed(() => {
  const def = typesStore.getDefinition(props.typeName);
  if (!def) return [];

  const layoutFields = def.layouts?.[props.layout]?.fields;
  if (layoutFields) {
    return layoutFields
      .map(name => def.fields.find(f => f.name === name))
      .filter((f): f is FieldDef => !!f);
  }

  // Fall back to all non-readOnly fields
  return def.fields.filter(f => !f.readOnly);
});

function getInputType(field: FieldDef): string {
  if (field.uiHints?.inputType) return field.uiHints.inputType;
  if (field.type === 'boolean') return 'toggle';
  if (field.type === 'array') return 'tags';
  if (field.validation?.enum) return 'select';
  return 'text';
}

function getImageUrl(fileRef: string): string {
  if (!fileRef) return '';
  if (fileRef.startsWith('http') || fileRef.startsWith('data:')) return fileRef;
  return getFileUrl(fileRef);
}

function addTag(fieldName: string, event: Event) {
  const input = event.target as HTMLInputElement;
  const value = input.value.trim();
  if (!value) return;

  const current = (formData.value[fieldName] as string[]) || [];
  if (!current.includes(value)) {
    formData.value[fieldName] = [...current, value];
  }
  input.value = '';
}

function removeTag(fieldName: string, index: number) {
  const current = (formData.value[fieldName] as string[]) || [];
  formData.value[fieldName] = current.filter((_, i) => i !== index);
}

async function handleImageUpload(fieldName: string, event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  if (file.size > 5 * 1024 * 1024) {
    errors.value[fieldName] = 'File must be under 5MB';
    return;
  }

  const result = await uploadFile(file);
  if (result.fileRef) {
    formData.value[fieldName] = result.fileRef;
    delete errors.value[fieldName];
  } else {
    errors.value[fieldName] = result.error || 'Upload failed';
  }
}

function validate(): boolean {
  errors.value = {};
  const def = typesStore.getDefinition(props.typeName);
  if (!def) return false;

  let valid = true;
  for (const field of def.fields) {
    const val = formData.value[field.name];
    if (field.required && (val === undefined || val === null || val === '')) {
      errors.value[field.name] = `${field.uiHints?.label || field.name} is required`;
      valid = false;
    }
    if (field.validation?.maxLength && typeof val === 'string' && val.length > field.validation.maxLength) {
      errors.value[field.name] = `Must be at most ${field.validation.maxLength} characters`;
      valid = false;
    }
    if (field.validation?.minLength && typeof val === 'string' && val.length < field.validation.minLength) {
      errors.value[field.name] = `Must be at least ${field.validation.minLength} characters`;
      valid = false;
    }
  }
  return valid;
}

async function handleSubmit() {
  if (!validate()) return;
  submitting.value = true;
  try {
    emit('submit', { ...formData.value });
  } finally {
    submitting.value = false;
  }
}

onMounted(() => {
  // Initialize form data from initial data or defaults
  const def = typesStore.getDefinition(props.typeName);
  if (def) {
    for (const field of def.fields) {
      if (props.initialData?.[field.name] !== undefined) {
        formData.value[field.name] = props.initialData[field.name];
      } else if (field.default !== undefined) {
        formData.value[field.name] = field.default;
      } else if (field.type === 'array') {
        formData.value[field.name] = [];
      } else if (field.type === 'boolean') {
        formData.value[field.name] = false;
      } else if (field.type === 'object') {
        formData.value[field.name] = {};
      } else {
        formData.value[field.name] = '';
      }
    }
  }
});
</script>

<style scoped>
.typed-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.form-field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.field-label {
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--matou-text-secondary, #6b7280);
}

.required {
  color: #ef4444;
}

.field-input,
.field-textarea,
.field-select {
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--matou-border, #d1d5db);
  border-radius: 10px;
  font-size: 0.875rem;
  background: var(--matou-surface, #fff);
  color: var(--matou-text, #1f2937);
}

.field-input:focus,
.field-textarea:focus,
.field-select:focus {
  outline: none;
  border-color: var(--matou-primary, #6366f1);
  box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.1);
}

.field-textarea {
  resize: vertical;
  min-height: 4rem;
}

.field-toggle {
  position: relative;
  display: inline-block;
  width: 2.5rem;
  height: 1.25rem;
}

.field-toggle input {
  opacity: 0;
  width: 0;
  height: 0;
}

.toggle-slider {
  position: absolute;
  cursor: pointer;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: #ccc;
  border-radius: 1.25rem;
  transition: 0.2s;
}

.toggle-slider::before {
  content: '';
  position: absolute;
  height: 1rem;
  width: 1rem;
  left: 0.125rem;
  bottom: 0.125rem;
  background-color: white;
  border-radius: 50%;
  transition: 0.2s;
}

.field-toggle input:checked + .toggle-slider {
  background-color: var(--matou-primary, #6366f1);
}

.field-toggle input:checked + .toggle-slider::before {
  transform: translateX(1.25rem);
}

.field-tags {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.tags-list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
}

.tag {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.125rem 0.5rem;
  background: var(--matou-primary-light, #e0e7ff);
  color: var(--matou-primary, #4f46e5);
  border-radius: 9999px;
  font-size: 0.75rem;
}

.tag-remove {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 0.875rem;
  color: inherit;
  padding: 0;
  line-height: 1;
}

.tag-input {
  padding: 0.375rem 0.5rem;
  border: 1px solid var(--matou-border, #d1d5db);
  border-radius: 10px;
  font-size: 0.75rem;
}

.field-image-upload {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.image-preview {
  position: relative;
  width: 5rem;
  height: 5rem;
}

.image-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 50%;
}

.remove-image {
  position: absolute;
  top: -0.25rem;
  right: -0.25rem;
  width: 1.25rem;
  height: 1.25rem;
  border-radius: 50%;
  background: #ef4444;
  color: white;
  border: none;
  cursor: pointer;
  font-size: 0.75rem;
  display: flex;
  align-items: center;
  justify-content: center;
}

.file-input {
  font-size: 0.75rem;
}

.field-error {
  font-size: 0.75rem;
  color: #ef4444;
  margin: 0;
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  padding-top: 0.5rem;
}

.submit-btn {
  padding: 0.5rem 1.5rem;
  background: var(--matou-primary, #6366f1);
  color: white;
  border: none;
  border-radius: 10px;
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
}

.submit-btn:hover {
  opacity: 0.9;
}

.submit-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
