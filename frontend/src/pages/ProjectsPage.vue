<template>
  <div class="projects-page">
    <div class="projects-header">
      <div class="projects-header-text">
        <h2 class="projects-title">Projects</h2>
        <p class="projects-subtitle">Community projects and contributions</p>
      </div>
      <button v-if="isAdmin" class="create-btn" @click="showCreateDialog = true">
        + New Project
      </button>
    </div>

    <div v-if="!loaded" class="loading-state">
      <q-spinner-dots size="40px" color="primary" />
    </div>

    <template v-else>
      <!-- ── My Projects ───────────────────────────────────────── -->
      <section class="my-projects-section">
        <div class="section-header">
          <h3 class="section-title">My Projects</h3>
          <button
            class="archived-toggle"
            :class="{ active: myShowArchived }"
            @click="myShowArchived = !myShowArchived"
          >
            Archived
          </button>
        </div>
        <p class="section-hint">
          Projects you created, lead, steward, or have an assigned contribution on.
        </p>
        <div v-if="myProjectsFiltered.length === 0" class="empty-state-inline">
          <Target :size="32" class="empty-icon" />
          <span>{{ myShowArchived ? 'No archived projects.' : 'No active projects yet.' }}</span>
        </div>
        <div v-else class="projects-list">
          <ProjectCard
            v-for="project in myProjectsFiltered"
            :key="project.id"
            :project="project"
            :name-map="nameMap"
            :contributions="projectsStore.projectContributions[project.id] || []"
            @click="router.push({ name: 'project-detail', params: { id: project.id } })"
          />
        </div>
      </section>

      <!-- ── All Projects ──────────────────────────────────────── -->
      <section class="all-projects-section">
        <div class="section-header">
          <h3 class="section-title">All Projects</h3>
        </div>
        <div class="filter-row">
          <button
            v-for="f in filters"
            :key="f.value"
            class="filter-pill"
            :class="{ active: activeFilter === f.value }"
            @click="activeFilter = f.value"
          >
            {{ f.label }}
          </button>
        </div>
        <div v-if="filteredProjects.length === 0" class="empty-state">
          <Target :size="48" class="empty-icon" />
          <h3>No projects yet</h3>
          <p>Create a project to organise contributions and track progress.</p>
        </div>
        <div v-else class="projects-list">
          <ProjectCard
            v-for="project in filteredProjects"
            :key="project.id"
            :project="project"
            :name-map="nameMap"
            :contributions="projectsStore.projectContributions[project.id] || []"
            @click="router.push({ name: 'project-detail', params: { id: project.id } })"
          />
        </div>
      </section>
    </template>

    <!-- Create Project Dialog -->
    <ProjectForm
      v-model="showCreateDialog"
      :is-submitting="creating"
      :submit-error="createError"
      @submit="handleCreateSubmit"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { Target } from 'lucide-vue-next';
import { useQuasar } from 'quasar';
import { useProjectsStore } from 'stores/projects';
import { useOnboardingStore } from 'stores/onboarding';
import { useIdentityStore } from 'stores/identity';
import ProjectCard from 'src/components/projects/ProjectCard.vue';
import ProjectForm from 'src/components/projects/ProjectForm.vue';

const router = useRouter();
const $q = useQuasar();
const projectsStore = useProjectsStore();
const onboardingStore = useOnboardingStore();
const identityStore = useIdentityStore();
const isAdmin = computed(() => identityStore.isAdmin);

const showCreateDialog = ref(false);
const creating = ref(false);
const createError = ref<string | null>(null);
const activeFilter = ref('all');
const myShowArchived = ref(false);
const nameMap = ref<Record<string, string>>({});
const loaded = ref(false);

const filters = [
  { label: 'All', value: 'all' },
  { label: 'Active', value: 'active' },
  { label: 'Created', value: 'created' },
  { label: 'Completed', value: 'completed' },
  { label: 'Archived', value: 'archived' },
];

const currentUserId = computed(() => identityStore.aidPrefix ?? '');

// Project is "mine" if I'm the creator, the lead, the steward, OR I have any
// contribution assigned to me on it.
function isMyProject(p: { id: string; created_by?: string; project_lead_id?: string; project_steward_id?: string }): boolean {
  const me = currentUserId.value;
  if (!me) return false;
  if (p.created_by === me) return true;
  if (p.project_lead_id === me) return true;
  if (p.project_steward_id === me) return true;
  const contribs = projectsStore.projectContributions[p.id] ?? [];
  return contribs.some(c => {
    const aid = c.assigned_contributor_id
      ?? (c as { assigned_contributor?: string }).assigned_contributor;
    return aid === me;
  });
}

const myProjects = computed(() => projectsStore.projects.filter(isMyProject));

const myProjectsFiltered = computed(() => {
  const list = myShowArchived.value
    ? myProjects.value.filter(p => p.status === 'archived')
    : myProjects.value.filter(p => p.status !== 'archived');
  return [...list].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
});

const filteredProjects = computed(() => {
  const list = activeFilter.value === 'all'
    ? projectsStore.projects
    : projectsStore.projects.filter(p => p.status === activeFilter.value);
  return [...list].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
});

onMounted(async () => {
  await projectsStore.fetchProjects();
  loaded.value = true;
  loadNameMap();
  // Fetch contributions for each project in parallel
  await Promise.all(
    projectsStore.projects.map(p => projectsStore.fetchProjectContributions(p.id)),
  );
});

async function loadNameMap() {
  try {
    const { BACKEND_URL, authHeaders } = await import('src/lib/api/client');
    const resp = await fetch(`${BACKEND_URL}/api/v1/profiles/SharedProfile`, {
      headers: authHeaders(),
    });
    if (!resp.ok) return;
    const data = await resp.json();
    const map: Record<string, string> = {};
    for (const p of (data.profiles ?? []) as { id: string; data: Record<string, string> }[]) {
      const aid = p.data?.aid || p.id.replace('SharedProfile-', '');
      if (aid && p.data?.displayName) map[aid] = p.data.displayName;
    }
    nameMap.value = map;
  } catch {
    // silently fail — cards will show truncated AIDs
  }
}

async function handleCreateSubmit(data: { title: string; description: string }) {
  creating.value = true;
  createError.value = null;
  try {
    const project = await projectsStore.create({
      title: data.title,
      description: data.description,
      created_by: onboardingStore.profile.name || 'current-user',
    });
    showCreateDialog.value = false;
    $q.notify({ type: 'positive', message: 'Project created!' });
    router.push({ name: 'project-detail', params: { id: project.id } });
  } catch (e) {
    createError.value = e instanceof Error ? e.message : 'Failed to create project';
    $q.notify({ type: 'negative', message: 'Failed to create project' });
  } finally {
    creating.value = false;
  }
}
</script>

<style scoped lang="scss">
.projects-page {
  padding: 24px;
  max-width: 1080px;
  margin: 0 auto;
}

.projects-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 40px;
}

.projects-title {
  font-size: 1.5rem;
  font-weight: 600;
  margin: 0;
  color: var(--matou-foreground);
}

.projects-subtitle {
  color: var(--matou-muted-foreground);
  margin: 4px 0 0;
  font-size: 0.9rem;
}

.create-btn {
  background: transparent;
  color: var(--matou-teal, #0d9488);
  border: 2px solid var(--matou-teal, #0d9488);
  border-radius: 8px;
  padding: 8px 16px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;

  &:hover {
    background: var(--matou-teal, #0d9488);
    color: white;
  }
}

.my-projects-section,
.all-projects-section {
  margin-bottom: 32px;
}

.section-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 4px;
}

.section-title {
  font-size: 1.05rem;
  font-weight: 600;
  margin: 0;
  color: var(--matou-foreground);
}

.section-hint {
  color: var(--matou-muted-foreground);
  font-size: 0.8rem;
  margin: 0 0 12px;
}

.archived-toggle {
  background: transparent;
  border: 1px solid var(--matou-border);
  border-radius: 16px;
  padding: 4px 12px;
  font-size: 0.8rem;
  cursor: pointer;
  color: var(--matou-muted-foreground);

  &.active {
    background: var(--matou-secondary);
    color: var(--matou-foreground);
    border-color: var(--matou-accent);
  }
}

.empty-state-inline {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px;
  border: 1px dashed var(--matou-border);
  border-radius: var(--matou-radius-sm);
  color: var(--matou-muted-foreground);
  font-size: 0.9rem;

  .empty-icon {
    opacity: 0.4;
  }
}

.filter-row {
  display: flex;
  gap: 8px;
  margin-bottom: 20px;
  flex-wrap: wrap;
}

.filter-pill {
  background: transparent;
  border: 1px solid var(--matou-border);
  border-radius: 20px;
  padding: 6px 14px;
  font-size: 0.85rem;
  cursor: pointer;
  color: var(--matou-muted-foreground);
  transition: all 0.15s;

  &.active {
    background: var(--matou-primary);
    color: white;
    border-color: var(--matou-primary);
  }

  &:hover:not(.active) {
    border-color: var(--matou-accent);
    color: var(--matou-foreground);
  }
}

.loading-state,
.empty-state {
  text-align: center;
  padding: 60px 20px;
  color: var(--matou-muted-foreground);

  h3 {
    margin: 12px 0 8px;
    font-size: 1.1rem;
  }

  p {
    margin: 0;
    font-size: 0.9rem;
  }
}

.empty-icon {
  opacity: 0.3;
  margin-bottom: 16px;
}

.projects-list {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
</style>
