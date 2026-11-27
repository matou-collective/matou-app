/**
 * Deciding whether this wallet holds a steward credential for the community
 * (issue #534, ADR 0226 fallback ruling 2026-09-18).
 *
 * On an IDSS community there is no separate steward credential: it is the
 * member's **Membership credential carrying `role: operator`**, issued by the
 * community group AID into the one community ledger. The founder has held one
 * since founding, so when they bring their identity into the app with their
 * twelve words it arrives in the same agent. "Holds a steward credential" in
 * the acceptance criteria = a held Membership credential from `community.aid`
 * whose `role` is `operator` and (when known) issued to this member.
 *
 * A wallet with no such credential creates nothing — the content surfaces show
 * their empty state (AC3).
 */

import type { HeldCredential } from 'src/lib/signin/credential';

/** The role a steward's Membership credential carries (ADR 0226 ruling). */
export const STEWARD_ROLE = 'operator';

/** What identifies a steward credential for this community. */
export interface StewardMatch {
  /** The community group AID — the issuer of every credential (descriptor). */
  communityAid: string;
  /** The Membership schema SAID; when set, the credential must match it. */
  membershipSchema?: string;
  /** This member's AID; when set, the credential must be issued to them. */
  holderAid?: string;
}

/**
 * True when `cred` is a steward credential for the community: issued by
 * `communityAid`, carrying `role: operator` (case-insensitive), of the
 * Membership schema when one is named, and issued to this member when the
 * holder is known. A blank community AID never matches — a steward is always
 * relative to a specific community's ledger.
 */
export function isStewardCredential(cred: HeldCredential, match: StewardMatch): boolean {
  const sad = cred.sad;
  if (!sad || !match.communityAid) return false;
  if (sad.i !== match.communityAid) return false;
  if ((sad.a?.role ?? '').trim().toLowerCase() !== STEWARD_ROLE) return false;
  if (match.membershipSchema && sad.s !== match.membershipSchema) return false;
  // The holder check is a guard only when both sides are known: never present
  // someone else's credential, but do not filter out a credential whose issuee
  // we cannot read (the door makes the final holder check).
  if (match.holderAid && sad.a?.i && sad.a.i !== match.holderAid) return false;
  return true;
}

/**
 * Find the wallet's steward credential for the community, or `null` when it
 * holds none. Returns the first match — v1 issues one Membership per member.
 */
export function findStewardCredential(
  creds: readonly HeldCredential[],
  match: StewardMatch,
): HeldCredential | null {
  return creds.find((c) => isStewardCredential(c, match)) ?? null;
}

/**
 * The app role an IDSS steward (`role: operator`) holds in the app. The gateway
 * knows two membership roles, operator and member, and the operator is the
 * community's steward with every steward power (idss #1876, Ben 2026-09-25:
 * the app's steward role matches the panel's operator). Mapped to the app's
 * most-privileged community role so every steward surface (pending
 * registrations, approve/decline, member management) opens for them.
 */
export const IDSS_STEWARD_APP_ROLE = 'Founding Member';
