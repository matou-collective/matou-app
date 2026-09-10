/**
 * usePairing — thin client over the backend linked-device pairing routes
 * (`/api/v1/pairing/*`, backend `internal/pairing`, spec
 * `docs/superpowers/specs/2026-09-08-linked-device-sign-in-design.md` §2).
 *
 * The Go backend owns the pairing protocol on both platforms; the frontend only
 * creates/scans sessions, polls state, and — as holder — approves. Shared by
 * the desktop QR screen (LinkDeviceQrScreen) and the mobile scan screen
 * (LinkDeviceScanScreen). The global fetch wrapper (installBackendAuth) attaches
 * the bearer token, including on GET …/identity which additionally requires it.
 */
import { BACKEND_URL, authHeaders } from 'src/lib/api/client';

/** Direction (or refusal) decided after the scanner's hello — §1 table. */
export type PairingOutcome =
  | 'phone-to-desktop'
  | 'desktop-to-phone'
  | 'neither'
  | 'already-linked'
  | 'conflict';

/** Session state machine (backend `internal/pairing/session.go`). */
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

/** A peer cancel is indistinguishable from a TTL expiry, and `failed` is any
 * driver/mailbox error — all three end the session with nothing more to do. */
export const TERMINAL_STATES: readonly PairingState[] = ['cancelled', 'expired', 'failed', 'done'];

export interface CreatedSession {
  sessionId: string;
  qrPayload: string;
  expiresAt: string;
}

export interface ScanResult {
  sessionId: string;
  outcome: PairingOutcome;
  /** 6-character SAS code — a STRING; may start with `0` (never parse it). */
  code?: string;
  peerDeviceName?: string;
}

export interface SessionStatus {
  state: PairingState;
  outcome?: PairingOutcome;
  code?: string;
  peerDeviceName?: string;
  error?: string;
}

export interface PairingIdentity {
  mnemonic: string;
  aid: string;
  orgAid?: string;
  adminAid?: string;
  configServerUrl?: string;
}

/** A pairing route returned a non-2xx; `code` is the backend `error` slug
 * (e.g. `config-server-mismatch`, `identity-present`) for tailored copy. */
export class PairingError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly aid?: string,
  ) {
    super(message);
    this.name = 'PairingError';
  }
}

async function parseError(res: Response): Promise<PairingError> {
  let body: { error?: string; message?: string; aid?: string } = {};
  try {
    body = await res.json();
  } catch {
    /* non-JSON body */
  }
  const code = body.error || `http-${res.status}`;
  return new PairingError(body.message || body.error || `Pairing request failed (${res.status})`, code, res.status, body.aid);
}

export function usePairing() {
  /** Displayer: create a session and get the QR payload to render. */
  async function createSession(deviceName?: string): Promise<CreatedSession> {
    const res = await fetch(`${BACKEND_URL}/api/v1/pairing/sessions`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(deviceName ? { deviceName } : {}),
    });
    if (!res.ok) throw await parseError(res);
    return res.json();
  }

  /** Scanner: hand the scanned/pasted QR to the backend and get the outcome. */
  async function scan(qrPayload: string, deviceName?: string): Promise<ScanResult> {
    const res = await fetch(`${BACKEND_URL}/api/v1/pairing/scan`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ qrPayload, deviceName }),
    });
    if (!res.ok) throw await parseError(res);
    return res.json();
  }

  /** Poll (or SSE-less) status snapshot for either side. */
  async function getStatus(sessionId: string): Promise<SessionStatus> {
    const res = await fetch(`${BACKEND_URL}/api/v1/pairing/sessions/${encodeURIComponent(sessionId)}`, {
      headers: authHeaders(),
    });
    if (!res.ok) throw await parseError(res);
    return res.json();
  }

  /** Holder: release the identity (backend reads the mnemonic it already has). */
  async function approve(sessionId: string): Promise<void> {
    const res = await fetch(`${BACKEND_URL}/api/v1/pairing/sessions/${encodeURIComponent(sessionId)}/approve`, {
      method: 'POST',
      headers: authHeaders(),
    });
    if (!res.ok) throw await parseError(res);
  }

  /** Either side: tear the session down. Best-effort — errors are swallowed. */
  async function cancel(sessionId: string): Promise<void> {
    try {
      await fetch(`${BACKEND_URL}/api/v1/pairing/sessions/${encodeURIComponent(sessionId)}/cancel`, {
        method: 'POST',
        headers: authHeaders(),
      });
    } catch {
      /* the far side's next long-poll will 404 and expire anyway */
    }
  }

  /** Receiver: read the transferred identity exactly once (409 if we already
   * hold one — the refuse-to-overwrite guard, §3.3). */
  async function getIdentity(sessionId: string): Promise<PairingIdentity> {
    const res = await fetch(`${BACKEND_URL}/api/v1/pairing/sessions/${encodeURIComponent(sessionId)}/identity`, {
      headers: authHeaders(),
    });
    if (!res.ok) throw await parseError(res);
    return res.json();
  }

  return { createSession, scan, getStatus, approve, cancel, getIdentity };
}
