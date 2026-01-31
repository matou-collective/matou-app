/**
 * Backend API Client
 * Communicates with the Go backend for sync and community operations
 */

export const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8080';

export interface SyncCredentialsRequest {
  userAid: string;
  credentials: unknown[];
}

export interface SyncCredentialsResponse {
  success: boolean;
  synced: number;
  failed: number;
  privateSpace?: string;
  communitySpace?: string;
  errors?: string[];
}

export interface CommunityMember {
  aid: string;
  name: string;
  role: string;
  joinedAt: string;
}

export interface OrgInfo {
  orgAid: string;
  name: string;
  description: string;
}

/**
 * Sync credentials to the backend
 */
export async function syncCredentials(
  request: SyncCredentialsRequest,
): Promise<SyncCredentialsResponse> {
  const response = await fetch(`${BACKEND_URL}/api/v1/sync/credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(`Sync failed: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Get community members from the backend
 */
export async function getCommunityMembers(): Promise<CommunityMember[]> {
  const response = await fetch(`${BACKEND_URL}/api/v1/community/members`);
  if (!response.ok) return [];
  const data = await response.json();
  return data.members ?? [];
}

/**
 * Get organization info from the backend
 */
export async function getOrgInfo(): Promise<OrgInfo> {
  const response = await fetch(`${BACKEND_URL}/api/v1/org`);
  if (!response.ok) throw new Error('Failed to fetch org info');
  return response.json();
}

/**
 * Check backend health
 */
export async function healthCheck(): Promise<boolean> {
  try {
    const response = await fetch(`${BACKEND_URL}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Get all credentials from the backend
 */
export async function getCredentials(): Promise<unknown[]> {
  const response = await fetch(`${BACKEND_URL}/api/v1/credentials`);
  if (!response.ok) return [];
  const data = await response.json();
  return data.credentials ?? [];
}

/**
 * Get trust graph from the backend
 */
export async function getTrustGraph(): Promise<unknown> {
  const response = await fetch(`${BACKEND_URL}/api/v1/trust/graph`);
  if (!response.ok) throw new Error('Failed to fetch trust graph');
  return response.json();
}

/**
 * Get trust score for a specific AID
 */
export async function getTrustScore(aid: string): Promise<{ score: number; depth: number }> {
  const response = await fetch(`${BACKEND_URL}/api/v1/trust/score/${encodeURIComponent(aid)}`);
  if (!response.ok) throw new Error('Failed to fetch trust score');
  return response.json();
}

export interface SpaceInfo {
  spaceId: string;
  spaceName: string;
  createdAt: string;
  keysAvailable: boolean;
}

export interface UserSpacesResponse {
  privateSpace?: SpaceInfo;
  communitySpace?: SpaceInfo;
}

/**
 * Get user's spaces (private + community) and key availability
 */
export async function getUserSpaces(aid: string): Promise<UserSpacesResponse> {
  const response = await fetch(`${BACKEND_URL}/api/v1/spaces/user?aid=${encodeURIComponent(aid)}`);
  if (!response.ok) return {};
  return response.json();
}
