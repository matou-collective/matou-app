/**
 * Contributions API Client
 * CRUD operations and status transitions for contributions.
 */
import { BACKEND_URL } from './client';
import { createLogger } from '../logging';

const log = createLogger('ContributionsAPI');

export interface CreateContributionRequest {
  project_id: string;
  milestone_id?: string;
  title: string;
  description: string;
  contribution_type: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  objectives: string[];
  deliverables: string[];
  acceptance_criteria: string[];
  skill_requirements: string[];
  estimated_hours?: number;
  budget?: string;
  created_by: string;
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
  estimated_hours?: number;
  budget?: string;
  assigned_contributor_id?: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface UpdateContributionRequest {
  title?: string;
  description?: string;
  priority?: string;
  objectives?: string[];
  deliverables?: string[];
  acceptance_criteria?: string[];
  skill_requirements?: string[];
  estimated_hours?: number;
  budget?: string;
}

export async function createContribution(req: CreateContributionRequest): Promise<Contribution> {
  log.info('Creating contribution: %s', req.title);
  const response = await fetch(`${BACKEND_URL}/api/v1/contributions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
  const response = await fetch(`${BACKEND_URL}/api/v1/contributions${qs ? '?' + qs : ''}`);
  if (!response.ok) throw new Error('Failed to list contributions');
  return response.json();
}

export async function getContribution(id: string): Promise<Contribution> {
  const response = await fetch(`${BACKEND_URL}/api/v1/contributions/${id}`);
  if (!response.ok) throw new Error('Contribution not found');
  return response.json();
}

export async function transitionContribution(id: string, status: string): Promise<Contribution> {
  log.info('Transitioning contribution %s to %s', id, status);
  const response = await fetch(`${BACKEND_URL}/api/v1/contributions/${id}/transition`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to update contribution');
  }
  return response.json();
}
