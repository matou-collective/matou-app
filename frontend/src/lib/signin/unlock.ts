/**
 * Posting the sealed passcode for a control-panel UNLOCK (idss #1929 story 15,
 * ADR 0282 d.3/d.6; matou-app #664). The wallet-side machinery the unlock-only
 * card (PU-A4) drives after the steward taps **Unlock**.
 *
 * Unlike a sign-in presentation, an unlock carries the passcode and ONLY the
 * passcode: no credential is presented and no challenge is signed for a session,
 * because the panel is already signed in (its cookie survived the reload). So the
 * body is just the challenge id and the sealed box — a CESR qb64
 * `X25519_Cipher_Salt` cipher the door relays but cannot open (the same box
 * shape #663 seals for the sign-in handover).
 *
 * The door's answer is read the same honest way the present route is: from
 * `body.status`, not the HTTP 2xx, with the challenge-lifecycle verdicts riding
 * the HTTP code (404 unknown, 409 spent, 410 expired). A post that gets no answer
 * at all is the wallet-only site-unreachable case.
 */

import { normalizeRefusal } from './refusal';
import type { PresentVerdict } from './present';

/** The snake_case JSON body the wallet POSTs to the unlock relay (#664 wire). */
export interface UnlockBody {
  /** The unlock challenge id the sealed box is bound to. */
  challenge_id: string;
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
 * Mapping (mirrors {@link presentToDoor}):
 *  - `body.status === "verified"` → verified (the box was relayed).
 *  - `body.status === "refused"`  → refused, carrying `body.refusal` (200).
 *  - HTTP 404 → unknown, 409 → spent, 410 → expired (the stale-code verdicts).
 *  - anything else fails closed to a refusal — never a false "verified".
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
  if (status === 'verified') return { outcome: 'verified' };
  if (status === 'expired') return { outcome: 'refused', refusal: 'expired' };

  // A `refused` status carries the door's slug; any other answer fails closed to
  // a refusal so a 200 is never read as a false VERIFIED.
  return { outcome: 'refused', refusal: normalizeRefusal(parsed?.refusal) };
}
