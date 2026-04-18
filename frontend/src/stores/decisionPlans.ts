import { defineStore } from 'pinia';
import { ref } from 'vue';
import {
  createDecisionPlan,
  getDecisionPlan,
  listDecisionPlans,
  transitionDecisionPlan,
  addGovernanceAction,
  completeGovernanceAction,
  archiveGovernanceAction,
  castVote,
  resolveDecision,
  type DecisionPlan,
  type GovernanceAction,
  type CompleteActionRequest,
} from 'src/lib/api/decisionPlans';
import { createLogger } from 'src/lib/logging';

const log = createLogger('DecisionPlansStore');

export const useDecisionPlansStore = defineStore('decisionPlans', () => {
  const currentPlan = ref<DecisionPlan | null>(null);
  const plans = ref<DecisionPlan[]>([]);
  const isLoading = ref(false);
  const error = ref<string | null>(null);

  async function fetchForProposal(proposalId: string) {
    isLoading.value = true;
    error.value = null;
    try {
      const result = await listDecisionPlans();
      const allPlans = result.decision_plans || [];
      plans.value = allPlans;
      currentPlan.value = allPlans.find(p => p.proposal_id === proposalId) || null;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to fetch decision plans';
      log.error('fetchForProposal failed: %s', error.value);
    } finally {
      isLoading.value = false;
    }
  }

  async function fetch(id: string) {
    isLoading.value = true;
    try {
      currentPlan.value = await getDecisionPlan(id);
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to fetch decision plan';
    } finally {
      isLoading.value = false;
    }
  }

  async function create(
    req: Parameters<typeof createDecisionPlan>[0],
  ): Promise<DecisionPlan> {
    error.value = null;
    try {
      const plan = await createDecisionPlan(req);
      currentPlan.value = plan;
      plans.value.push(plan);
      log.info('Decision plan created: %s', plan.id);
      return plan;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to create decision plan';
      throw e;
    }
  }

  async function transition(id: string, status: string): Promise<DecisionPlan> {
    error.value = null;
    try {
      const updated = await transitionDecisionPlan(id, status);
      if (currentPlan.value?.id === id) currentPlan.value = updated;
      log.info('Decision plan %s → %s', id, status);
      return updated;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Transition failed';
      throw e;
    }
  }

  async function addAction(
    dpId: string,
    action: Parameters<typeof addGovernanceAction>[1],
  ): Promise<GovernanceAction> {
    error.value = null;
    try {
      const newAction = await addGovernanceAction(dpId, action);
      if (currentPlan.value?.id === dpId) {
        currentPlan.value = {
          ...currentPlan.value,
          governance_actions: [...(currentPlan.value.governance_actions || []), newAction],
        };
      }
      log.info('Governance action added: %s', newAction.id);
      return newAction;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to add action';
      throw e;
    }
  }

  async function completeAction(actionId: string, req: CompleteActionRequest): Promise<GovernanceAction> {
    error.value = null;
    try {
      const updated = await completeGovernanceAction(actionId, req);
      if (currentPlan.value) {
        const actions = currentPlan.value.governance_actions || [];
        const idx = actions.findIndex(a => a.id === actionId);
        if (idx >= 0) {
          actions[idx] = updated;
          currentPlan.value = { ...currentPlan.value, governance_actions: [...actions] };
        }
      }
      log.info('Governance action %s completed', actionId);
      return updated;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to complete action';
      throw e;
    }
  }

  async function archiveAction(actionId: string, req: Omit<CompleteActionRequest, 'outcome'>): Promise<GovernanceAction> {
    error.value = null;
    try {
      const updated = await archiveGovernanceAction(actionId, req);
      if (currentPlan.value) {
        const actions = currentPlan.value.governance_actions || [];
        const idx = actions.findIndex(a => a.id === actionId);
        if (idx >= 0) {
          actions[idx] = updated;
          currentPlan.value = { ...currentPlan.value, governance_actions: [...actions] };
        }
      }
      log.info('Governance action %s archived', actionId);
      return updated;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to archive action';
      throw e;
    }
  }

  function updateActionInPlan(actionId: string, updated: GovernanceAction) {
    if (currentPlan.value) {
      const actions = currentPlan.value.governance_actions || [];
      const idx = actions.findIndex(a => a.id === actionId);
      if (idx >= 0) {
        actions[idx] = updated;
        currentPlan.value = { ...currentPlan.value, governance_actions: [...actions] };
      }
    }
  }

  async function vote(actionId: string, decision: string, comment: string, voterName: string): Promise<GovernanceAction> {
    error.value = null;
    try {
      const updated = await castVote(actionId, decision, comment, voterName);
      updateActionInPlan(actionId, updated);
      log.info('Vote cast on %s: %s', actionId, decision);
      return updated;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to cast vote';
      throw e;
    }
  }

  async function resolve(actionId: string): Promise<GovernanceAction> {
    error.value = null;
    try {
      const updated = await resolveDecision(actionId);
      updateActionInPlan(actionId, updated);
      log.info('Decision %s resolved: %s', actionId, updated.outcome);
      return updated;
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Failed to resolve decision';
      throw e;
    }
  }

  return {
    currentPlan,
    plans,
    isLoading,
    error,
    fetchForProposal,
    fetch,
    create,
    transition,
    addAction,
    completeAction,
    archiveAction,
    vote,
    resolve,
  };
});
