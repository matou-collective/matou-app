/**
 * Implementation Plans API Client
 * CRUD operations and milestone management for implementation plans.
 */
import { BACKEND_URL } from './client';
import { createLogger } from '../logging';

const log = createLogger('ImplementationPlansAPI');

export interface Milestone {
  milestone_id: string;
  implementation_plan_id: string;
  title: string;
  duration: string;
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to create implementation plan');
  }
  return response.json();
}

export async function listImplementationPlans(): Promise<{ implementation_plans: ImplementationPlan[]; total: number }> {
  const response = await fetch(`${BACKEND_URL}/api/v1/implementation-plans`);
  if (!response.ok) throw new Error('Failed to list implementation plans');
  return response.json();
}

export async function getImplementationPlan(id: string): Promise<ImplementationPlan> {
  const response = await fetch(`${BACKEND_URL}/api/v1/implementation-plans/${id}`);
  if (!response.ok) throw new Error('Implementation plan not found');
  return response.json();
}

export async function addMilestone(planId: string, req: AddMilestoneRequest): Promise<ImplementationPlan> {
  log.info('Adding milestone to plan %s', planId);
  const response = await fetch(`${BACKEND_URL}/api/v1/implementation-plans/${planId}/milestones`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to add milestone');
  }
  return response.json();
}
