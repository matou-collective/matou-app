import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import {
  createProject as apiCreate,
  listProjects as apiList,
  getProject as apiGet,
  updateProject as apiUpdate,
  deleteProject as apiDelete,
  linkProposalToProject as apiLink,
  type Project,
  type CreateProjectRequest,
  type UpdateProjectRequest,
} from 'src/lib/api/projects';
import { createLogger } from 'src/lib/logging';

const log = createLogger('ProjectsStore');

export const useProjectsStore = defineStore('projects', () => {
  const projects = ref<Project[]>([]);
  const currentProject = ref<Project | null>(null);
  const isLoading = ref(false);
  const error = ref<string | null>(null);

  const activeProjects = computed(() => projects.value.filter(p => p.status === 'active'));

  async function fetchProjects() {
    isLoading.value = true;
    error.value = null;
    try {
      const result = await apiList();
      projects.value = result.projects || [];
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to fetch projects';
      log.error('fetchProjects: %s', error.value);
    } finally {
      isLoading.value = false;
    }
  }

  async function fetchProject(id: string) {
    isLoading.value = true;
    error.value = null;
    try {
      currentProject.value = await apiGet(id);
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to fetch project';
    } finally {
      isLoading.value = false;
    }
  }

  async function create(req: CreateProjectRequest) {
    error.value = null;
    try {
      const project = await apiCreate(req);
      projects.value.push(project);
      return project;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to create project';
      throw e;
    }
  }

  async function update(id: string, req: UpdateProjectRequest) {
    error.value = null;
    try {
      const updated = await apiUpdate(id, req);
      const idx = projects.value.findIndex(p => p.id === id);
      if (idx >= 0) projects.value[idx] = updated;
      if (currentProject.value?.id === id) currentProject.value = updated;
      return updated;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Update failed';
      throw e;
    }
  }

  async function remove(id: string) {
    error.value = null;
    try {
      await apiDelete(id);
      projects.value = projects.value.filter(p => p.id !== id);
      if (currentProject.value?.id === id) currentProject.value = null;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Delete failed';
      throw e;
    }
  }

  async function linkProposal(projectId: string, proposalId: string) {
    error.value = null;
    try {
      const updated = await apiLink(projectId, proposalId);
      const idx = projects.value.findIndex(p => p.id === projectId);
      if (idx >= 0) projects.value[idx] = updated;
      return updated;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Link failed';
      throw e;
    }
  }

  return {
    projects,
    currentProject,
    isLoading,
    error,
    activeProjects,
    fetchProjects,
    fetchProject,
    create,
    update,
    remove,
    linkProposal,
  };
});
