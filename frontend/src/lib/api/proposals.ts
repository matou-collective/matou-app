/**
 * Proposals API Client
 * CRUD operations, status transitions, and endorsements for proposals.
 */
import { BACKEND_URL, authHeaders } from './client';
import { createLogger } from '../logging';
import { useIdentityStore } from 'stores/identity';

const log = createLogger('ProposalsAPI');

export interface CreateProposalRequest {
  proposer_id: string;
  title: string;
  type: string[];
  priority: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  problem_statement: string;
  solution: string;
  expected_outcomes: string[];
  estimated_budget: string;
  timeline: string;
  project_plan?: { title: string; description: string; duration: string }[];
  attachments?: { name: string; url: string }[];
}

export interface Proposal {
  id: string;
  proposer_id: string;
  title: string;
  type: string[];
  priority: string;
  description: string;
  problem_statement: string;
  solution: string;
  expected_outcomes: string[];
  estimated_budget: string;
  timeline: string;
  status: string;
  proposal_lead_id?: string;
  proposal_steward_id?: string;
  endorsement_threshold: number;
  lead_contribution_id?: string;
  steward_contribution_id?: string;
  attachments?: { name: string; url: string }[];
  created_at: string;
  updated_at: string;
}

export interface Endorsement {
  endorser_id: string;
  endorsed_at: string;
  comment?: string;
}

export interface CommentAttachment {
  file_ref: string;
  file_name: string;
  content_type: string;
  size?: number;
  category?: string;
  uploaded_by?: string;
  uploaded_at?: string;
}

export interface ProposalComment {
  id: string;
  proposal_id: string;
  user_id: string;
  user_name: string;
  text: string;
  created_at: string;
  kind?: 'user' | 'endorsement' | 'completion' | 'vote';
  subtitle?: string;
  outcome?: string;
  attachments?: CommentAttachment[];
  links?: string[];
}

export interface ProposalHistoryEntry {
  id: string;
  proposal_id: string;
  user_id: string;
  action: string;
  changes?: { field: string; old_value: string; new_value: string }[];
  created_at: string;
}

export interface EndorsementResult {
  endorsement: Endorsement;
  threshold_met: boolean;
  new_status?: string;
}

export async function createProposal(req: CreateProposalRequest): Promise<Proposal> {
  log.info('Creating proposal: %s', req.title);
  const response = await fetch(`${BACKEND_URL}/api/v1/proposals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(req),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to create proposal');
  }
  return response.json();
}

export async function listProposals(): Promise<{ proposals: Proposal[]; total: number }> {
  const response = await fetch(`${BACKEND_URL}/api/v1/proposals`, {
    headers: authHeaders(),
  });
  if (!response.ok) throw new Error('Failed to list proposals');
  return response.json();
}

export async function getProposal(id: string): Promise<Proposal> {
  const response = await fetch(`${BACKEND_URL}/api/v1/proposals/${id}`, {
    headers: authHeaders(),
  });
  if (!response.ok) throw new Error('Proposal not found');
  return response.json();
}

export async function transitionProposal(id: string, status: string): Promise<Proposal> {
  log.info('Transitioning proposal %s to %s', id, status);
  const identityStore = useIdentityStore();
  const userName = identityStore.currentAID?.name;
  const response = await fetch(`${BACKEND_URL}/api/v1/proposals/${id}/transition`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(userName ? { 'X-User-Name': userName } : {}),
    },
    body: JSON.stringify({ status }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Transition failed');
  }
  return response.json();
}

export async function updateProposal(
  id: string,
  fields: Partial<Omit<Proposal, 'id' | 'status' | 'created_at' | 'updated_at'>>,
): Promise<Proposal> {
  log.info('Updating proposal %s', id);
  const identityStore = useIdentityStore();
  const userName = identityStore.currentAID?.name;
  const response = await fetch(`${BACKEND_URL}/api/v1/proposals/${id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(userName ? { 'X-User-Name': userName } : {}),
    },
    body: JSON.stringify(fields),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to update proposal');
  }
  return response.json();
}

export async function getProposalHistory(
  id: string,
): Promise<{ history: ProposalHistoryEntry[]; total: number }> {
  const response = await fetch(`${BACKEND_URL}/api/v1/proposals/${id}/history`, {
    headers: authHeaders(),
  });
  if (!response.ok) throw new Error('Failed to fetch history');
  return response.json();
}

export async function addEndorsement(
  proposalId: string,
  endorsement: Endorsement,
): Promise<EndorsementResult> {
  log.info('Endorsing proposal %s', proposalId);
  const response = await fetch(`${BACKEND_URL}/api/v1/proposals/${proposalId}/endorsements`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(endorsement),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to endorse');
  }
  return response.json();
}

export async function listEndorsements(
  proposalId: string,
): Promise<{ endorsements: Endorsement[]; total: number }> {
  const response = await fetch(`${BACKEND_URL}/api/v1/proposals/${proposalId}/endorsements`, {
    headers: authHeaders(),
  });
  if (!response.ok) throw new Error('Failed to list endorsements');
  return response.json();
}

export async function addProposalComment(
  proposalId: string,
  userId: string,
  userName: string,
  text: string,
): Promise<ProposalComment> {
  log.info('Adding comment to proposal %s', proposalId);
  const response = await fetch(`${BACKEND_URL}/api/v1/proposals/${proposalId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ user_id: userId, user_name: userName, text }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to add comment');
  }
  return response.json();
}

export async function listProposalComments(
  proposalId: string,
): Promise<{ comments: ProposalComment[]; total: number }> {
  const response = await fetch(`${BACKEND_URL}/api/v1/proposals/${proposalId}/comments`, {
    headers: authHeaders(),
  });
  if (!response.ok) throw new Error('Failed to list comments');
  return response.json();
}
