/**
 * Pure logic for resolving a registration applicant's key state (OOBI).
 *
 * Background (Andrew Weaver incident, Mar–Aug 2026): the `senderOOBI` recorded
 * in a registration message is the agent-role form
 * (`…/oobi/<AID>/agent/<agentAID>`), and the agent AID silently changes when a
 * client re-boots — so the recorded URL can be dead while the bare form
 * (`…/oobi/<AID>`) still serves the identical KEL. A pending registration
 * whose sender is never resolved sits in the admin KERIA's exchange escrow
 * indefinitely. These helpers give every resolver the same fallback chain and
 * give the polling loop a backoff policy so it can retry without hammering.
 */

export interface ResolveAttemptState {
  /** Completed attempt passes (a pass tries the whole candidate chain). */
  attempts: number;
  /** Epoch ms of the last attempt pass. */
  lastAttemptAt: number;
  /** Epoch ms when this applicant was first seen pending. */
  firstSeenAt: number;
  /** True once any candidate resolved successfully. */
  resolved: boolean;
}

/** After this long pending-and-failing, an applicant is flagged unreachable. */
export const UNREACHABLE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const BACKOFF_BASE_MS = 15_000; // one notification-poll cycle
const BACKOFF_CAP_MS = 60 * 60 * 1000; // 1 hour
/** Minimum failed passes before an applicant may be flagged unreachable. */
const UNREACHABLE_MIN_ATTEMPTS = 5;

/**
 * Ordered OOBI candidates for an applicant, most reliable first:
 * 1. bare OOBI on our own KERIA (`cesrUrl`) — stable across agent re-boots,
 *    and the documented de-escrow trigger (see useClaimIdentity),
 * 2. bare OOBI derived from the recorded OOBI's host (covers applicants on a
 *    different KERIA than ours),
 * 3. the recorded OOBI verbatim (agent form; breaks when the agent is
 *    re-created, so it goes last).
 */
export function buildOobiCandidates(params: {
  applicantAid: string;
  recordedOobi?: string | undefined;
  cesrUrl?: string | undefined;
}): string[] {
  const { applicantAid, recordedOobi, cesrUrl } = params;
  if (!applicantAid) return [];

  const candidates: string[] = [];

  if (cesrUrl) {
    candidates.push(`${cesrUrl.replace(/\/+$/, '')}/oobi/${applicantAid}`);
  }

  if (recordedOobi) {
    try {
      const url = new URL(recordedOobi);
      candidates.push(`${url.origin}/oobi/${applicantAid}`);
      candidates.push(recordedOobi);
    } catch {
      // Malformed recorded OOBI — nothing to derive from it.
    }
  }

  return [...new Set(candidates)];
}

export interface SenderOobiFields {
  /** Bare-form OOBI (`…/oobi/<AID>`) — survives agent re-boots. */
  senderOOBI: string;
  /** Agent-form OOBI, kept for diagnostics/back-compat only. */
  senderAgentOobi?: string;
}

/**
 * The OOBI fields a registration payload should record for its sender.
 * The bare form goes in `senderOOBI` (what receivers resolve) because the
 * agent form dies whenever the sender's client re-boots its agent; the agent
 * form is demoted to `senderAgentOobi` so ops can still see which agent the
 * sender had at submission time.
 */
export function buildSenderOobiFields(params: {
  prefix: string;
  cesrUrl?: string | undefined;
  agentOobi?: string | undefined;
}): SenderOobiFields | null {
  const { prefix, cesrUrl, agentOobi } = params;
  if (!prefix) return null;

  let senderOOBI = '';
  if (cesrUrl) {
    senderOOBI = `${cesrUrl.replace(/\/+$/, '')}/oobi/${prefix}`;
  } else if (agentOobi) {
    try {
      senderOOBI = `${new URL(agentOobi).origin}/oobi/${prefix}`;
    } catch {
      // Unparseable recorded OOBI — better than recording nothing.
      senderOOBI = agentOobi;
    }
  }
  if (!senderOOBI) return null;

  if (agentOobi && agentOobi !== senderOOBI) {
    return { senderOOBI, senderAgentOobi: agentOobi };
  }
  return { senderOOBI };
}

/** Dead-letter notification routes emitted by the KERIA exchanger patch. */
export const FAILED_REGISTRATION_ROUTES = [
  '/exn/matou/registration/apply/failed',
  '/exn/ipex/apply/failed',
];

export interface ExpiredRegistration {
  notificationId: string;
  applicantAid: string;
  applicantName?: string;
  exnSaid: string;
  /** How long the exn sat in escrow before being dead-lettered. */
  waitedSeconds?: number;
  failedAt?: string;
}

/**
 * Parse a dead-letter notification (route `…/failed`) from the KERIA
 * exchanger patch: the applicant's registration exn sat in the exchange
 * escrow past the dead-letter bound and was removed — it can never verify,
 * so the applicant must re-apply. Returns null for anything else.
 */
export function parseFailedRegistrationNotification(note: {
  i: string;
  a?: {
    r?: string;
    d?: string;
    i?: string;
    a?: Record<string, unknown>;
    dt?: string;
    [key: string]: unknown;
  };
}): ExpiredRegistration | null {
  const attrs = note.a;
  if (!attrs || !FAILED_REGISTRATION_ROUTES.includes(attrs.r ?? '')) return null;

  const applicantAid = attrs.i ?? '';
  if (!applicantAid) return null;

  const embedded = attrs.a ?? {};
  const result: ExpiredRegistration = {
    notificationId: note.i,
    applicantAid,
    exnSaid: attrs.d || note.i,
  };
  if (typeof embedded.name === 'string' && embedded.name) {
    result.applicantName = embedded.name;
  }
  if (typeof attrs.waitedSeconds === 'number') {
    result.waitedSeconds = attrs.waitedSeconds;
  }
  if (attrs.dt) {
    result.failedAt = attrs.dt;
  }
  return result;
}

/** Delay to wait before attempt pass number `attempts` (0-indexed). */
export function nextResolveDelayMs(attempts: number): number {
  if (attempts <= 0) return 0;
  return Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_CAP_MS);
}

/** Whether the polling loop should run another resolve pass now. */
export function shouldAttemptResolve(
  state: ResolveAttemptState | undefined,
  nowMs: number,
): boolean {
  if (!state) return true;
  if (state.resolved) return false;
  return nowMs - state.lastAttemptAt >= nextResolveDelayMs(state.attempts);
}

/**
 * Whether to surface this applicant as unreachable in the UI. Retries keep
 * going (hourly) — this only drives the warning, it never gives up silently.
 */
export function isApplicantUnreachable(
  state: ResolveAttemptState | undefined,
  nowMs: number,
): boolean {
  if (!state || state.resolved) return false;
  if (state.attempts < UNREACHABLE_MIN_ATTEMPTS) return false;
  return nowMs - state.firstSeenAt > UNREACHABLE_AFTER_MS;
}
