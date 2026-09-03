/**
 * Push registration API client.
 *
 * Talks only to the embedded backend on localhost (docs/architecture/
 * 08-push-notifications.md §8): the backend forwards the token to the push
 * relay over a KERI-signed request. The recipient AID comes from the
 * authenticated session, never the body — the frontend only ever sends the FCM
 * token and platform. The global fetch wrapper (installBackendAuth) attaches
 * the Authorization header; authHeaders() adds the X-User-AID the backend
 * resolves the recipient from, exactly as every other client call does.
 */

import { BACKEND_URL, authHeaders } from './client';

export interface PushRegisterResult {
  success: boolean;
  error?: string;
  /** HTTP status when the backend answered, so callers can re-mint on 401. */
  status?: number;
}

/** Register (or refresh) this device's FCM token for the session AID. */
export async function registerPushToken(token: string): Promise<PushRegisterResult> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/v1/push/register`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ token, platform: 'android' }),
    });
    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}`, status: response.status };
    }
    return { success: true, status: response.status };
  } catch {
    return { success: false, error: 'Network error' };
  }
}

/**
 * The relay-session mint pair (docs/architecture/08-push-notifications.md §8,
 * refs #177 / #277). The Go backend cannot sign — the AID signing keys live in
 * signify-ts inside the WebView — so the WebView fetches a challenge, signs the
 * domain-separated login message with the AID key, and hands the signature back;
 * the backend exchanges it for a bearer token it keeps in memory and spends on
 * register/deregister/notify. The token is never returned to the WebView.
 */
export interface RelayChallengeResult {
  /** The AID the backend resolved from the session; what the signature must bind. */
  aid: string;
  /** Single-use nonce to sign as `matou-auth:<aid>:<nonce>`. */
  challenge: string;
  /** RFC3339 expiry of the challenge, when the relay supplies one. */
  expiresAt?: string;
}

/** Session mint result — only the expiry surfaces (the token stays backend-side). */
export interface RelaySessionResult {
  /** RFC3339 expiry of the minted session, when the relay supplies one. */
  expiresAt?: string;
}

/** GET /api/v1/push/relay-challenge — the nonce the WebView must sign. */
export async function getRelayChallenge(): Promise<RelayChallengeResult> {
  const response = await fetch(`${BACKEND_URL}/api/v1/push/relay-challenge`, {
    method: 'GET',
    headers: authHeaders(),
  });
  if (!response.ok) {
    throw new Error(`relay-challenge failed: HTTP ${response.status}`);
  }
  return (await response.json()) as RelayChallengeResult;
}

/**
 * POST /api/v1/push/relay-session — hand the signed challenge to the backend,
 * which exchanges it for a bearer token it keeps in memory. Returns the session
 * expiry so the caller knows when to re-mint.
 */
export async function postRelaySession(
  challenge: string,
  signature: string,
): Promise<RelaySessionResult> {
  const response = await fetch(`${BACKEND_URL}/api/v1/push/relay-session`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ challenge, signature }),
  });
  if (!response.ok) {
    throw new Error(`relay-session failed: HTTP ${response.status}`);
  }
  return (await response.json()) as RelaySessionResult;
}

/**
 * Deregister a device token (logout / identity switch). A stale token would
 * leak wakes to a device that no longer holds the AID (§7). The token is
 * optional — the backend also drops all tokens for the session AID when it is
 * omitted.
 */
export async function deregisterPushToken(token?: string): Promise<PushRegisterResult> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/v1/push/deregister`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(token ? { token } : {}),
    });
    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }
    return { success: true };
  } catch {
    return { success: false, error: 'Network error' };
  }
}
