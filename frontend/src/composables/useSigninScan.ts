/**
 * Scanning a sign-in code from inside the wallet (idss spec #1492 story 10).
 *
 * The community's sign-in page shows a `matou://signin?…` QR; a signed-in
 * member scans it here and the wallet opens the approve card (WS-A2). This
 * reuses the same device scanner the pairing flow uses (`scanPairingQr` in
 * `src/lib/barcode.ts` — a generic QR read despite its name), so a sign-in code
 * is accepted beside the pairing link. On desktop / emulator / e2e there is no
 * camera, so a pasted link is routed the same way.
 *
 * The link → route-location mapping is a pure function (`signinLinkToLocation`)
 * so it is unit-testable without the scanner.
 */

import type { RouteLocationRaw, Router } from 'vue-router';
import { scanPairingQr, ScanUnavailableError } from 'src/lib/barcode';
import { parseSigninLink } from 'src/lib/signin/link';

/**
 * Turn a `matou://signin?…` link into the approve-card route location, carrying
 * the link's fields as query params, or `null` when the text is not a sign-in
 * link.
 */
export function signinLinkToLocation(text: string): RouteLocationRaw | null {
  const ask = parseSigninLink(text);
  if (!ask) return null;
  return {
    name: 'signin-approve',
    query: {
      door: ask.door,
      present: ask.present,
      c: ask.challenge,
      ...(ask.schemas.length ? { s: ask.schemas.join(',') } : {}),
      ...(ask.community ? { name: ask.community } : {}),
      ...(ask.service ? { service: ask.service } : {}),
    },
  };
}

/** The result of an attempted scan, for the caller to surface. */
export type ScanOutcome =
  | { status: 'navigated' }
  | { status: 'dismissed' }
  | { status: 'not-a-code' }
  | { status: 'unavailable'; reason: 'unsupported' | 'permission-denied' }
  | { status: 'error' };

/**
 * Open the scanner, and on a `matou://signin` result navigate to the approve
 * card. Returns an outcome the caller can turn into copy (the scanner UI itself
 * is device-only; the paste fallback lives in the calling screen).
 */
export async function scanSigninCode(router: Router): Promise<ScanOutcome> {
  try {
    const text = await scanPairingQr();
    if (!text) return { status: 'dismissed' };
    return routeSigninText(router, text);
  } catch (err) {
    if (err instanceof ScanUnavailableError) {
      return { status: 'unavailable', reason: err.reason };
    }
    return { status: 'error' };
  }
}

/** Route a scanned/pasted sign-in link, or report it is not a code. */
export async function routeSigninText(router: Router, text: string): Promise<ScanOutcome> {
  const location = signinLinkToLocation(text.trim());
  if (!location) return { status: 'not-a-code' };
  await router.push(location);
  return { status: 'navigated' };
}
