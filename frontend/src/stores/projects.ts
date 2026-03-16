import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import {
  createProject as apiCreate,
  listProjects as apiList,
  getProject as apiGet,
  updateProject as apiUpdate,
  deleteProject as apiDelete,
  linkProposalToProject as apiLink,
  assignProjectRole as apiAssignRole,
  listProjectContributions as apiListProjectContributions,
  type Project,
  type CreateProjectRequest,
  type UpdateProjectRequest,
} from 'src/lib/api/projects';
import {
  getImplementationPlanForProject,
  signOffImplementationPlan,
  addMilestone as apiAddMilestone,
  createImplementationPlan as apiCreatePlan,
  type ImplementationPlan,
  type AddMilestoneRequest,
  type CreateImplementationPlanRequest,
} from 'src/lib/api/implementationPlans';
import type { Contribution } from 'src/lib/api/contributions';
import { createLogger } from 'src/lib/logging';

const log = createLogger('ProjectsStore');

export const useProjectsStore = defineStore('projects', () => {
  const projects = ref<Project[]>([]);
  const currentProject = ref<Project | null>(null);
  const isLoading = ref(false);
  const error = ref<string | null>(null);

  // Keyed by project ID
  const implementationPlans = ref<Record<string, ImplementationPlan>>({});
  // Keyed by project ID
  const projectContributions = ref<Record<string, Contribution[]>>({});

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

  async function fetchImplementationPlan(projectId: string) {
    error.value = null;
    try {
      const plan = await getImplementationPlanForProject(projectId);
      if (plan) {
        implementationPlans.value = { ...implementationPlans.value, [projectId]: plan };
      }
      return plan;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to fetch plan';
      log.error('fetchImplementationPlan: %s', error.value);
      return null;
    }
  }

  async function createPlan(projectId: string, req: CreateImplementationPlanRequest) {
    error.value = null;
    try {
      const plan = await apiCreatePlan(req);
      implementationPlans.value = { ...implementationPlans.value, [projectId]: plan };
      return plan;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to create plan';
      throw e;
    }
  }

  async function addMilestone(planId: string, projectId: string, req: AddMilestoneRequest) {
    error.value = null;
    try {
      const updated = await apiAddMilestone(planId, req);
      implementationPlans.value = { ...implementationPlans.value, [projectId]: updated };
      return updated;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to add milestone';
      throw e;
    }
  }

  async function signOffPlan(planId: string, projectId: string) {
    error.value = null;
    try {
      const updated = await signOffImplementationPlan(planId);
      implementationPlans.value = { ...implementationPlans.value, [projectId]: updated };
      return updated;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to sign off plan';
      throw e;
    }
  }

  async function assignRole(projectId: string, role: 'lead' | 'steward', userId: string) {
    error.value = null;
    try {
      const updated = await apiAssignRole(projectId, role, userId);
      const idx = projects.value.findIndex(p => p.id === projectId);
      if (idx >= 0) projects.value[idx] = updated;
      if (currentProject.value?.id === projectId) currentProject.value = updated;
      return updated;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Assign role failed';
      throw e;
    }
  }

  async function fetchProjectContributions(projectId: string) {
    error.value = null;
    try {
      const result = await apiListProjectContributions(projectId);
      projectContributions.value = {
        ...projectContributions.value,
        [projectId]: result.contributions || [],
      };
      return result.contributions || [];
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to fetch project contributions';
      log.error('fetchProjectContributions: %s', error.value);
      return [];
    }
  }

  return {
    projects,
    currentProject,
    isLoading,
    error,
    activeProjects,
    implementationPlans,
    projectContributions,
    fetchProjects,
    fetchProject,
    create,
    update,
    remove,
    linkProposal,
    fetchImplementationPlan,
    createPlan,
    addMilestone,
    signOffPlan,
    assignRole,
    fetchProjectContributions,
  };
});
