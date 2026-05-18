/**
 * Contributions API Client
 * CRUD operations and status transitions for contributions.
 */
import { BACKEND_URL, authHeaders } from './client';
import { createLogger } from '../logging';
import type {
  ShareContributionRequest,
  OfferContributionRequest,
  RegisterInterestRequest,
  SubmitEvidenceRequest,
  SubmitReviewRequest,
} from 'src/types/projects';

const log = createLogger('ContributionsAPI');

export interface CreateContributionRequest {
  project_id: string;
  milestone_id?: string;
  title: string;
  description: string;
  contribution_type: string;
  priority?: string;
  objectives: string[];
  deliverables: string[];
  acceptance_criteria: string[];
  skill_requirements: string[];
  estimated_duration?: number;
  deadline?: string;
  budget?: string;
  created_by: string;
  assigned_contributor_id?: string;
}

export interface Contribution {
  id: string;
  project_id: string;
  milestone_id?: string;
  title: string;
  description: string;
  contribution_type: string;
  priority: string;
  status: string;
  objectives: string[];
  deliverables: string[];
  acceptance_criteria: string[];
  skill_requirements: string[];
  estimated_duration?: number;
  deadline?: string;
  budget?: string;
  assigned_contributor_id?: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  comment_count?: number;
}

export interface UpdateContributionRequest {
  title?: string;
  description?: string;
  objectives?: string[];
  deliverables?: string[];
  acceptance_criteria?: string[];
  skill_requirements?: string[];
  estimated_duration?: number;
  deadline?: string;
  budget?: string;
  assigned_contributor_id?: string;
}

export async function createContribution(req: CreateContributionRequest): Promise<Contribution> {
  log.info('Creating contribution: %s', req.title);
  const response = await fetch(`${BACKEND_URL}/api/v1/contributions`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(req),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to create contribution');
  }
  return response.json();
}

export async function listContributions(params?: { project_id?: string; status?: string }): Promise<{ contributions: Contribution[]; total: number }> {
  const query = new URLSearchParams();
  if (params?.project_id) query.set('project_id', params.project_id);
  if (params?.status) query.set('status', params.status);
  const qs = query.toString();
  const response = await fetch(`${BACKEND_URL}/api/v1/contributions${qs ? '?' + qs : ''}`, {
    headers: authHeaders(),
  });
  if (!response.ok) throw new Error('Failed to list contributions');
  return response.json();
}

export async function getContribution(id: string): Promise<Contribution> {
  const response = await fetch(`${BACKEND_URL}/api/v1/contributions/${id}`, {
    headers: authHeaders(),
  });
  if (!response.ok) throw new Error('Contribution not found');
  return response.json();
}

export async function transitionContribution(id: string, status: string): Promise<Contribution> {
  log.info('Transitioning contribution %s to %s', id, status);
  const response = await fetch(`${BACKEND_URL}/api/v1/contributions/${id}/transition`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ status }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Transition failed');
  }
  return response.json();
}

export async function updateContribution(id: string, req: UpdateContributionRequest): Promise<Contribution> {
  log.info('Updating contribution %s', id);
  const response = await fetch(`${BACKEND_URL}/api/v1/contributions/${id}`, {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify(req),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to update contribution');
  }
  return response.json();
}

export async function confirmContribution(id: string): Promise<Contribution> {
  log.info('Confirming contribution %s', id);
  const response = await fetch(`${BACKEND_URL}/api/v1/contributions/${id}/confirm`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({}),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to confirm contribution');
  }
  return response.json();
}

export async function shareContribution(
  id: string,
  req: ShareContributionRequest,
): Promise<Contribution> {
  log.info('Sharing contribution %s', id);
  const response = await fetch(`${BACKEND_URL}/api/v1/contributions/${id}/share`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(req),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to share contribution');
  }
  return response.json();
}

export async function offerContribution(
  id: string,
  req: OfferContributionRequest,
): Promise<Contribution> {
  log.info('Offering contribution %s to %s', id, req.offered_to);
  const response = await fetch(`${BACKEND_URL}/api/v1/contributions/${id}/offer`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(req),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to offer contribution');
  }
  return response.json();
}

export async function acceptOffer(id: string): Promise<Contribution> {
  log.info('Accepting offer for contribution %s', id);
  const response = await fetch(`${BACKEND_URL}/api/v1/contributions/${id}/accept-offer`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({}),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to accept offer');
  }
  return response.json();
}

export async function registerInterest(
  id: string,
  req: RegisterInterestRequest,
): Promise<Contribution> {
  log.info('Registering interest in contribution %s', id);
  const response = await fetch(`${BACKEND_URL}/api/v1/contributions/${id}/register`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(req),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to register interest');
  }
  return response.json();
}

export async function submitEvidence(
  id: string,
  req: SubmitEvidenceRequest,
): Promise<Contribution> {
  log.info('Submitting evidence for contribution %s', id);
  const response = await fetch(`${BACKEND_URL}/api/v1/contributions/${id}/submit-evidence`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(req),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to submit evidence');
  }
  return response.json();
}

export async function submitReview(
  id: string,
  req: SubmitReviewRequest,
): Promise<Contribution> {
  log.info('Reviewing contribution %s with outcome %s', id, req.outcome);
  const response = await fetch(`${BACKEND_URL}/api/v1/contributions/${id}/review`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(req),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to submit review');
  }
  return response.json();
}

export async function signOffContribution(id: string): Promise<Contribution> {
  log.info('Signing off contribution %s', id);
  const response = await fetch(`${BACKEND_URL}/api/v1/contributions/${id}/sign-off`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({}),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to sign off contribution');
  }
  return response.json();
}

export async function createChildContribution(
  parentId: string,
  req: CreateContributionRequest,
): Promise<{ child: Contribution; parent: Contribution }> {
  log.info('Creating sub-contribution for parent %s', parentId);
  // The backend creates the child with parent_contribution set and
  // links it back on the parent's child_contributions list.
  const response = await fetch(`${BACKEND_URL}/api/v1/contributions`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ ...req, parent_contribution: parentId }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to create sub-contribution');
  }
  const child = await (response.json() as Promise<Contribution>);
  // Fetch updated parent
  const parentResp = await fetch(`${BACKEND_URL}/api/v1/contributions/${parentId}`, {
    headers: authHeaders(),
  });
  const parent = parentResp.ok
    ? await (parentResp.json() as Promise<Contribution>)
    : ({ id: parentId } as Contribution);
  return { child, parent };
}

export async function approveSub(id: string): Promise<Contribution> {
  log.info('Approving sub-contribution %s', id);
  const response = await fetch(`${BACKEND_URL}/api/v1/contributions/${id}/approve-sub`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({}),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to approve sub-contribution');
  }
  return response.json();
}

export async function archiveContribution(id: string): Promise<void> {
  log.info('Archiving contribution %s', id);
  const response = await fetch(`${BACKEND_URL}/api/v1/contributions/${id}/archive`, {
    method: 'POST',
    headers: authHeaders(),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to archive contribution');
  }
}

export async function unassignContribution(id: string): Promise<Contribution> {
  log.info('Unassigning contribution %s', id);
  const response = await fetch(`${BACKEND_URL}/api/v1/contributions/${id}/unassign`, {
    method: 'POST',
    headers: authHeaders(),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to unassign contribution');
  }
  return response.json();
}

export interface ContributionComment {
  id: string;
  contribution_id: string;
  user_id: string;
  user_name: string;
  text: string;
  created_at: string;
}

export async function addContributionComment(
  contributionId: string,
  userId: string,
  userName: string,
  text: string,
): Promise<ContributionComment> {
  const response = await fetch(`${BACKEND_URL}/api/v1/contributions/${contributionId}/comments`, {
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

export async function listContributionComments(
  contributionId: string,
): Promise<{ comments: ContributionComment[]; total: number }> {
  const response = await fetch(`${BACKEND_URL}/api/v1/contributions/${contributionId}/comments`, {
    headers: authHeaders(),
  });
  if (!response.ok) throw new Error('Failed to list comments');
  return response.json();
}
