<template>
  <div class="typed-display" :class="`layout-${layout}`">
    <template v-for="field in visibleFields" :key="field.name">
      <div class="display-field" :class="`format-${getDisplayFormat(field)}`">
        <!-- Avatar -->
        <div v-if="getDisplayFormat(field) === 'avatar'" class="avatar-display">
          <img
            v-if="getFieldValue(field.name)"
            :src="getImageUrl(getFieldValue(field.name) as string)"
            :alt="field.uiHints?.label || field.name"
            class="avatar-img"
          />
          <div v-else class="avatar-placeholder">
            {{ getInitials() }}
          </div>
        </div>

        <!-- Badge -->
        <span v-else-if="getDisplayFormat(field) === 'badge'" class="badge">
          {{ getFieldValue(field.name) }}
        </span>

        <!-- Chip list -->
        <div v-else-if="getDisplayFormat(field) === 'chip-list'" class="chip-list">
          <span class="field-label-small" v-if="layout === 'detail'">{{ field.uiHints?.label || field.name }}</span>
          <div class="chips">
            <span
              v-for="(item, i) in (getFieldValue(field.name) as unknown[] || [])"
              :key="i"
              class="chip"
            >
              {{ item }}
            </span>
          </div>
        </div>

        <!-- Relative date -->
        <span v-else-if="getDisplayFormat(field) === 'relative-date'" class="relative-date">
          <span class="field-label-small" v-if="layout === 'detail'">{{ field.uiHints?.label || field.name }}</span>
          {{ formatRelativeDate(getFieldValue(field.name) as string) }}
        </span>

        <!-- Link -->
        <div v-else-if="getDisplayFormat(field) === 'link'" class="link-list">
          <span class="field-label-small" v-if="layout === 'detail'">{{ field.uiHints?.label || field.name }}</span>
          <template v-if="Array.isArray(getFieldValue(field.name))">
            <a
              v-for="(url, i) in (getFieldValue(field.name) as string[])"
              :key="i"
              :href="url"
              target="_blank"
              rel="noopener noreferrer"
              class="link"
            >
              {{ url }}
            </a>
          </template>
          <a
            v-else-if="getFieldValue(field.name)"
            :href="getFieldValue(field.name) as string"
            target="_blank"
            rel="noopener noreferrer"
            class="link"
          >
            {{ getFieldValue(field.name) }}
          </a>
        </div>

        <!-- Default: plain text -->
        <div v-else class="text-field">
          <span class="field-label-small" v-if="layout === 'detail'">{{ field.uiHints?.label || field.name }}</span>
          <span class="field-value">{{ getFieldValue(field.name) }}</span>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useTypesStore } from 'stores/types';
import { getFileUrl, type FieldDef } from 'src/lib/api/client';

const props = withDefaults(defineProps<{
  typeName: string;
  layout?: string;
  data: Record<string, unknown>;
}>(), {
  layout: 'card',
});

const typesStore = useTypesStore();

const visibleFields = computed(() => {
  const def = typesStore.getDefinition(props.typeName);
  if (!def) return [];

  const layoutFields = def.layouts?.[props.layout]?.fields;
  if (layoutFields) {
    return layoutFields
      .map(name => def.fields.find(f => f.name === name))
      .filter((f): f is FieldDef => !!f);
  }

  return def.fields;
});

function getFieldValue(name: string): unknown {
  return props.data?.[name] ?? '';
}

function getDisplayFormat(field: FieldDef): string {
  return field.uiHints?.displayFormat || 'text';
}

function getImageUrl(fileRef: string): string {
  if (!fileRef) return '';
  if (fileRef.startsWith('http') || fileRef.startsWith('data:')) return fileRef;
  return getFileUrl(fileRef);
}

function getInitials(): string {
  const name = (props.data?.displayName as string) || '';
  const parts = name.split(' ');
  if (parts.length >= 2) {
    return `${parts[0].charAt(0)}${parts[1].charAt(0)}`.toUpperCase();
  }
  return name.substring(0, 2).toUpperCase();
}

function formatRelativeDate(dateStr: string): string {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
  if (diffDays < 365) return date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  return date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}
</script>

<style scoped>
.typed-display {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.layout-card {
  flex-direction: row;
  align-items: center;
  gap: 0.75rem;
}

.layout-detail {
  gap: 0.75rem;
}

.field-label-small {
  display: block;
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--matou-text-secondary, #6b7280);
  margin-bottom: 0.125rem;
}

.avatar-display {
  flex-shrink: 0;
}

.avatar-img {
  width: 3rem;
  height: 3rem;
  border-radius: 50%;
  object-fit: cover;
}

.avatar-placeholder {
  width: 3rem;
  height: 3rem;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--matou-primary, #6366f1), var(--matou-accent, #8b5cf6));
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  font-size: 0.875rem;
}

.badge {
  display: inline-block;
  padding: 0.125rem 0.5rem;
  background: var(--matou-primary-light, #e0e7ff);
  color: var(--matou-primary, #4f46e5);
  border-radius: 9999px;
  font-size: 0.75rem;
  font-weight: 500;
}

.chip-list .chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
}

.chip {
  display: inline-block;
  padding: 0.125rem 0.5rem;
  background: var(--matou-surface-alt, #f3f4f6);
  color: var(--matou-text, #1f2937);
  border-radius: 9999px;
  font-size: 0.75rem;
}

.relative-date {
  font-size: 0.75rem;
  color: var(--matou-text-secondary, #6b7280);
}

.link-list {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.link {
  color: var(--matou-primary, #6366f1);
  font-size: 0.75rem;
  text-decoration: none;
}

.link:hover {
  text-decoration: underline;
}

.text-field {
  font-size: 0.875rem;
}

.field-value {
  color: var(--matou-text, #1f2937);
}
</style>
