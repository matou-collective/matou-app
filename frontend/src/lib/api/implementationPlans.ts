/**
 * Implementation Plans API Client
 * CRUD operations and milestone management for implementation plans.
 */
import { BACKEND_URL, authHeaders } from './client';
import { createLogger } from '../logging';

const log = createLogger('ImplementationPlansAPI');

export interface Milestone {
  milestone_id: string;
  implementation_plan_id: string;
  title: string;
  description?: string;
  duration: string;
  start_date?: string;
  end_date?: string;
  status?: 'planned' | 'in_progress' | 'completed' | 'delayed';
  success_criteria?: string[];
  dependencies?: string[];
  budget_allocation?: number;
  actual_cost?: number;
  contribution_ids?: string[];
}

export interface ImplementationPlan {
  id: string;
  project_id: string;
  total_budget: string;
  milestones: Milestone[];
  project_lead: string;
  project_steward_id: string;
  current_status: string;
  version?: string;
  status?: 'draft' | 'active' | 'archived';
  signed_off: boolean;
  signed_off_by?: string;
  signed_off_at?: string;
  created_by?: string;
  created_at: string;
  updated_at: string;
}

export interface CreateImplementationPlanRequest {
  project_id: string;
  total_budget: string;
  project_lead: string;
  project_steward_id: string;
}

export interface AddMilestoneRequest {
  title: string;
  duration: string;
  contribution_ids?: string[];
}

export async function createImplementationPlan(req: CreateImplementationPlanRequest): Promise<ImplementationPlan> {
  log.info('Creating implementation plan for project %s', req.project_id);
  const response = await fetch(`${BACKEND_URL}/api/v1/implementation-plans`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(req),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to create implementation plan');
  }
  return response.json();
}

export async function listImplementationPlans(): Promise<{ implementation_plans: ImplementationPlan[]; total: number }> {
  const response = await fetch(`${BACKEND_URL}/api/v1/implementation-plans`, {
    headers: authHeaders(),
  });
  if (!response.ok) throw new Error('Failed to list implementation plans');
  return response.json();
}

export async function getImplementationPlan(id: string): Promise<ImplementationPlan> {
  const response = await fetch(`${BACKEND_URL}/api/v1/implementation-plans/${id}`, {
    headers: authHeaders(),
  });
  if (!response.ok) throw new Error('Implementation plan not found');
  return response.json();
}

export async function addMilestone(planId: string, req: AddMilestoneRequest): Promise<ImplementationPlan> {
  log.info('Adding milestone to plan %s', planId);
  const response = await fetch(`${BACKEND_URL}/api/v1/implementation-plans/${planId}/milestones`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(req),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to add milestone');
  }
  return response.json();
}

/**
 * Fetch the implementation plan for a given project.
 * The list endpoint returns skinny plans (no hydrated contributions), so we
 * find the plan id via list and then fetch the detail endpoint to get the
 * milestone.contributions populated.
 */
export async function getImplementationPlanForProject(
  projectId: string,
): Promise<ImplementationPlan | null> {
  const result = await listImplementationPlans();
  const plans = result.implementation_plans || [];
  const skinny = plans.find(p => p.project_id === projectId);
  if (!skinny) return null;
  return getImplementationPlan(skinny.id);
}

export async function signOffImplementationPlan(planId: string): Promise<ImplementationPlan> {
  log.info('Signing off implementation plan %s', planId);
  const response = await fetch(
    `${BACKEND_URL}/api/v1/implementation-plans/${planId}/sign-off`,
    {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({}),
    },
  );
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to sign off plan');
  }
  return response.json();
}

export interface UpdateMilestoneRequest {
  title?: string;
  description?: string;
  duration?: string;
  start_date?: string;
  end_date?: string;
  success_criteria?: string[];
  status?: string;
}

export async function updateMilestone(id: string, req: UpdateMilestoneRequest): Promise<Milestone> {
  const response = await fetch(`${BACKEND_URL}/api/v1/milestones/${id}`, {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify(req),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to update milestone');
  }
  return response.json();
}

export async function archiveMilestone(id: string): Promise<void> {
  const response = await fetch(`${BACKEND_URL}/api/v1/milestones/${id}/archive`, {
    method: 'POST',
    headers: authHeaders(),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to archive milestone');
  }
}
