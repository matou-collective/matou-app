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
      return { success: false, error: `HTTP ${response.status}` };
    }
    return { success: true };
  } catch {
    return { success: false, error: 'Network error' };
  }
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
