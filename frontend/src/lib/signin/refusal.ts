/**
 * The wallet's half of the sign-in refusal copy contract (idss spec #1492
 * stories 25/27/28, wireframe WS-A2r; the page renders the identical sentence
 * and tails at WS-S1r). Both surfaces speak with one voice so a member reads
 * one story, not two.
 *
 * The bridge answers a refused presentation with a machine-readable refusal
 * *kind* (spec story 20's typed refusals, surfaced as a slug). The wallet maps
 * the kind to the sentence; a kind it does not recognise falls back to the
 * signature tail (the least specific, never a leak).
 */

/**
 * The five verification-refusal kinds the door reports (spec story 25), plus
 * the fail-closed `records-unreachable` (story 27), the wallet-only
 * `site-unreachable` (story 28, the post itself got no answer), and the three
 * challenge-lifecycle kinds the app door reports by HTTP code (app-door-golden,
 * #574): `unknown` (404), `spent` (409) and `expired` (410 / status expired) —
 * these are stale-code problems the member fixes with a fresh code, not a
 * credential fault. And `no-credential` (#683, idss ADR 0289, app-door-golden
 * `present.no_credential`): the presented credential is not the one this door
 * asks for — a wallet that reads `cred=` should never cause it, and when it
 * happens it wears the same sentence as the wallet's own no-credential screen.
 */
export type RefusalKind =
  | 'no-membership'
  | 'revoked'
  | 'untrusted-issuer'
  | 'signature'
  | 'wrong-holder'
  | 'no-credential'
  | 'records-unreachable'
  | 'site-unreachable'
  | 'unknown'
  | 'spent'
  | 'expired';

/** The shared opener every verification refusal wears (stories 25). */
export const REFUSAL_OPENER = 'Your access could not be verified. It looks like ';

/**
 * The tail sentence per verification-refusal kind (spec story 25). `signature`
 * and `wrong-holder` share the same tail on purpose — a holder mismatch is not
 * distinguished, so a probe cannot learn which check failed.
 */
const TAILS: Record<'no-membership' | 'revoked' | 'untrusted-issuer' | 'signature' | 'wrong-holder', string> = {
  'no-membership': "you don't hold a membership from this community yet. Ask your operator to add you.",
  revoked: 'your membership here has been revoked.',
  'untrusted-issuer': "that credential wasn't issued by this community.",
  signature: "that approval didn't match this sign-in.",
  'wrong-holder': "that approval didn't match this sign-in.",
};

/** The fail-closed line — the community's outage, not the member's fault
 * (story 27): no "could not be verified" opener and no operator line. */
export const RECORDS_UNREACHABLE_TEXT =
  "The community's records can't be reached right now. Try again shortly.";

/** The wallet-only network line (story 28): the page heard nothing and keeps
 * waiting, so only the wallet can say the post did not land. */
export const SITE_UNREACHABLE_TEXT =
  "Couldn't reach the sign-in site. Check your connection and try again.";

/** The stale-code lines (#574): the credential is fine, the sign-in code the
 * member is answering is no longer good — a fresh code from the page fixes it,
 * so no "could not be verified" opener and no operator line. */
export const STALE_CODE_TEXT: Record<'unknown' | 'spent' | 'expired', string> = {
  unknown: "This sign-in code isn't recognised. Start the sign-in again to get a fresh code.",
  spent: 'This sign-in code was already used. Start the sign-in again to get a fresh code.',
  expired: 'This sign-in code has expired. Start the sign-in again to get a fresh code.',
};

/**
 * The no-credential sentence (#683; Ben, 2026-09-28). The wallet says it on its
 * own screen when it holds nothing the door asks for — before anything is
 * presented — and wears the same words if the door itself answers
 * `no-credential`.
 */
export const NO_CREDENTIAL_TEXT = 'You do not have the required credential to sign into this service';

/**
 * What the wallet will present instead, when the door answered `revoked` and
 * the wallet holds something else this door admits (#690) — at the control
 * panel, a steward's Membership behind a revoked Administrator.
 */
export interface RevokedFallback {
  /** The name of the credential the door called revoked ("Administrator"). */
  revoked: string;
  /** The name of the credential the next code will present ("Membership"). */
  next: string;
}

/**
 * The `revoked` sentence when there is a fallback (#690): it names the
 * credential that was revoked — which is not the Membership, so the shared tail
 * would be wrong — and says what happens next. The refused code is spent (a
 * sign-in code is single-use), so trying again means a fresh code from the
 * sign-in page; on that code the wallet presents the fallback.
 */
export function revokedWithFallbackText(fallback: RevokedFallback): string {
  const revoked = fallback.revoked.trim();
  const subject = revoked ? `your ${revoked} credential` : 'that credential';
  return (
    `${REFUSAL_OPENER}${subject} has been revoked. ` +
    `Try again with a fresh code from the sign-in page, and you will sign in with your ${fallback.next.trim()}.`
  );
}

/** The line beneath *Try again* on a verification refusal (story 25). */
export const CONTACT_LINE = "or contact your community's operator";

/** One rendered refusal, ready for the WS-A2r region. */
export interface RefusalCopy {
  kind: RefusalKind;
  /** The full sentence the region shows. */
  text: string;
  /** Whether *Try again* is offered (every refusal but `no-credential`). */
  showTryAgain: boolean;
  /** Whether the "or contact your community's operator" line shows — only the
   * five verification refusals, never the two outage/network lines. */
  showContact: boolean;
}

/**
 * Map any refusal string the door (or the wallet's own network path) produced
 * to the wallet's copy. An unrecognised kind is treated as `signature`, the
 * least specific verification tail, so a new or garbled slug never leaks a
 * more specific reason nor renders blank.
 *
 * `fallback` is read for a `revoked` refusal only: when it names a credential
 * the wallet will present next, the sentence says so (#690).
 */
export function refusalCopy(raw: string | null | undefined, fallback?: RevokedFallback | null): RefusalCopy {
  const kind = normalizeRefusal(raw);

  if (kind === 'records-unreachable') {
    return { kind, text: RECORDS_UNREACHABLE_TEXT, showTryAgain: true, showContact: false };
  }
  if (kind === 'site-unreachable') {
    return { kind, text: SITE_UNREACHABLE_TEXT, showTryAgain: true, showContact: false };
  }
  if (kind === 'unknown' || kind === 'spent' || kind === 'expired') {
    return { kind, text: STALE_CODE_TEXT[kind], showTryAgain: true, showContact: false };
  }
  if (kind === 'no-credential') {
    // Trying again would present the same credential to the same door, so none
    // is offered; the screen itself says who can issue the credential.
    return { kind, text: NO_CREDENTIAL_TEXT, showTryAgain: false, showContact: false };
  }
  if (kind === 'revoked' && fallback?.next.trim()) {
    return { kind, text: revokedWithFallbackText(fallback), showTryAgain: true, showContact: true };
  }
  return {
    kind,
    text: REFUSAL_OPENER + TAILS[kind],
    showTryAgain: true,
    showContact: true,
  };
}

/**
 * Normalise a raw refusal slug to a known {@link RefusalKind}. The bridge is
 * expected to send one of the exact slugs; anything else degrades to
 * `signature` (see {@link refusalCopy}).
 */
export function normalizeRefusal(raw: string | null | undefined): RefusalKind {
  const slug = (raw ?? '').trim().toLowerCase();
  switch (slug) {
    case 'no-membership':
    case 'revoked':
    case 'untrusted-issuer':
    case 'signature':
    case 'wrong-holder':
    case 'no-credential':
    case 'records-unreachable':
    case 'site-unreachable':
    case 'unknown':
    case 'spent':
    case 'expired':
      return slug;
    default:
      return 'signature';
  }
}
