/**
 * Composable for project UI logic.
 * Wraps the projects store with component-level helpers.
 */
import { ref } from 'vue';
import { useProjectsStore } from 'stores/projects';
import type { CreateProjectRequest, UpdateProjectRequest } from 'src/lib/api/projects';

export function useProjects() {
  const store = useProjectsStore();
  const isSubmitting = ref(false);
  const submitError = ref<string | null>(null);

  async function createProject(req: CreateProjectRequest) {
    isSubmitting.value = true;
    submitError.value = null;
    try {
      return await store.create(req);
    } catch (e) {
      submitError.value = e instanceof Error ? e.message : 'Failed to create project';
      throw e;
    } finally {
      isSubmitting.value = false;
    }
  }

  async function updateProject(id: string, req: UpdateProjectRequest) {
    isSubmitting.value = true;
    submitError.value = null;
    try {
      return await store.update(id, req);
    } catch (e) {
      submitError.value = e instanceof Error ? e.message : 'Failed to update project';
      throw e;
    } finally {
      isSubmitting.value = false;
    }
  }

  async function linkProposal(projectId: string, proposalId: string) {
    return store.linkProposal(projectId, proposalId);
  }

  return {
    ...store,
    isSubmitting,
    submitError,
    createProject,
    updateProject,
    linkProposal,
  };
}
