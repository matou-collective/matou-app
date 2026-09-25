/**
 * Recognising a member's Membership credential (issue #615).
 *
 * A membership check must match the schema the community actually issues under
 * — the one the descriptor names in `schemas.membership.said` — not a hardcoded
 * built-in. On an IDSS community the founder holds a Membership credential of
 * the community's own schema, issued by `community.aid` to their AID; the
 * previous checks tested only the Mātou (coa-shared) schema SAID, so that
 * correctly issued credential never counted and the founder was stranded on
 * "Your application is being reviewed".
 *
 * These are pure predicates: the schema SAID is resolved from the descriptor by
 * the caller (see {@link getMembershipSchemaSaid}) and passed in, so the routing
 * decision is unit-testable without a live descriptor or KERIA.
 */

import type { HeldCredential } from 'src/lib/signin/credential';

/** What identifies a held Membership credential for this community. */
export interface MembershipMatch {
  /** The Membership schema SAID the descriptor names (or the Mātou fallback). */
  membershipSchema: string;
  /** This member's AID; the credential must be issued TO them. */
  holderAid: string;
  /**
   * The community group AID — the issuer of every credential. When set, the
   * credential must be issued BY it. Left unset where the issuer is not part
   * of the check (splash's routing check historically matched on schema +
   * holder only).
   */
  communityAid?: string;
}

/**
 * True when `cred` is a Membership credential for this community: of the named
 * Membership schema, issued to `holderAid`, and — when `communityAid` is given
 * — issued by that community AID. A credential with no recorded issuee never
 * matches (a membership credential always names its holder).
 */
export function isMembershipCredential(cred: HeldCredential, match: MembershipMatch): boolean {
  const sad = cred.sad;
  if (!sad || !match.membershipSchema) return false;
  if (sad.s !== match.membershipSchema) return false;
  if (sad.a?.i !== match.holderAid) return false;
  // Guard only when both sides are known: never miscount a credential the
  // community did not issue, but do not filter on an issuer we cannot read.
  if (match.communityAid && sad.i && sad.i !== match.communityAid) return false;
  return true;
}

/** True when the wallet holds any Membership credential matching `match`. */
export function hasMembershipCredential(
  creds: readonly HeldCredential[],
  match: MembershipMatch,
): boolean {
  return creds.some((c) => isMembershipCredential(c, match));
}
