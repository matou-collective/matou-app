/**
 * usePairing — a thin client over the backend's linked-device pairing routes
 * (`/api/v1/pairing/*`, spec §2, backend slice #471 / #484). The Go backend
 * owns the protocol on both platforms; the frontend only creates or scans a
 * session, polls its state, approves or cancels, and — on the fresh side —
 * fetches the identity once it has arrived. Shared by the desktop QR screen
 * (LinkDeviceQrScreen, #472) and the mobile scan screen (LinkDeviceScanScreen,
 * #473).
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

/** States after which the backend session will never change again. A peer
 * cancel surfaces on the other side as `expired`; `failed` is any driver /
 * mailbox error. */
export const TERMINAL_STATES: readonly PairingState[] = ['cancelled', 'expired', 'failed', 'done'];

/** Direction (or refusal) decided after the scanner's hello (spec §1 table).
 * Empty until the handshake has decided. */
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

/** What the scanner gets back once the displayer has acked its hello. */
export interface ScanResult extends SessionStatus {
  sessionId: string;
}

export interface PairingIdentity {
  mnemonic: string;
  aid: string;
  orgAid?: string;
  adminAid?: string;
  configServerUrl?: string;
}

/** Raised when a pairing request fails; carries the HTTP status and the
 * backend's `error` slug (e.g. `config-server-mismatch`, `identity-present`)
 * so screens can render tailored copy. */
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

/** Fill in the optional fields the backend omits (`omitempty`). */
function normalizeStatus(body: Partial<SessionStatus>): SessionStatus {
  return {
    state: (body.state ?? 'created') as PairingState,
    outcome: (body.outcome ?? '') as PairingOutcome,
    code: body.code ?? '',
    peerDeviceName: body.peerDeviceName ?? '',
    error: body.error ?? '',
  };
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
    return normalizeStatus((await response.json()) as Partial<SessionStatus>);
  }

  /** POST /api/v1/pairing/sessions/{id}/approve — holder sends the identity. */
  async function approve(sessionId: string): Promise<void> {
    const response = await fetch(
      `${BACKEND_URL}/api/v1/pairing/sessions/${encodeURIComponent(sessionId)}/approve`,
      { method: 'POST', headers: authHeaders() },
    );
    if (!response.ok) throw await pairingError(response);
  }

  /** POST /api/v1/pairing/sessions/{id}/cancel — either side tears down.
   * Throws on failure; screens treat cancel as best-effort and catch. */
  async function cancel(sessionId: string): Promise<void> {
    const response = await fetch(
      `${BACKEND_URL}/api/v1/pairing/sessions/${encodeURIComponent(sessionId)}/cancel`,
      { method: 'POST', headers: authHeaders() },
    );
    if (!response.ok) throw await pairingError(response);
  }

  /**
   * POST /api/v1/pairing/scan — scanner joins a session: the backend sends
   * hello, waits for the displayer's ack, and returns the outcome + code (used
   * by the mobile scanner and the paste fallback; the desktop QR screen does
   * not call it).
   */
  async function scan(qrPayload: string, deviceName?: string): Promise<ScanResult> {
    const response = await fetch(`${BACKEND_URL}/api/v1/pairing/scan`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ qrPayload, ...(deviceName ? { deviceName } : {}) }),
    });
    if (!response.ok) throw await pairingError(response);
    const body = (await response.json()) as Partial<SessionStatus> & { sessionId: string };
    return {
      sessionId: body.sessionId,
      ...normalizeStatus({ ...body, state: 'acked' }),
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
