/**
 * Composable for proposal UI logic.
 * Wraps the proposals store with component-level helpers.
 */
import { ref } from 'vue';
import { useProposalsStore } from 'stores/proposals';
import type { CreateProposalRequest } from 'src/lib/api/proposals';

export function useProposals() {
  const store = useProposalsStore();
  const isSubmitting = ref(false);
  const submitError = ref<string | null>(null);

  async function submitProposal(req: CreateProposalRequest) {
    isSubmitting.value = true;
    submitError.value = null;
    try {
      return await store.create(req);
    } catch (e) {
      submitError.value = e instanceof Error ? e.message : 'Failed to submit proposal';
      throw e;
    } finally {
      isSubmitting.value = false;
    }
  }

  async function approveProposal(id: string) {
    return store.transition(id, 'approved');
  }

  async function rejectProposal(id: string) {
    return store.transition(id, 'rejected');
  }

  async function submitForReview(id: string) {
    return store.transition(id, 'submitted');
  }

  return {
    ...store,
    isSubmitting,
    submitError,
    submitProposal,
    approveProposal,
    rejectProposal,
    submitForReview,
  };
}
