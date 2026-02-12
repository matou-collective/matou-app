/**
 * Backend API Client
 * Communicates with the Go backend for sync and community operations
 */

import { getBackendUrl, getBackendUrlSync } from '../platform';

/**
 * Resolved backend URL. Call initBackendUrl() once at boot to populate.
 * After init, this holds the correct URL (dynamic Electron port or env var).
 */
export let BACKEND_URL = getBackendUrlSync();

/**
 * Initialize the backend URL (must be called once at app startup).
 * Resolves the Electron dynamic port via IPC; no-op in browser mode.
 */
export async function initBackendUrl(): Promise<void> {
  BACKEND_URL = await getBackendUrl();
}

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
  communityReadOnlySpace?: SpaceInfo;
  adminSpace?: SpaceInfo;
}

/**
 * Get user's spaces (private + community) and key availability
 */
export async function getUserSpaces(aid: string): Promise<UserSpacesResponse> {
  const response = await fetch(`${BACKEND_URL}/api/v1/spaces/user?aid=${encodeURIComponent(aid)}`);
  if (!response.ok) return {};
  return response.json();
}

export interface VerifyAccessResponse {
  hasAccess: boolean;
  spaceId?: string;
  canRead: boolean;
  canWrite: boolean;
}

/**
 * Verify community space access for a user
 */
export async function verifyCommunityAccess(aid: string): Promise<VerifyAccessResponse> {
  try {
    const response = await fetch(
      `${BACKEND_URL}/api/v1/spaces/community/verify-access?aid=${encodeURIComponent(aid)}`
    );
    if (!response.ok) return { hasAccess: false, canRead: false, canWrite: false };
    return response.json();
  } catch {
    return { hasAccess: false, canRead: false, canWrite: false };
  }
}

export interface JoinCommunityRequest {
  userAid: string;
  inviteKey: string;
  spaceId?: string;
  readOnlyInviteKey?: string;
  readOnlySpaceId?: string;
}

/**
 * Join the community space using an invite key
 */
export async function joinCommunity(req: JoinCommunityRequest): Promise<{ success: boolean; spaceId?: string; error?: string }> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/v1/spaces/community/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    return response.json();
  } catch {
    return { success: false, error: 'Network error' };
  }
}

// --- Backend Identity (per-user mode) ---

export interface SetBackendIdentityRequest {
  aid: string;
  mnemonic: string;
  orgAid?: string;
  communitySpaceId?: string;
  readOnlySpaceId?: string;
  adminSpaceId?: string;
  credentialSaid?: string;
  mode?: string;
}

export interface SetBackendIdentityResponse {
  success: boolean;
  peerId?: string;
  privateSpaceId?: string;
  error?: string;
}

export interface GetBackendIdentityResponse {
  configured: boolean;
  aid?: string;
  peerId?: string;
  orgAid?: string;
  communitySpaceId?: string;
  communityReadOnlySpaceId?: string;
  adminSpaceId?: string;
  privateSpaceId?: string;
}

/**
 * Set the backend identity (triggers peer key derivation, SDK restart, private space creation)
 */
export async function setBackendIdentity(
  request: SetBackendIdentityRequest,
): Promise<SetBackendIdentityResponse> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/v1/identity/set`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30000),
    });
    return response.json();
  } catch {
    return { success: false, error: 'Network error' };
  }
}

/**
 * Get the current backend identity status
 */
export async function getBackendIdentity(): Promise<GetBackendIdentityResponse> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/v1/identity`);
    if (!response.ok) return { configured: false };
    return response.json();
  } catch {
    return { configured: false };
  }
}

// --- Profiles & Types ---

export interface TypeDefinition {
  name: string;
  version: number;
  description: string;
  space: string;
  fields: FieldDef[];
  layouts: Record<string, { fields: string[] }>;
  permissions: { read: string; write: string };
}

export interface FieldDef {
  name: string;
  type: string;
  required?: boolean;
  readOnly?: boolean;
  default?: unknown;
  validation?: {
    minLength?: number;
    maxLength?: number;
    min?: number;
    max?: number;
    pattern?: string;
    enum?: string[];
  };
  uiHints?: {
    inputType?: string;
    displayFormat?: string;
    placeholder?: string;
    label?: string;
    section?: string;
  };
}

export interface ObjectPayload {
  id: string;
  type: string;
  ownerKey: string;
  data: Record<string, unknown>;
  timestamp: number;
  version: number;
}

/**
 * Get all type definitions from the backend
 */
export async function getTypeDefinitions(): Promise<TypeDefinition[]> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/v1/types`);
    if (!response.ok) return [];
    const data = await response.json();
    return data.types ?? [];
  } catch {
    return [];
  }
}

/**
 * Get a specific type definition by name
 */
export async function getTypeDefinition(name: string): Promise<TypeDefinition | null> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/v1/types/${encodeURIComponent(name)}`);
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

/**
 * Create or update a profile object
 */
export async function createOrUpdateProfile(
  typeName: string,
  data: Record<string, unknown>,
  options?: { id?: string; spaceId?: string }
): Promise<{ success: boolean; objectId?: string; error?: string }> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/v1/profiles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: typeName,
        id: options?.id,
        data,
        spaceId: options?.spaceId,
      }),
    });
    return response.json();
  } catch {
    return { success: false, error: 'Network error' };
  }
}

/**
 * Get profiles of a specific type
 */
export async function getProfiles(typeName: string): Promise<ObjectPayload[]> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/v1/profiles/${encodeURIComponent(typeName)}`);
    if (!response.ok) return [];
    const data = await response.json();
    return data.profiles ?? [];
  } catch {
    return [];
  }
}

/**
 * Get the current user's profiles (all types)
 */
export async function getMyProfiles(): Promise<Record<string, ObjectPayload[]>> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/v1/profiles/me`);
    if (!response.ok) return {};
    return response.json();
  } catch {
    return {};
  }
}

/**
 * Initialize member profiles (admin action after credential issuance)
 */
export async function initMemberProfiles(data: {
  memberAid: string;
  credentialSaid: string;
  role?: string;
  displayName?: string;
  email?: string;
  avatar?: string;
  bio?: string;
  interests?: string[];
  customInterests?: string;
  location?: string;
  indigenousCommunity?: string;
  joinReason?: string;
  facebookUrl?: string;
  linkedinUrl?: string;
  twitterUrl?: string;
  instagramUrl?: string;
}): Promise<{ success: boolean; objectId?: string; treeId?: string; error?: string }> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/v1/profiles/init-member`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return response.json();
  } catch {
    return { success: false, error: 'Network error' };
  }
}

/**
 * Upload a file (avatar) and return a content-addressed fileRef
 */
export async function uploadFile(file: File): Promise<{ fileRef?: string; error?: string }> {
  try {
    const formData = new FormData();
    formData.append('file', file);
    const response = await fetch(`${BACKEND_URL}/api/v1/files/upload`, {
      method: 'POST',
      body: formData,
    });
    const result = await response.json();
    return { fileRef: result.fileRef };
  } catch {
    return { error: 'Upload failed' };
  }
}

/**
 * Get the URL for a file by its fileRef
 */
export function getFileUrl(fileRef: string): string {
  return `${BACKEND_URL}/api/v1/files/${fileRef}`;
}

// --- Sync Status ---

export interface SpaceSyncStatusItem {
  spaceId?: string;
  hasObjectTree: boolean;
  objectCount: number;
  profileCount: number;
}

export interface SyncStatusResponse {
  community: SpaceSyncStatusItem;
  readOnly: SpaceSyncStatusItem;
  ready: boolean;
}

const emptySyncItem: SpaceSyncStatusItem = { hasObjectTree: false, objectCount: 0, profileCount: 0 };

/**
 * Check sync readiness for community and readonly spaces
 */
export async function getSyncStatus(): Promise<SyncStatusResponse> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/v1/spaces/sync-status`);
    if (!response.ok) return { community: { ...emptySyncItem }, readOnly: { ...emptySyncItem }, ready: false };
    return response.json();
  } catch {
    return { community: { ...emptySyncItem }, readOnly: { ...emptySyncItem }, ready: false };
  }
}

// --- Invites ---

export interface SendInviteEmailRequest {
  email: string;
  inviteCode: string;
  inviterName: string;
  inviteeName: string;
}

export interface SendInviteEmailResponse {
  success: boolean;
  error?: string;
}

/**
 * Send an invite code via email
 */
export async function sendInviteEmail(
  request: SendInviteEmailRequest,
): Promise<SendInviteEmailResponse> {
  const response = await fetch(`${BACKEND_URL}/api/v1/invites/send-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => null);
    return { success: false, error: data?.error ?? response.statusText };
  }

  return response.json();
}

/**
 * Booking confirmation email request
 */
export interface SendBookingEmailRequest {
  email: string;
  name: string;
  dateTimeUTC: string; // ISO 8601 format
  dateTimeNZT: string; // Human readable NZT time
  dateTimeLocal: string; // Human readable local time
}

/**
 * Booking confirmation email response
 */
export interface SendBookingEmailResponse {
  success: boolean;
  error?: string;
}

/**
 * Send a booking confirmation email with calendar invite
 */
export async function sendBookingEmail(
  request: SendBookingEmailRequest,
): Promise<SendBookingEmailResponse> {
  const response = await fetch(`${BACKEND_URL}/api/v1/booking/send-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => null);
    return { success: false, error: data?.error ?? response.statusText };
  }

  return response.json();
}

// --- Notifications ---

export interface NotificationResponse {
  success: boolean;
  skipped?: boolean;
  reason?: string;
  error?: string;
}

/**
 * Notify onboarding team about a new registration submission
 */
export async function sendRegistrationSubmittedNotification(request: {
  applicantName: string;
  applicantEmail?: string;
  applicantAid: string;
  bio?: string;
  location?: string;
  joinReason?: string;
  interests?: string[];
  customInterests?: string;
  submittedAt?: string;
}): Promise<NotificationResponse> {
  const response = await fetch(`${BACKEND_URL}/api/v1/notifications/registration-submitted`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => null);
    return { success: false, error: data?.error ?? response.statusText };
  }

  return response.json();
}

/**
 * Notify applicant that their registration has been approved
 */
export async function sendRegistrationApprovedNotification(request: {
  applicantEmail: string;
  applicantName: string;
}): Promise<NotificationResponse> {
  const response = await fetch(`${BACKEND_URL}/api/v1/notifications/registration-approved`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => null);
    return { success: false, error: data?.error ?? response.statusText };
  }

  return response.json();
}
