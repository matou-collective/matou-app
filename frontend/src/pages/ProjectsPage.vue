<template>
  <div class="projects-page">
    <div class="projects-header">
      <div class="projects-header-text">
        <h2 class="projects-title">Projects</h2>
        <p class="projects-subtitle">Community projects and contributions</p>
      </div>
      <button class="create-btn" @click="showCreateDialog = true">
        + New Project
      </button>
    </div>

    <div class="feed-container">
      <div v-if="projectsStore.isLoading" class="loading-state">
        <q-spinner-dots size="40px" color="primary" />
      </div>
      <div v-else-if="projectsStore.projects.length === 0" class="empty-state">
        <Target :size="48" class="empty-icon" />
        <h3>No projects yet</h3>
        <p>Create a project to organize contributions and track progress.</p>
      </div>
      <div v-else class="projects-list">
        <div
          v-for="project in projectsStore.projects"
          :key="project.id"
          class="project-card"
        >
          <div class="project-card-header">
            <h3>{{ project.title }}</h3>
            <span class="status-badge" :class="project.status">{{ project.status }}</span>
          </div>
          <p class="project-description">{{ project.description }}</p>
          <div class="project-meta">
            <span>Created {{ new Date(project.created_at).toLocaleDateString() }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Create Project Dialog -->
    <q-dialog v-model="showCreateDialog">
      <q-card style="min-width: 500px">
        <q-card-section>
          <div class="text-h6">Create Project</div>
        </q-card-section>
        <q-card-section>
          <q-input v-model="newProject.title" label="Title" outlined class="q-mb-md" />
          <q-input v-model="newProject.description" label="Description" type="textarea" outlined />
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat label="Cancel" v-close-popup />
          <q-btn flat label="Create" color="primary" @click="createProject" :loading="creating" />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { Target } from 'lucide-vue-next';
import { useProjectsStore } from 'stores/projects';

const projectsStore = useProjectsStore();
const showCreateDialog = ref(false);
const creating = ref(false);
const newProject = ref({ title: '', description: '', created_by: '' });

onMounted(() => {
  projectsStore.fetchProjects();
});

async function createProject() {
  creating.value = true;
  try {
    await projectsStore.create({
      title: newProject.value.title,
      description: newProject.value.description,
      created_by: newProject.value.created_by || 'current-user',
    });
    showCreateDialog.value = false;
    newProject.value = { title: '', description: '', created_by: '' };
  } finally {
    creating.value = false;
  }
}
</script>

<style scoped lang="scss">
.projects-page {
  padding: 24px;
  max-width: 900px;
}

.projects-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 24px;
}

.projects-title {
  font-size: 1.5rem;
  font-weight: 600;
  margin: 0;
}

.projects-subtitle {
  color: var(--text-secondary);
  margin: 4px 0 0;
}

.create-btn {
  background: var(--matou-teal);
  color: white;
  border: none;
  border-radius: 8px;
  padding: 8px 16px;
  font-weight: 500;
  cursor: pointer;
  &:hover { opacity: 0.9; }
}

.loading-state,
.empty-state {
  text-align: center;
  padding: 60px 20px;
  color: var(--text-secondary);
}

.empty-icon {
  opacity: 0.3;
  margin-bottom: 16px;
}

.project-card {
  background: var(--card-bg, #fff);
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 12px;
}

.project-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
  h3 { margin: 0; font-size: 1.1rem; }
}

.status-badge {
  font-size: 0.75rem;
  padding: 2px 8px;
  border-radius: 12px;
  background: var(--matou-teal-light, #e0f7f4);
  color: var(--matou-teal);
  &.active { background: #d1fae5; color: #059669; }
  &.completed { background: #dbeafe; color: #2563eb; }
  &.archived { background: #f3f4f6; color: #6b7280; }
}

.project-description {
  color: var(--text-secondary);
  margin: 0 0 12px;
}

.project-meta {
  font-size: 0.8rem;
  color: var(--text-tertiary, #9ca3af);
}
</style>
