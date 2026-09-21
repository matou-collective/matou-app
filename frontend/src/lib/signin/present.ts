/**
 * Posting the presentation to the sign-in site and reading its verdict (idss
 * spec #1492 stories 14/16/28, ADR 0236 §2). The wire is pinned by the sign-in
 * bridge's APP DOOR golden (idss `internal/idp/testdata/app-door-golden.json`,
 * copied to `tests/scripts/fixtures/app-door/app-door-golden.json`; Ben's
 * rulings on idss #1666/#1669, #574).
 *
 * The wallet POSTs a snake_case JSON body to the URL the ask carried verbatim
 * (`present_url`, never derived from `door`) and the bridge verifies in Go
 * against the issuer's witnessed ledger. The answer is read from `body.status`
 * (`verified` | `refused` | `expired`), NOT from the HTTP 2xx alone: the bridge
 * answers a refusal with HTTP 200, so trusting the 2xx would tell a member they
 * are signed in when the door refused them. The challenge-lifecycle verdicts
 * ride the HTTP code: 404 unknown, 409 spent, 410 expired. A post that gets no
 * answer at all is the wallet-only site-unreachable case — the browser page
 * heard nothing and keeps waiting, so only the wallet can say the network
 * failed.
 */

import { normalizeRefusal, type RefusalKind } from './refusal';

/** The door-bound signing message (ADR 0236 §5, spec story 14): the KERI-auth
 * prefix, the site's own address, the AID and the challenge nonce. A signature
 * over any other address is worthless at the real door. */
export function boundMessage(door: string, aid: string, nonce: string): string {
  return `idss-idp:${door}:${aid}:${nonce}`;
}

/** The snake_case JSON body the wallet posts (app-door-golden `present.request`). */
export interface PresentBody {
  aid: string;
  challenge_id: string;
  /** The qb64 signature over the bound message. */
  response: string;
  /** The exported CESR presentation (ACDC + iss). */
  presentation: string;
}

/** The outcome the card acts on. */
export type PresentVerdict =
  | { outcome: 'verified' }
  | { outcome: 'refused'; refusal: RefusalKind }
  | { outcome: 'site-unreachable' };

/** The bridge's present-route response body (app-door-golden `present.*.body`). */
interface PresentResponse {
  status?: string;
  refusal?: string;
}

/**
 * POST the presentation to the ask's `present_url` (verbatim) and map the
 * bridge's answer to a {@link PresentVerdict} by reading `body.status`, not the
 * HTTP 2xx. A thrown fetch (no response, DNS, CORS, abort) is site-unreachable
 * — never mistaken for a refusal.
 *
 * Mapping (app-door-golden):
 *  - `body.status === "verified"` → verified.
 *  - `body.status === "refused"`  → refused, carrying `body.refusal` (200).
 *  - HTTP 404 → unknown, 409 → spent, 410 → expired (the challenge-lifecycle
 *    verdicts, whatever the body says).
 *  - anything else (2xx with no/garbled status, unexpected code) fails closed
 *    to a refusal — never a false "verified".
 *
 * `fetchImpl` is injectable so tests drive verdicts without a live door.
 */
export async function presentToDoor(
  presentUrl: string,
  body: PresentBody,
  fetchImpl: typeof fetch = fetch,
): Promise<PresentVerdict> {
  let res: Response;
  try {
    res = await fetchImpl(presentUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    // The post never landed (network down, DNS, CORS, abort). The page, having
    // heard nothing, keeps waiting; only the wallet says so (spec story 28).
    return { outcome: 'site-unreachable' };
  }

  // Read the typed body defensively — a body that will not parse still maps to
  // the least-specific refusal below, never to verified.
  let parsed: PresentResponse | null = null;
  try {
    parsed = (await res.json()) as PresentResponse | null;
  } catch {
    parsed = null;
  }

  // The challenge-lifecycle verdicts ride the HTTP code (golden), regardless of
  // the body: 404 unknown challenge, 409 spent, 410 expired.
  if (res.status === 404) return { outcome: 'refused', refusal: 'unknown' };
  if (res.status === 409) return { outcome: 'refused', refusal: 'spent' };
  if (res.status === 410) return { outcome: 'refused', refusal: 'expired' };

  const status = (parsed?.status ?? '').trim().toLowerCase();
  if (status === 'verified') return { outcome: 'verified' };
  if (status === 'expired') return { outcome: 'refused', refusal: 'expired' };

  // A `refused` status carries the door's typed refusal slug; and any other
  // answer (missing/garbled status on a 2xx) fails closed to a refusal so a 200
  // is never read as a false VERIFIED.
  return { outcome: 'refused', refusal: normalizeRefusal(parsed?.refusal) };
}
