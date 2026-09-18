/**
 * Posting the presentation to the sign-in site and reading its verdict (idss
 * spec #1492 stories 14/16/28, ADR 0236 §2, prototype #1301 `wallet/wallet.mjs`
 * `approve` + `door/main.go` `present`).
 *
 * The wallet POSTs a bare JSON body to the site's present route and the bridge
 * verifies in Go against the issuer's witnessed ledger, answering VERIFIED or a
 * refusal kind. A post that gets no answer at all is the wallet-only
 * site-unreachable case — the browser page heard nothing and keeps waiting, so
 * only the wallet can say the network failed.
 */

import { normalizeRefusal, type RefusalKind } from './refusal';

/** The door-bound signing message (ADR 0236 §5, spec story 14): the KERI-auth
 * prefix, the site's own address, the AID and the challenge nonce. A signature
 * over any other address is worthless at the real door. */
export function boundMessage(door: string, aid: string, nonce: string): string {
  return `idss-idp:${door}:${aid}:${nonce}`;
}

/** The present route relative to the site address (prototype #1301). */
export const PRESENT_PATH = '/signin/present';

/** The JSON body the wallet posts (spec story 14 / prototype `present`). */
export interface PresentBody {
  aid: string;
  challengeID: string;
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

/**
 * POST the presentation to `<door>/signin/present` and map the answer to a
 * {@link PresentVerdict}. A 2xx is VERIFIED; a non-2xx carries the door's
 * refusal slug (`body.refusal`); a thrown fetch (no response, DNS, CORS, abort)
 * is site-unreachable — never mistaken for a refusal.
 *
 * `fetchImpl` is injectable so tests drive verdicts without a live door.
 */
export async function presentToDoor(
  door: string,
  body: PresentBody,
  fetchImpl: typeof fetch = fetch,
): Promise<PresentVerdict> {
  const url = door.replace(/\/+$/, '') + PRESENT_PATH;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    // The post never landed (network down, DNS, CORS, abort). The page, having
    // heard nothing, keeps waiting; only the wallet says so (spec story 28).
    return { outcome: 'site-unreachable' };
  }

  if (res.ok) {
    return { outcome: 'verified' };
  }

  // A refused verdict carries the door's typed refusal slug. Read it
  // defensively — a body that will not parse still refuses (mapped to the
  // least-specific tail by refusalCopy).
  let refusal: string | undefined;
  try {
    const parsed = (await res.json()) as { refusal?: string } | null;
    refusal = parsed?.refusal;
  } catch {
    refusal = undefined;
  }
  return { outcome: 'refused', refusal: normalizeRefusal(refusal) };
}
