/**
 * usePairing — a thin client over the backend's linked-device pairing routes
 * (`/api/v1/pairing/*`, spec §2, backend slice #471). The Go backend owns the
 * protocol on both platforms; the frontend only creates a session, polls its
 * state, approves or cancels, and — on the fresh side — fetches the identity
 * once it has arrived.
 *
 * All requests go through the app's authenticated fetch wrapper
 * (installBackendAuth) via BACKEND_URL + authHeaders(); the GET …/identity route
 * additionally demands the bearer token, which the wrapper already attaches.
 */

import { BACKEND_URL, authHeaders } from 'src/lib/api/client';

/** Session lifecycle state (mirrors internal/pairing.State). */
export type PairingState =
  | 'created'
  | 'hello-received'
  | 'acked'
  | 'approved'
  | 'rejected'
  | 'identity-sent'
  | 'identity-received'
  | 'done'
  | 'cancelled'
  | 'expired'
  | 'failed';

/** Direction (or refusal) decided after the scanner's hello (spec §1 table). */
export type PairingOutcome =
  | 'phone-to-desktop'
  | 'desktop-to-phone'
  | 'neither'
  | 'already-linked'
  | 'conflict'
  | '';

export interface CreateSessionResult {
  sessionId: string;
  /** `matou://pair?...` payload to render as a QR locally. */
  qrPayload: string;
  /** RFC3339 expiry of the session. */
  expiresAt: string;
}

export interface SessionStatus {
  state: PairingState;
  outcome: PairingOutcome;
  /** 6-character SAS code — a STRING that may start with 0; never parse it. */
  code: string;
  peerDeviceName: string;
  error: string;
}

export interface PairingIdentity {
  mnemonic: string;
  aid: string;
  orgAid?: string;
  adminAid?: string;
  configServerUrl?: string;
}

/** Raised when a pairing request fails; carries the HTTP status and body. */
export class PairingError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly aid?: string,
  ) {
    super(message);
    this.name = 'PairingError';
  }
}

async function pairingError(response: Response): Promise<PairingError> {
  const body = (await response.json().catch(() => null)) as
    | { error?: string; message?: string; aid?: string }
    | null;
  const code = body?.error;
  const message = body?.message || code || `pairing request failed: HTTP ${response.status}`;
  return new PairingError(message, response.status, code, body?.aid);
}

export function usePairing() {
  /** POST /api/v1/pairing/sessions — displayer creates a session + QR. */
  async function createSession(deviceName?: string): Promise<CreateSessionResult> {
    const response = await fetch(`${BACKEND_URL}/api/v1/pairing/sessions`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(deviceName ? { deviceName } : {}),
    });
    if (!response.ok) throw await pairingError(response);
    return (await response.json()) as CreateSessionResult;
  }

  /** GET /api/v1/pairing/sessions/{id} — poll the session state. */
  async function getStatus(sessionId: string): Promise<SessionStatus> {
    const response = await fetch(
      `${BACKEND_URL}/api/v1/pairing/sessions/${encodeURIComponent(sessionId)}`,
      { headers: authHeaders() },
    );
    if (!response.ok) throw await pairingError(response);
    const body = (await response.json()) as Partial<SessionStatus>;
    return {
      state: (body.state ?? 'created') as PairingState,
      outcome: (body.outcome ?? '') as PairingOutcome,
      code: body.code ?? '',
      peerDeviceName: body.peerDeviceName ?? '',
      error: body.error ?? '',
    };
  }

  /** POST /api/v1/pairing/sessions/{id}/approve — holder sends the identity. */
  async function approve(sessionId: string): Promise<void> {
    const response = await fetch(
      `${BACKEND_URL}/api/v1/pairing/sessions/${encodeURIComponent(sessionId)}/approve`,
      { method: 'POST', headers: authHeaders() },
    );
    if (!response.ok) throw await pairingError(response);
  }

  /** POST /api/v1/pairing/sessions/{id}/cancel — either side tears down. */
  async function cancel(sessionId: string): Promise<void> {
    const response = await fetch(
      `${BACKEND_URL}/api/v1/pairing/sessions/${encodeURIComponent(sessionId)}/cancel`,
      { method: 'POST', headers: authHeaders() },
    );
    if (!response.ok) throw await pairingError(response);
  }

  /**
   * POST /api/v1/pairing/scan — scanner joins a session (used by the mobile
   * scanner and the e2e paste fallback). Included here so both link screens
   * share one client; the desktop QR screen does not call it.
   */
  async function scan(qrPayload: string, deviceName?: string): Promise<SessionStatus & { sessionId: string }> {
    const response = await fetch(`${BACKEND_URL}/api/v1/pairing/scan`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ qrPayload, ...(deviceName ? { deviceName } : {}) }),
    });
    if (!response.ok) throw await pairingError(response);
    const body = (await response.json()) as {
      sessionId: string;
      outcome?: PairingOutcome;
      code?: string;
      peerDeviceName?: string;
    };
    return {
      sessionId: body.sessionId,
      state: 'acked',
      outcome: (body.outcome ?? '') as PairingOutcome,
      code: body.code ?? '',
      peerDeviceName: body.peerDeviceName ?? '',
      error: '',
    };
  }

  /**
   * GET /api/v1/pairing/sessions/{id}/identity — the fresh side fetches the
   * received identity exactly once (the backend wipes it after the read).
   * Throws a PairingError with code `identity-present` (409) when this backend
   * already has an identity — linking never overwrites.
   */
  async function fetchIdentity(sessionId: string): Promise<PairingIdentity> {
    const response = await fetch(
      `${BACKEND_URL}/api/v1/pairing/sessions/${encodeURIComponent(sessionId)}/identity`,
      { headers: authHeaders() },
    );
    if (!response.ok) throw await pairingError(response);
    return (await response.json()) as PairingIdentity;
  }

  return { createSession, getStatus, approve, cancel, scan, fetchIdentity };
}
