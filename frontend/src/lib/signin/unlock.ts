/**
 * Posting the sealed passcode for a control-panel UNLOCK (idss #1929 story 15,
 * ADR 0282 d.3/d.6; matou-app #664, wire reconciled in #678). The wallet-side
 * machinery the unlock-only card (PU-A4) drives after the steward taps
 * **Unlock**.
 *
 * Unlike a sign-in presentation, an unlock carries the passcode and ONLY the
 * passcode: no credential is presented and no challenge is signed for a session,
 * because the panel is already signed in (its cookie survived the reload). So the
 * body is the challenge id, the answering `aid`, and the sealed box — a CESR qb64
 * `X25519_Cipher_Salt` cipher the door relays but cannot open (the same box
 * shape #663 seals for the sign-in handover). The door relays that `aid` back to
 * the panel on its poll as the identity the opened agent MUST match (ADR 0282
 * d.6), so it must ride the request (app-door-golden `unlock.present.request`).
 *
 * The door's answer is read the same honest way the present route is: from
 * `body.status`, not the HTTP 2xx, with the challenge-lifecycle verdicts riding
 * the HTTP code (404 unknown, 409 spent, 410 expired). But the unlock route
 * speaks its OWN success vocabulary: `answered`, never `verified` — an unlock
 * verifies nothing and mints nothing (idss#1959). A post that gets no answer at
 * all is the wallet-only site-unreachable case.
 */

import { normalizeRefusal } from './refusal';
import type { PresentVerdict } from './present';

/** The snake_case JSON body the wallet POSTs to the unlock relay (idss#1959 wire,
 *  app-door-golden `unlock.present.request`). */
export interface UnlockBody {
  /** The unlock challenge id the sealed box is bound to. */
  challenge_id: string;
  /** The steward's AID, relayed back to the panel as the identity the opened
   *  agent MUST match (ADR 0282 d.6). Without it the panel fails every fresh
   *  unlock closed to PU-M0x cause 2, so it always rides the request. */
  aid: string;
  /** The steward's passcode sealed to the tab's FRESH sealing key — a CESR qb64
   *  `X25519_Cipher_Salt` cipher the door relays but cannot open. */
  sealed_passcode: string;
}

/** The bridge's unlock-relay response body (mirrors the present route). */
interface UnlockResponse {
  status?: string;
  refusal?: string;
}

/**
 * POST the sealed passcode to the unlock code's relay URL (verbatim) and map the
 * door's answer to a {@link PresentVerdict}, reusing the sign-in verdict shape so
 * the card can share the refusal copy. A thrown fetch (no response, DNS, CORS,
 * abort) is site-unreachable — never mistaken for a refusal.
 *
 * Mapping (app-door-golden `unlock.present.*`, its OWN vocabulary):
 *  - `body.status === "answered"` → success (the box was relayed to the panel).
 *  - `body.status === "expired"`  → refused (the challenge died; 410 also carries it).
 *  - `body.status === "refused"`  → refused, carrying `body.refusal` (200/400).
 *  - HTTP 404 → unknown, 409 → spent, 410 → expired (the stale-code verdicts).
 *  - anything else fails closed to a refusal — never a false success. An unlock
 *    is never "verified" (it verifies nothing); `answered` is its only success.
 *
 * `fetchImpl` is injectable so tests drive verdicts without a live door.
 */
export async function postUnlock(
  relayUrl: string,
  body: UnlockBody,
  fetchImpl: typeof fetch = fetch,
): Promise<PresentVerdict> {
  let res: Response;
  try {
    res = await fetchImpl(relayUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    // The post never landed; the panel, having heard nothing, keeps waiting.
    return { outcome: 'site-unreachable' };
  }

  let parsed: UnlockResponse | null = null;
  try {
    parsed = (await res.json()) as UnlockResponse | null;
  } catch {
    parsed = null;
  }

  if (res.status === 404) return { outcome: 'refused', refusal: 'unknown' };
  if (res.status === 409) return { outcome: 'refused', refusal: 'spent' };
  if (res.status === 410) return { outcome: 'refused', refusal: 'expired' };

  const status = (parsed?.status ?? '').trim().toLowerCase();
  // The unlock route's success is `answered`, NEVER `verified` (idss#1959): an
  // unlock verifies nothing. We map it onto the shared verdict's success outcome
  // so the card can reuse the sign-in refusal copy unchanged.
  if (status === 'answered') return { outcome: 'verified' };
  if (status === 'expired') return { outcome: 'refused', refusal: 'expired' };

  // A `refused` status carries the door's slug; any other answer (a stray
  // `verified`, a missing/garbled status on a 2xx) fails closed to a refusal so
  // no answer is ever mistaken for success.
  return { outcome: 'refused', refusal: normalizeRefusal(parsed?.refusal) };
}
