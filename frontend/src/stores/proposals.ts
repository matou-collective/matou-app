import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import {
  createProposal as apiCreate,
  listProposals as apiList,
  getProposal as apiGet,
  transitionProposal as apiTransition,
  addEndorsement as apiEndorse,
  listEndorsements as apiListEndorsements,
  updateProposal as apiUpdate,
  getProposalHistory as apiGetHistory,
  type Proposal,
  type CreateProposalRequest,
  type Endorsement,
  type ProposalHistoryEntry,
  type EndorsementResult,
} from 'src/lib/api/proposals';
import { createLogger } from 'src/lib/logging';

const log = createLogger('ProposalsStore');

export const useProposalsStore = defineStore('proposals', () => {
  const proposals = ref<Proposal[]>([]);
  const currentProposal = ref<Proposal | null>(null);
  const endorsements = ref<Endorsement[]>([]);
  const history = ref<ProposalHistoryEntry[]>([]);
  const isLoading = ref(false);
  const error = ref<string | null>(null);

  const draftProposals = computed(() => proposals.value.filter(p => p.status === 'draft'));
  const activeProposals = computed(() =>
    proposals.value.filter(p => !['draft', 'completed', 'rejected'].includes(p.status)),
  );

  async function fetchProposals() {
    isLoading.value = true;
    error.value = null;
    try {
      const result = await apiList();
      proposals.value = result.proposals || [];
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to fetch proposals';
      log.error('fetchProposals failed: %s', error.value);
    } finally {
      isLoading.value = false;
    }
  }

  async function fetchProposal(id: string) {
    isLoading.value = true;
    error.value = null;
    try {
      currentProposal.value = await apiGet(id);
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to fetch proposal';
      log.error('fetchProposal failed: %s', error.value);
    } finally {
      isLoading.value = false;
    }
  }

  async function create(req: CreateProposalRequest) {
    error.value = null;
    try {
      const proposal = await apiCreate(req);
      proposals.value.push(proposal);
      log.info('Proposal created: %s', proposal.id);
      return proposal;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to create proposal';
      log.error('create failed: %s', error.value);
      throw e;
    }
  }

  async function transition(id: string, status: string) {
    error.value = null;
    try {
      const updated = await apiTransition(id, status);
      const idx = proposals.value.findIndex(p => p.id === id);
      if (idx >= 0) proposals.value[idx] = updated;
      if (currentProposal.value?.id === id) currentProposal.value = updated;
      log.info('Proposal %s → %s', id, status);
      return updated;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Transition failed';
      log.error('transition failed: %s', error.value);
      throw e;
    }
  }

  async function update(
    id: string,
    fields: Parameters<typeof apiUpdate>[1],
  ): Promise<Proposal> {
    error.value = null;
    try {
      const updated = await apiUpdate(id, fields);
      const idx = proposals.value.findIndex(p => p.id === id);
      if (idx >= 0) proposals.value[idx] = updated;
      if (currentProposal.value?.id === id) currentProposal.value = updated;
      log.info('Proposal %s updated', id);
      return updated;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Update failed';
      log.error('update failed: %s', error.value);
      throw e;
    }
  }

  async function endorse(
    proposalId: string,
    endorsement: Endorsement,
  ): Promise<EndorsementResult | undefined> {
    error.value = null;
    try {
      const result = await apiEndorse(proposalId, endorsement);
      endorsements.value.push(endorsement);
      log.info('Endorsed proposal %s (threshold_met=%s)', proposalId, result.threshold_met);
      return result;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Endorsement failed';
      throw e;
    }
  }

  async function fetchEndorsements(proposalId: string) {
    try {
      const result = await apiListEndorsements(proposalId);
      endorsements.value = result.endorsements || [];
    } catch (e) {
      log.error('fetchEndorsements failed: %s', e);
    }
  }

  async function fetchHistory(proposalId: string) {
    try {
      const result = await apiGetHistory(proposalId);
      history.value = result.history || [];
    } catch (e) {
      log.error('fetchHistory failed: %s', e);
    }
  }

  return {
    proposals,
    currentProposal,
    endorsements,
    history,
    isLoading,
    error,
    draftProposals,
    activeProposals,
    fetchProposals,
    fetchProposal,
    create,
    transition,
    update,
    endorse,
    fetchEndorsements,
    fetchHistory,
  };
});
