/**
 * Composable for proposal endorsement actions.
 * Named useProposalEndorsements (not useEndorsements) to avoid conflict
 * with the KERI endorsements composable.
 */
import { ref } from 'vue';
import { useProposalsStore } from 'stores/proposals';
import type { Endorsement } from 'src/lib/api/proposals';

export function useProposalEndorsements(proposalId: string) {
  const store = useProposalsStore();
  const isEndorsing = ref(false);
  const endorseError = ref<string | null>(null);

  async function endorse(endorserId: string, comment?: string) {
    isEndorsing.value = true;
    endorseError.value = null;
    try {
      const endorsement: Endorsement = {
        endorser_id: endorserId,
        endorsed_at: new Date().toISOString(),
        comment,
      };
      await store.endorse(proposalId, endorsement);
    } catch (e) {
      endorseError.value = e instanceof Error ? e.message : 'Failed to endorse proposal';
      throw e;
    } finally {
      isEndorsing.value = false;
    }
  }

  async function loadEndorsements() {
    await store.fetchEndorsements(proposalId);
  }

  return {
    endorsements: store.endorsements,
    isEndorsing,
    endorseError,
    endorse,
    loadEndorsements,
  };
}
