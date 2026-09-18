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
 * the fail-closed `records-unreachable` (story 27) and the wallet-only
 * `site-unreachable` (story 28, the post itself got no answer).
 */
export type RefusalKind =
  | 'no-membership'
  | 'revoked'
  | 'untrusted-issuer'
  | 'signature'
  | 'wrong-holder'
  | 'records-unreachable'
  | 'site-unreachable';

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

/** The line beneath *Try again* on a verification refusal (story 25). */
export const CONTACT_LINE = "or contact your community's operator";

/** One rendered refusal, ready for the WS-A2r region. */
export interface RefusalCopy {
  kind: RefusalKind;
  /** The full sentence the region shows. */
  text: string;
  /** Whether *Try again* is offered (every refusal here offers it). */
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
 */
export function refusalCopy(raw: string | null | undefined): RefusalCopy {
  const kind = normalizeRefusal(raw);

  if (kind === 'records-unreachable') {
    return { kind, text: RECORDS_UNREACHABLE_TEXT, showTryAgain: true, showContact: false };
  }
  if (kind === 'site-unreachable') {
    return { kind, text: SITE_UNREACHABLE_TEXT, showTryAgain: true, showContact: false };
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
    case 'records-unreachable':
    case 'site-unreachable':
      return slug;
    default:
      return 'signature';
  }
}
