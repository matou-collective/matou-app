/**
 * Backend API Client
 * Communicates with the Go backend for sync and community operations
 */

import { getBackendUrl, getBackendUrlSync, getApiToken, getApiTokenSync } from '../platform';
import { installBackendAuth as installBackendAuthCore, type AuthTarget } from './backend-auth';
import { useIdentityStore } from 'stores/identity';

/**
 * Resolved backend URL. Call initBackendUrl() once at boot to populate.
 * After init, this holds the correct URL (dynamic Electron port or env var).
 */
export let BACKEND_URL = getBackendUrlSync();

/**
 * Per-launch API token sent as `Authorization: Bearer <token>` on mutating
 * backend requests (the backend's TokenGuard rejects mutations without it).
 * Populated by initApiToken() at boot.
 */
export let API_TOKEN = getApiTokenSync();

/**
 * Initialize the backend URL (must be called once at app startup).
 * Resolves the Electron dynamic port via IPC; no-op in browser mode.
 */
export async function initBackendUrl(): Promise<void> {
  BACKEND_URL = await getBackendUrl();
}

/**
 * Initialize the API token (must be called once at app startup).
 * Resolves the Electron per-launch token via IPC; falls back to the dev
 * constant in browser mode.
 */
export async function initApiToken(): Promise<void> {
  API_TOKEN = await getApiToken();
}

/**
 * Install a global fetch wrapper that attaches `Authorization: Bearer <token>`
 * to every request targeting the backend. This centralises auth so the many
 * inline `fetch(${BACKEND_URL}/...)` call sites don't each need updating, and
 * leaves requests to other origins (KERIA, config server) untouched. An
 * explicit Authorization header on a call is preserved.
 *
 * The token is the signed-challenge session token when one is live, else the
 * per-launch API token; a 401 on a session-authenticated request re-runs the
 * signed-challenge login once and retries (see backend-auth.ts).
 */
export function installBackendAuth(): void {
  installBackendAuthCore(
    globalThis as unknown as AuthTarget,
    () => BACKEND_URL,
    () => API_TOKEN,
    {
      getSessionToken,
      refreshSession: async () => {
        try {
          const ok = await useIdentityStore().signInToBackend();
          return ok ? getSessionToken() : null;
        } catch {
          return null;
        }
      },
    },
  );
}

/**
 * Session token minted by the backend's signed-challenge login (issue #18).
 * When present it is sent as `Authorization: Bearer <token>` (by the fetch
 * wrapper above) so the backend can bind the request to a cryptographically
 * verified AID instead of trusting the bare X-User-AID header. Held in module
 * state (not persisted) — re-minted on each app start via
 * identityStore.signInToBackend(), and again on any 401.
 */
let sessionToken: string | null = null;
let sessionExpiresAt = 0;

/**
 * Treat a session as gone this long before its server-side expiry so a request
 * in flight at the boundary does not race the TTL.
 */
const SESSION_EXPIRY_SKEW_MS = 30_000;

/** Store the backend session token and its expiry (ISO string) after login. */
export function setSessionToken(token: string | null, expiresAt?: string | null): void {
  sessionToken = token;
  const parsed = expiresAt ? Date.parse(expiresAt) : NaN;
  sessionExpiresAt = token && Number.isFinite(parsed) ? parsed : 0;
}

/** Current backend session token if it exists and has not (nearly) expired. */
export function getSessionToken(): string | null {
  if (!sessionToken) return null;
  if (sessionExpiresAt && Date.now() >= sessionExpiresAt - SESSION_EXPIRY_SKEW_MS) {
    return null;
  }
  return sessionToken;
}

/**
 * Domain-separated message a client signs to prove control of `aid` for a
 * login challenge: "matou-auth:<aid>:<nonce>". Must match the backend's
 * auth.SignedMessage exactly.
 */
export function loginMessage(aid: string, challenge: string): string {
  return `matou-auth:${aid}:${challenge}`;
}

/**
 * Build request headers with JSON content type and the current user's AID for
 * RBAC-protected endpoints. Falls back gracefully if no identity is set. The
 * Authorization header is added by the fetch wrapper (installBackendAuth), not
 * here, so the session-refresh-on-401 path applies uniformly.
 *
 * When signed-auth enforcement is on, the backend derives the trusted AID from
 * the Bearer session and ignores X-User-AID; when off (default), X-User-AID is
 * still honored, so it is always sent for compatibility.
 */
export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...extra,
  };
  try {
    const identity = useIdentityStore();
    if (identity.aidPrefix) {
      headers['X-User-AID'] = identity.aidPrefix;
    }
  } catch {
    // Pinia not yet initialized — skip auth header
  }
  return headers;
}

export interface AuthChallengeResponse {
  challenge: string;
  expiresAt: string;
}

export interface AuthLoginResponse {
  token: string;
  expiresAt: string;
}

/**
 * Request a login challenge for an AID (step 1 of signed-challenge auth).
 */
export async function getAuthChallenge(aid: string): Promise<AuthChallengeResponse> {
  const response = await fetch(`${BACKEND_URL}/api/v1/auth/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ aid }),
  });
  if (!response.ok) {
    throw new Error(`auth challenge failed: ${response.status}`);
  }
  return response.json();
}

/**
 * Submit a signed challenge and receive a session token (step 2).
 * `signature` is a CESR-qualified non-indexed Ed25519 signature (Cigar qb64).
 */
export async function postAuthLogin(
  aid: string,
  challenge: string,
  signature: string,
): Promise<AuthLoginResponse> {
  const response = await fetch(`${BACKEND_URL}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ aid, challenge, signature }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error || `auth login failed: ${response.status}`);
  }
  return response.json();
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
  // RBAC (#17): sync/credentials requires the caller's AID; non-stewards may
  // only sync credentials issued to themselves.
  const response = await fetch(`${BACKEND_URL}/api/v1/sync/credentials`, {
    method: 'POST',
    headers: authHeaders({ 'X-User-AID': request.userAid }),
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
    // RBAC (#17): once an identity exists, only its owner (or an admin) may
    // re-set it. First-run (no identity) is allowed without the header.
    const response = await fetch(`${BACKEND_URL}/api/v1/identity/set`, {
      method: 'POST',
      headers: authHeaders({ 'X-User-AID': request.aid }),
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
  // Core marks a field backend handlers depend on structurally. The built-in
  // profile/notice/proposal UIs render core (and other well-known built-in)
  // fields themselves; schema-driven surfaces render the remaining, admin-added
  // custom fields.
  core?: boolean;
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
    // Filterable marks a field that list endpoints accept as a query-param
    // filter (schema-driven; see backend types.FieldDef.IsFilterable).
    filterable?: boolean;
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
    // RBAC (#17): profile writes are authorised per resource on the backend
    // (own profile, steward scope, or change_member_role for role changes).
    const response = await fetch(`${BACKEND_URL}/api/v1/profiles`, {
      method: 'POST',
      headers: authHeaders(),
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
 * Get profiles of a specific type, optionally filtered.
 *
 * `filters` keys must name fields the type marks filterable (uiHints.filterable);
 * the backend rejects a non-filterable field with 400. Array values match if the
 * stored array contains the value (case-insensitive). Empty/undefined values are
 * dropped so callers can pass a partially-filled filter object.
 */
export async function getProfiles(
  typeName: string,
  filters?: Record<string, string | undefined>,
): Promise<ObjectPayload[]> {
  try {
    let url = `${BACKEND_URL}/api/v1/profiles/${encodeURIComponent(typeName)}`;
    if (filters) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(filters)) {
        if (v !== undefined && v !== null && v !== '') params.set(k, v);
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }
    const response = await fetch(url);
    if (!response.ok) return [];
    const data = await response.json();
    return data.profiles ?? [];
  } catch {
    return [];
  }
}

/**
 * Get a single profile by type and id. Returns null when missing or unreachable.
 * Use this before a partial update: read existing data, merge your changes,
 * then POST the full payload via createOrUpdateProfile (which is full-replace).
 */
export async function getProfileById(typeName: string, id: string): Promise<ObjectPayload | null> {
  try {
    const response = await fetch(
      `${BACKEND_URL}/api/v1/profiles/${encodeURIComponent(typeName)}/${encodeURIComponent(id)}`,
    );
    if (!response.ok) return null;
    return await response.json() as ObjectPayload;
  } catch {
    return null;
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
  status?: string;
  displayName?: string;
  email?: string;
  avatar?: string;
  avatarData?: string;
  avatarMimeType?: string;
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
  githubUrl?: string;
  gitlabUrl?: string;
}): Promise<{ success: boolean; objectId?: string; treeId?: string; error?: string }> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/v1/profiles/init-member`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(data),
    });
    return response.json();
  } catch {
    return { success: false, error: 'Network error' };
  }
}

/**
 * Update a member's role.
 */
export async function updateMemberRole(
  memberAid: string,
  role: string,
): Promise<{ success: boolean; role?: string; error?: string }> {
  const res = await fetch(`${BACKEND_URL}/api/v1/members/${memberAid}/role`, {
    method: 'PUT',
    headers: authHeaders(),
    body: JSON.stringify({ role }),
  });
  return res.json();
}

/**
 * Grant the target steward Admin permission on both the community space and
 * the community-readonly space. Called by admin after promoting a member to
 * Community Steward so that the new steward's backend can:
 *   - write CommunityProfile records when approving new members (needs Writer)
 *   - create new invites for incoming members (needs Admin)
 * Only admin (the space owner) can call this — the SDK enforces ownership.
 */
export async function grantStewardAdmin(
  stewardAid: string,
): Promise<{ success: boolean; error?: string }> {
  // RBAC (#17): grant_steward_admin — Operations Steward / Founding Member.
  const res = await fetch(`${BACKEND_URL}/api/v1/spaces/grant-steward-admin`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ stewardAid }),
  });
  return res.json();
}

/**
 * Upload a file and return a content-addressed fileRef
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
    if (!response.ok) {
      return { error: result.error || `Upload failed (${response.status})` };
    }
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

// --- Notices (Activity) ---

export interface Notice {
  id: string;
  type: 'event' | 'update' | 'announcement';
  subtype?: string;
  title: string;
  summary: string;
  body?: string;
  links?: { label: string; url: string }[];
  images?: string[];
  attachments?: NoticeAttachment[];
  pinned?: boolean;
  issuerType: string;
  issuerId: string;
  issuerDisplayName?: string;
  audienceMode?: string;
  publishAt?: string;
  activeFrom?: string;
  activeUntil?: string;
  eventStart?: string;
  eventEnd?: string;
  timezone?: string;
  locationMode?: string;
  locationText?: string;
  locationUrl?: string;
  rsvpEnabled?: boolean;
  rsvpRequired?: boolean;
  rsvpCapacity?: number;
  ackRequired?: boolean;
  ackDueAt?: string;
  state: 'draft' | 'published' | 'archived';
  createdAt: string;
  createdBy: string;
  publishedAt?: string;
  archivedAt?: string;
  amendsNoticeId?: string;
  treeId?: string;
  // Schema-defined custom (non-core) fields, round-tripped through the notice's
  // data map by the backend (see anysync.NoticePayload.Data).
  data?: Record<string, unknown>;
}

export interface NoticeRSVP {
  id: string;
  noticeId: string;
  userId: string;
  status: 'going' | 'maybe' | 'not_going';
  updatedAt: string;
  treeId?: string;
}

export interface NoticeAck {
  id: string;
  noticeId: string;
  userId: string;
  ackAt: string;
  method: string;
  treeId?: string;
}

export interface NoticeSave {
  noticeId: string;
  userId: string;
  savedAt: string;
  pinned: boolean;
}

export interface NoticeAttachment {
  name: string;
  fileRef: string;
  mimeType: string;
  size: number;
}

export interface NoticeComment {
  id: string;
  noticeId: string;
  userId: string;
  userDisplayName: string;
  text: string;
  createdAt: string;
}

export interface NoticeReaction {
  id: string;
  noticeId: string;
  userId: string;
  emoji: string;
  active: boolean;
  createdAt: string;
}

export interface ReactionSummary {
  emoji: string;
  count: number;
  userReacted: boolean;
}

export interface CreateNoticeRequest {
  type: 'event' | 'update' | 'announcement';
  title: string;
  summary: string;
  body?: string;
  state?: 'draft' | 'published';
  eventStart?: string;
  eventEnd?: string;
  timezone?: string;
  locationMode?: string;
  locationText?: string;
  locationUrl?: string;
  rsvpEnabled?: boolean;
  rsvpRequired?: boolean;
  rsvpCapacity?: number;
  ackRequired?: boolean;
  ackDueAt?: string;
  activeFrom?: string;
  activeUntil?: string;
  images?: string[];
  attachments?: { name: string; fileRef: string; mimeType: string; size: number }[];
  links?: { label: string; url: string }[];
  // Schema-defined custom (non-core) fields. Sent flat at the top level of the
  // request body, where the backend's schema-driven extractor picks them up.
  data?: Record<string, unknown>;
}

export async function getNotices(params?: { view?: string; type?: string }): Promise<Notice[]> {
  try {
    const query = new URLSearchParams();
    if (params?.view) query.set('view', params.view);
    if (params?.type) query.set('type', params.type);
    const qs = query.toString();
    const response = await fetch(`${BACKEND_URL}/api/v1/notices${qs ? '?' + qs : ''}`);
    if (!response.ok) return [];
    const data = await response.json();
    return data.notices ?? [];
  } catch {
    return [];
  }
}

export async function getNotice(id: string): Promise<Notice | null> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/v1/notices/${encodeURIComponent(id)}`);
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

export async function createNotice(req: CreateNoticeRequest): Promise<{ success: boolean; noticeId?: string; error?: string }> {
  try {
    // Custom fields travel flat alongside the core fields — the backend's
    // schema extractor reads them from the top level of the request body.
    const { data, ...core } = req;
    const body = data ? { ...core, ...data } : core;
    const response = await fetch(`${BACKEND_URL}/api/v1/notices`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
    });
    return response.json();
  } catch {
    return { success: false, error: 'Network error' };
  }
}

export async function publishNotice(id: string): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/v1/notices/${encodeURIComponent(id)}/publish`, {
      method: 'POST',
      headers: authHeaders(),
    });
    return response.json();
  } catch {
    return { success: false, error: 'Network error' };
  }
}

export async function archiveNotice(id: string): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/v1/notices/${encodeURIComponent(id)}/archive`, {
      method: 'POST',
      headers: authHeaders(),
    });
    return response.json();
  } catch {
    return { success: false, error: 'Network error' };
  }
}

export async function submitRsvp(noticeId: string, status: 'going' | 'maybe' | 'not_going'): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/v1/notices/${encodeURIComponent(noticeId)}/rsvp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    return response.json();
  } catch {
    return { success: false, error: 'Network error' };
  }
}

export async function getRsvps(noticeId: string): Promise<{ rsvps: NoticeRSVP[]; counts: Record<string, number> }> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/v1/notices/${encodeURIComponent(noticeId)}/rsvp`);
    if (!response.ok) return { rsvps: [], counts: { going: 0, maybe: 0, not_going: 0 } };
    return response.json();
  } catch {
    return { rsvps: [], counts: { going: 0, maybe: 0, not_going: 0 } };
  }
}

export async function submitAck(noticeId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/v1/notices/${encodeURIComponent(noticeId)}/ack`, {
      method: 'POST',
    });
    return response.json();
  } catch {
    return { success: false, error: 'Network error' };
  }
}

export async function getAcks(noticeId: string): Promise<{ acks: NoticeAck[]; count: number }> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/v1/notices/${encodeURIComponent(noticeId)}/ack`);
    if (!response.ok) return { acks: [], count: 0 };
    return response.json();
  } catch {
    return { acks: [], count: 0 };
  }
}

export async function toggleNoticeSave(noticeId: string): Promise<{ success: boolean; pinned?: boolean; error?: string }> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/v1/notices/${encodeURIComponent(noticeId)}/save`, {
      method: 'POST',
    });
    return response.json();
  } catch {
    return { success: false, error: 'Network error' };
  }
}

export async function getSavedNotices(): Promise<NoticeSave[]> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/v1/notices/saved`);
    if (!response.ok) return [];
    const data = await response.json();
    return data.saves ?? [];
  } catch {
    return [];
  }
}

export async function getComments(noticeId: string): Promise<{ comments: NoticeComment[]; count: number }> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/v1/notices/${encodeURIComponent(noticeId)}/comments`);
    if (!response.ok) return { comments: [], count: 0 };
    return response.json();
  } catch {
    return { comments: [], count: 0 };
  }
}

export async function createComment(noticeId: string, text: string): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/v1/notices/${encodeURIComponent(noticeId)}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    return response.json();
  } catch {
    return { success: false, error: 'Network error' };
  }
}

export async function getReactions(noticeId: string): Promise<{ reactions: NoticeReaction[]; counts: Record<string, number> }> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/v1/notices/${encodeURIComponent(noticeId)}/reactions`);
    if (!response.ok) return { reactions: [], counts: {} };
    return response.json();
  } catch {
    return { reactions: [], counts: {} };
  }
}

export async function toggleReaction(noticeId: string, emoji: string): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/v1/notices/${encodeURIComponent(noticeId)}/reactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji }),
    });
    return response.json();
  } catch {
    return { success: false, error: 'Network error' };
  }
}

export async function toggleNoticePin(noticeId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/v1/notices/${encodeURIComponent(noticeId)}/pin`, {
      method: 'POST',
      headers: authHeaders(),
    });
    return response.json();
  } catch {
    return { success: false, error: 'Network error' };
  }
}

// --- Members ---

/**
 * Remove a member (soft-delete their profiles on the backend)
 */
export async function removeMember(
  memberAid: string,
  reason?: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/v1/members/${encodeURIComponent(memberAid)}`, {
      method: 'DELETE',
      headers: authHeaders(),
      body: JSON.stringify({ reason }),
    });
    if (!response.ok) {
      const data = await response.json();
      return { success: false, error: data.error || 'Failed to remove member' };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
