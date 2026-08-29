import { BACKEND_URL, authHeaders } from './client';

export interface RoleDef {
  id: string;
  displayName: string;
  builtin: boolean;
}

export interface RolePolicy {
  version: number;
  updatedBy?: string;
  updatedAt?: string;
  roles: RoleDef[];
  grants: Record<string, string[]>;
}

export interface RolePolicyResponse {
  policy: RolePolicy;
  source: 'synced' | 'default';
  capabilities: Record<string, string[]>;
  callerCapabilities?: string[];
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
