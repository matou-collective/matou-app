import { BACKEND_URL, authHeaders } from './client';

export type RoleScope = 'community' | 'project';

export interface RoleDef {
  id: string;
  displayName: string;
  builtin: boolean;
  // "community" (who you are) or "project" (what you hold on one project).
  // A legacy policy saved before the split may omit it; the backend fills it
  // in on read, so treat it as optional only for forward-compat safety.
  scope?: RoleScope;
}

export interface RolePolicy {
  version: number;
  updatedBy?: string;
  updatedAt?: string;
  roles: RoleDef[];
  grants: Record<string, string[]>;
}

// CapabilityMeta is the display/grouping/scope metadata for one capability,
// served alongside the policy. The UI groups columns into per-feature tables
// (#312) by `group`.
export interface CapabilityMeta {
  id: string;
  displayName: string;
  group: string;
  scope: RoleScope;
}

export interface RolePolicyResponse {
  policy: RolePolicy;
  source: 'synced' | 'default';
  capabilities: Record<string, string[]>;
  // Stable column order (all capabilities) and the project-scoped subset.
  // The UI uses capabilityOrder for column order and projectCapabilities to
  // decide which columns a project role may hold.
  capabilityOrder?: string[];
  projectCapabilities?: string[];
  callerCapabilities?: string[];
  // Per-capability display/group/scope metadata, in display order.
  capabilityMeta?: CapabilityMeta[];
}

export interface RolePolicyUpdate {
  version: number;
  roles: RoleDef[];
  grants: Record<string, string[]>;
}

export class RolePolicyConflictError extends Error {
  currentVersion: number;
  constructor(currentVersion: number) {
    super('Role policy was modified by someone else');
    this.name = 'RolePolicyConflictError';
    this.currentVersion = currentVersion;
  }
}

export async function fetchRolePolicy(): Promise<RolePolicyResponse> {
  const response = await fetch(`${BACKEND_URL}/api/v1/role-policy`, {
    headers: authHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Failed to load role policy: ${response.status}`);
  }
  return (await response.json()) as RolePolicyResponse;
}

export async function updateRolePolicy(update: RolePolicyUpdate): Promise<RolePolicy> {
  const response = await fetch(`${BACKEND_URL}/api/v1/role-policy`, {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify(update),
  });
  if (response.status === 409) {
    const body = (await response.json()) as { currentVersion?: number };
    throw new RolePolicyConflictError(body.currentVersion ?? -1);
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Failed to save role policy: ${response.status}`);
  }
  const body = (await response.json()) as { policy: RolePolicy };
  return body.policy;
}
