import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import {
  createContribution as apiCreate,
  listContributions as apiList,
  getContribution as apiGet,
  transitionContribution as apiTransition,
  updateContribution as apiUpdate,
  type Contribution,
  type CreateContributionRequest,
  type UpdateContributionRequest,
} from 'src/lib/api/contributions';
import { createLogger } from 'src/lib/logging';

const log = createLogger('ContributionsStore');

export const useContributionsStore = defineStore('contributions', () => {
  const contributions = ref<Contribution[]>([]);
  const currentContribution = ref<Contribution | null>(null);
  const isLoading = ref(false);
  const error = ref<string | null>(null);

  const confirmedContributions = computed(() =>
    contributions.value.filter(c => c.status === 'confirmed'),
  );

  const assignedContributions = computed(() =>
    contributions.value.filter(c => c.status === 'assigned'),
  );

  async function fetchContributions(params?: { project_id?: string; status?: string }) {
    isLoading.value = true;
    error.value = null;
    try {
      const result = await apiList(params);
      contributions.value = result.contributions || [];
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to fetch contributions';
      log.error('fetchContributions: %s', error.value);
    } finally {
      isLoading.value = false;
    }
  }

  async function fetchContribution(id: string) {
    isLoading.value = true;
    error.value = null;
    try {
      currentContribution.value = await apiGet(id);
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to fetch contribution';
      log.error('fetchContribution: %s', error.value);
    } finally {
      isLoading.value = false;
    }
  }

  async function create(req: CreateContributionRequest) {
    error.value = null;
    try {
      const contribution = await apiCreate(req);
      contributions.value.push(contribution);
      log.info('Contribution created: %s', contribution.id);
      return contribution;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to create contribution';
      log.error('create failed: %s', error.value);
      throw e;
    }
  }

  async function transition(id: string, status: string) {
    error.value = null;
    try {
      const updated = await apiTransition(id, status);
      const idx = contributions.value.findIndex(c => c.id === id);
      if (idx >= 0) contributions.value[idx] = updated;
      if (currentContribution.value?.id === id) currentContribution.value = updated;
      log.info('Contribution %s → %s', id, status);
      return updated;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Transition failed';
      log.error('transition failed: %s', error.value);
      throw e;
    }
  }

  async function update(id: string, req: UpdateContributionRequest) {
    error.value = null;
    try {
      const updated = await apiUpdate(id, req);
      const idx = contributions.value.findIndex(c => c.id === id);
      if (idx >= 0) contributions.value[idx] = updated;
      if (currentContribution.value?.id === id) currentContribution.value = updated;
      return updated;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Update failed';
      log.error('update failed: %s', error.value);
      throw e;
    }
  }

  return {
    contributions,
    currentContribution,
    isLoading,
    error,
    confirmedContributions,
    assignedContributions,
    fetchContributions,
    fetchContribution,
    create,
    transition,
    update,
  };
});
