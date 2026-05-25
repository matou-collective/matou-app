/**
 * Composable for contribution UI logic.
 * Wraps the contributions store with component-level helpers.
 */
import { ref } from 'vue';
import { useContributionsStore } from 'stores/contributions';
import type { CreateContributionRequest, UpdateContributionRequest } from 'src/lib/api/contributions';

export function useContributions() {
  const store = useContributionsStore();
  const isSubmitting = ref(false);
  const submitError = ref<string | null>(null);

  async function createContribution(req: CreateContributionRequest) {
    isSubmitting.value = true;
    submitError.value = null;
    try {
      return await store.create(req);
    } catch (e) {
      submitError.value = e instanceof Error ? e.message : 'Failed to create contribution';
      throw e;
    } finally {
      isSubmitting.value = false;
    }
  }

  async function updateContribution(id: string, req: UpdateContributionRequest) {
    isSubmitting.value = true;
    submitError.value = null;
    try {
      return await store.update(id, req);
    } catch (e) {
      submitError.value = e instanceof Error ? e.message : 'Failed to update contribution';
      throw e;
    } finally {
      isSubmitting.value = false;
    }
  }

  async function submitForReview(id: string) {
    return store.transition(id, 'needs_review');
  }

  async function approveContribution(id: string) {
    return store.transition(id, 'approved');
  }

  async function confirmContribution(id: string) {
    return store.transition(id, 'confirmed');
  }

  return {
    ...store,
    isSubmitting,
    submitError,
    createContribution,
    updateContribution,
    submitForReview,
    approveContribution,
    confirmContribution,
  };
}
