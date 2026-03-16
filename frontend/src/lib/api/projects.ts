/**
 * Projects API Client
 * CRUD operations for projects and linking to proposals.
 */
import { BACKEND_URL } from './client';
import { createLogger } from '../logging';

const log = createLogger('ProjectsAPI');

export interface ProjectImage {
  image_id: string;
  url: string;
  type: 'logo' | 'banner' | 'screenshot' | 'other';
  alt_text?: string;
  uploaded_at: string;
  uploaded_by: string;
}

export interface Project {
  id: string;
  title: string;
  description: string;
  status: 'created' | 'active' | 'completed' | 'archived';
  images?: ProjectImage[];
  proposal_ids?: string[];
  implementation_plan_ids?: string[];
  project_steward_id?: string;
  project_steward_name?: string;
  project_lead_id?: string;
  project_lead_name?: string;
  budget?: string;
  start_date?: string;
  end_date?: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface CreateProjectRequest {
  title: string;
  description: string;
  images?: ProjectImage[];
  created_by: string;
}

export interface UpdateProjectRequest {
  title?: string;
  description?: string;
  images?: ProjectImage[];
}

export async function createProject(req: CreateProjectRequest): Promise<Project> {
  log.info('Creating project: %s', req.title);
  const response = await fetch(`${BACKEND_URL}/api/v1/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to create project');
  }
  return response.json();
}

export async function listProjects(): Promise<{ projects: Project[]; total: number }> {
  const response = await fetch(`${BACKEND_URL}/api/v1/projects`);
  if (!response.ok) throw new Error('Failed to list projects');
  return response.json();
}

export async function getProject(id: string): Promise<Project> {
  const response = await fetch(`${BACKEND_URL}/api/v1/projects/${id}`);
  if (!response.ok) throw new Error('Project not found');
  return response.json();
}

export async function updateProject(id: string, req: UpdateProjectRequest): Promise<Project> {
  const response = await fetch(`${BACKEND_URL}/api/v1/projects/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!response.ok) throw new Error('Failed to update project');
  return response.json();
}

export async function deleteProject(id: string): Promise<void> {
  const response = await fetch(`${BACKEND_URL}/api/v1/projects/${id}`, { method: 'DELETE' });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to delete project');
  }
}

export async function linkProposalToProject(projectId: string, proposalId: string): Promise<Project> {
  const response = await fetch(`${BACKEND_URL}/api/v1/projects/${projectId}/link-proposal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ proposal_id: proposalId }),
  });
  if (!response.ok) throw new Error('Failed to link proposal');
  return response.json();
}

export async function assignProjectRole(
  projectId: string,
  role: 'lead' | 'steward',
  userId: string,
): Promise<Project> {
  log.info('Assigning %s role to %s on project %s', role, userId, projectId);
  const response = await fetch(`${BACKEND_URL}/api/v1/projects/${projectId}/assign-role`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role, user_id: userId }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(err.error || 'Failed to assign role');
  }
  return response.json();
}

export async function listProjectContributions(projectId: string): Promise<{ contributions: import('src/lib/api/contributions').Contribution[] }> {
  const response = await fetch(`${BACKEND_URL}/api/v1/projects/${projectId}/contributions`);
  if (!response.ok) throw new Error('Failed to list project contributions');
  return response.json();
}
