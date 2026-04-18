/**
 * Decision Plans API Client
 * CRUD operations, transitions, and governance actions for decision plans.
 */
import { BACKEND_URL, authHeaders } from './client';
import { createLogger } from '../logging';

const log = createLogger('DecisionPlansAPI');

export interface GovernanceAction {
  id: string;
  decision_plan_id: string;
  house: 'elders_council' | 'community_reps' | 'contributors';
  action_type: 'discussion' | 'decision' | 'meeting';
  title: string;
  description: string;
  meeting_date?: string;
  meeting_time?: string;
  meeting_location?: string;
  linked_action_id?: string;
  voting_end_date?: string;
  voting_end_time?: string;
  status: 'planned' | 'completed' | 'archived';
  outcome?: 'no_veto' | 'veto' | 'approved' | 'rejected';
  votes?: { voter_id: string; voter_name: string; decision: string; comment?: string; voted_at: string }[];
  completion_notes?: string;
  completion_files?: { file_ref: string; file_name: string; content_type: string; size?: number; category: string; uploaded_by: string; uploaded_at: string }[];
  completion_links?: string[];
  completed_by?: string;
  created_at: string;
  updated_at: string;
}

export interface DecisionPlan {
  id: string;
  proposal_id: string;
  title: string;
  description: string;
  status: 'drafted' | 'submitted' | 'signed_off';
  objectives: string[];
  expected_outcomes: string[];
  governance_actions: GovernanceAction[];
  proposal_lead_id: string;
  proposal_steward_id: string;
  created_at: string;
  updated_at: string;
}

export async function createDecisionPlan(
  req: Omit<DecisionPlan, 'id' | 'status' | 'governance_actions' | 'created_at' | 'updated_at'>,
): Promise<DecisionPlan> {
  log.info('Creating decision plan for proposal %s', req.proposal_id);
  const response = await fetch(`${BACKEND_URL}/api/v1/decision-plans`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!response.ok) throw new Error('Failed to create decision plan');
  return response.json();
}

export async function listDecisionPlans(): Promise<{ decision_plans: DecisionPlan[]; total: number }> {
  const response = await fetch(`${BACKEND_URL}/api/v1/decision-plans`);
  if (!response.ok) throw new Error('Failed to list decision plans');
  return response.json();
}

export async function getDecisionPlan(id: string): Promise<DecisionPlan> {
  const response = await fetch(`${BACKEND_URL}/api/v1/decision-plans/${id}`);
  if (!response.ok) throw new Error('Decision plan not found');
  return response.json();
}

export async function transitionDecisionPlan(id: string, status: string): Promise<DecisionPlan> {
  const response = await fetch(`${BACKEND_URL}/api/v1/decision-plans/${id}/transition`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  if (!response.ok) throw new Error('Transition failed');
  return response.json();
}

export async function addGovernanceAction(
  dpId: string,
  action: {
    house: string;
    action_type: string;
    description: string;
    meeting_date?: string;
    meeting_time?: string;
    meeting_location?: string;
    linked_action_id?: string;
  },
): Promise<GovernanceAction> {
  const response = await fetch(`${BACKEND_URL}/api/v1/decision-plans/${dpId}/actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(action),
  });
  if (!response.ok) throw new Error('Failed to add governance action');
  return response.json();
}

export interface CompleteActionRequest {
  outcome?: string;
  completion_notes: string;
  completion_files?: { file_ref: string; file_name: string; content_type: string; size?: number; category: string; uploaded_by: string; uploaded_at: string }[];
  completion_links?: string[];
  voter_name?: string;
}

export async function completeGovernanceAction(actionId: string, req: CompleteActionRequest): Promise<GovernanceAction> {
  const response = await fetch(`${BACKEND_URL}/api/v1/governance-actions/${actionId}/complete`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!response.ok) throw new Error('Failed to complete action');
  return response.json();
}

export async function archiveGovernanceAction(actionId: string, req: Omit<CompleteActionRequest, 'outcome'>): Promise<GovernanceAction> {
  const response = await fetch(`${BACKEND_URL}/api/v1/governance-actions/${actionId}/archive`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!response.ok) throw new Error('Failed to archive action');
  return response.json();
}

export async function castVote(actionId: string, decision: string, comment: string, voterName: string): Promise<GovernanceAction> {
  const response = await fetch(`${BACKEND_URL}/api/v1/governance-actions/${actionId}/vote`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision, comment, voter_name: voterName }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'Failed to cast vote' }));
    throw new Error(err.error || 'Failed to cast vote');
  }
  return response.json();
}

export async function resolveDecision(actionId: string): Promise<GovernanceAction> {
  const response = await fetch(`${BACKEND_URL}/api/v1/governance-actions/${actionId}/resolve`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'Failed to resolve decision' }));
    throw new Error(err.error || 'Failed to resolve decision');
  }
  return response.json();
}
