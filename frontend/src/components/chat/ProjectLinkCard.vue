<template>
  <div class="entity-link-card" @click="$emit('open', projectId)">
    <!-- Loading -->
    <div v-if="loading" class="card-loading">
      <q-spinner-dots size="20px" color="primary" />
      <span>Loading project...</span>
    </div>

    <!-- Error -->
    <div v-else-if="error" class="card-error">
      <q-icon name="error_outline" size="18px" color="grey-6" />
      <span>Project not found</span>
    </div>

    <!-- Project preview -->
    <template v-else-if="project">
      <div class="card-header">
        <q-icon name="folder" size="18px" color="primary" />
        <span class="card-title">{{ project.title }}</span>
      </div>
      <div class="card-meta">
        <span class="status-badge" :class="project.status">
          {{ formatStatus(project.status) }}
        </span>
        <span v-if="project.budget" class="type-tag">{{ project.budget }}</span>
        <span v-if="project.duration" class="type-tag">{{ project.duration }}</span>
      </div>
      <div class="card-footer">
        <span class="view-action">View Project</span>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { getProject, type Project } from 'src/lib/api/projects';

const props = defineProps<{
  projectId: string;
}>();

defineEmits<{
  (e: 'open', id: string): void;
}>();

const project = ref<Project | null>(null);
const loading = ref(true);
const error = ref(false);

function formatStatus(status: string) {
  return status.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
}

onMounted(async () => {
  try {
    project.value = await getProject(props.projectId);
  } catch {
    error.value = true;
  } finally {
    loading.value = false;
  }
});
</script>

<style lang="scss" scoped>
.entity-link-card {
  margin-top: 0.5rem;
  padding: 0.625rem 0.75rem;
  background: var(--matou-card);
  border: 1px solid var(--matou-border);
  border-left: 3px solid var(--matou-primary);
  border-radius: var(--matou-radius);
  cursor: pointer;
  transition: background-color 0.15s ease, box-shadow 0.15s ease;
  width: 100%;
  min-width: 0;
  box-sizing: border-box;

  &:hover {
    background: var(--matou-secondary);
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
  }
}

.card-loading,
.card-error {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8rem;
  color: var(--matou-muted-foreground);
  padding: 0.25rem 0;
}

.card-header {
  display: flex;
  align-items: flex-start;
  gap: 0.375rem;
  margin-bottom: 0.375rem;
  min-width: 0;
}

.card-title {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--matou-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;

  @media (max-width: 480px) {
    white-space: normal;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }
}

.card-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
  margin-bottom: 0.375rem;
}

.status-badge {
  font-size: 0.675rem;
  padding: 1px 8px;
  border-radius: 10px;
  text-transform: capitalize;
  font-weight: 500;
  white-space: nowrap;
  background: var(--matou-muted);
  color: var(--matou-muted-foreground);

  &.created { background: #f3f4f6; color: #6b7280; }
  &.active { background: #dbeafe; color: #2563eb; }
  &.pending_completion { background: #fef3c7; color: #d97706; }
  &.completed { background: #d1fae5; color: #059669; }
  &.archived { background: #f3f4f6; color: #6b7280; }
}

.type-tag {
  font-size: 0.675rem;
  padding: 1px 8px;
  border-radius: 10px;
  background: #f3f4f6;
  color: #6b7280;
  text-transform: capitalize;
  white-space: nowrap;
}

.card-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.5rem;
}

.view-action {
  font-size: 0.75rem;
  color: var(--matou-primary);
  font-weight: 500;
  white-space: nowrap;
  flex-shrink: 0;
}
</style>
