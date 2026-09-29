/**
 * The approve card's view model (idss spec #1492 story 13, wireframe WS-A2).
 *
 * Pure: given a parsed ask, the chosen credential and whether the site is home,
 * it produces exactly what the card renders — service first, then the sign-in
 * site, then what will be shown — and the details disclosure's four lines. No
 * AID, SAID, nonce or words reach the face; those live only in `details`.
 */

import { boundMessage } from './present';
import type { CredentialToShow } from './credential';
import type { SigninAsk } from './link';

/** The whole approve-card face plus its details disclosure (WS-A2). */
export interface ApproveCardView {
  /** Headline: "Sign in to ‹service› at ‹community›?" */
  service: string;
  community: string;
  /** Site line: "‹community›'s sign-in site · ‹address›". */
  siteName: string;
  siteAddress: string;
  /** True → the "your community" chip and no first-contact (home site). */
  isHome: boolean;
  /** The credential that will be presented — drawn as its card, with Approve
   *  at the card's foot (#683) — or null when the wallet holds none that match. */
  credential: CredentialToShow | null;
  /**
   * What the door asked for, in words ("Administrator", "Membership"), for the
   * no-credential screen (#683). Blank when the ask can be given no name.
   */
  askedName: string;
  /** The one honest line shown while proving (WS-A2p): what is being proved is
   *  what is being presented. */
  provingLine: string;
  /**
   * The steward-unlock region (PU-A2u, #663), present ONLY when the sign-in is
   * to the control panel AND the member presenting is a steward; null on every
   * other card, which is therefore untouched. When present, the card shows the unlock line (default on) under the headline, and
   * the sealing-key fingerprint inside the details disclosure — never the face.
   */
  unlock: {
    /** The tab's sealing-key fingerprint (`xxxx·xxxx`), shown in details only so
     *  a careful steward can compare it with what the panel shows. */
    sealingKeyFingerprint: string;
  } | null;
  /** The details disclosure — never on the face. */
  details: {
    aid: string;
    credentialSaid: string;
    challengeId: string;
    boundMessage: string;
  };
}

/**
 * Build the card view model. `aid` is the signing member's AID. `unlock` is the
 * steward-unlock region (or null) — supplied only when the sign-in is to the
 * control panel and the member presenting is a steward (#663);
 * every ordinary card passes null and is untouched. `askedName` is what the
 * door asked for, in words (see `askedCredentialName`).
 */
export function buildCardView(
  ask: SigninAsk,
  credential: CredentialToShow | null,
  aid: string,
  isHome: boolean,
  unlock: ApproveCardView['unlock'] = null,
  askedName = '',
): ApproveCardView {
  const community = ask.community || 'your community';
  return {
    // The real bridge always names the service; a link that omits it keeps the
    // sentence grammatical rather than dropping a blank into the headline.
    service: ask.service || 'the service',
    community,
    siteName: `${community}'s sign-in site`,
    siteAddress: siteAddress(ask.door),
    isHome,
    credential,
    askedName,
    // Say what is being proved: a komiti credential such as Administrator is
    // its holder's to show whether or not they are a member (idss ADR 0289); a
    // Membership — the operator's fallback at the panel included — proves
    // membership, as it always did.
    provingLine: credential?.slug ? `Proving you hold ${credential.name}…` : "Proving you're a member…",
    unlock,
    details: {
      aid,
      credentialSaid: credential?.said ?? '',
      challengeId: ask.challenge,
      boundMessage: boundMessage(ask.door, aid, ask.challenge),
    },
  };
}

/** The host of the door URL for the site line ("id.example.nz"); the raw door
 * when it does not parse as a URL. */
export function siteAddress(door: string): string {
  try {
    return new URL(door).host || door;
  } catch {
    return door;
  }
}

/**
 * The unlock-only card's view model (idss #1929 story 14, wireframe PU-A4;
 * matou-app #664). Distinct from {@link ApproveCardView} by design: no service,
 * no credential, no bound message — nothing is presented and no session is
 * minted. The card carries the unlock and only the unlock. The FRESH sealing-key
 * fingerprint rides the details disclosure so a careful steward can compare it
 * with the panel's; it differs from the one at sign-in by construction.
 */
export interface UnlockCardView {
  /** The community name for the WHERE line ("your community" when absent). */
  community: string;
  /** "‹community›'s control panel" — the WHERE line's name half. */
  panelName: string;
  /** The panel site's host ("admin.example.nz") — the WHERE line's address. */
  panelAddress: string;
  /** The "ALREADY SIGNED IN" note, naming the sign-in time when the code carried
   *  one, and always saying this only unlocks steward actions. */
  signedInNote: string;
  /** The details disclosure — never on the face. */
  details: {
    aid: string;
    challengeId: string;
    /** The FRESH sealing-key fingerprint (`xxxx·xxxx`), for a careful compare. */
    sealingKeyFingerprint: string;
  };
}

/**
 * Build the unlock-only card view model. `aid` is the steward's own AID; `panel`,
 * `community`, `challenge` and `signedInAt` come off the unlock ask, and
 * `sealingKeyFingerprint` is the precomputed fingerprint of the fresh `ek`
 * (computed by the composable, which owns libsodium). A blank `signedInAt`
 * degrades the note to a timeless sentence rather than dropping a blank time in.
 */
export function buildUnlockView(
  panel: string,
  community: string,
  challenge: string,
  aid: string,
  signedInAt: string,
  sealingKeyFingerprint: string,
): UnlockCardView {
  const name = community || 'your community';
  const signedInNote = signedInAt
    ? `You signed in on this computer at ${signedInAt}. This only unlocks steward actions.`
    : "You're already signed in on this computer. This only unlocks steward actions.";
  return {
    community: name,
    panelName: `${name}'s control panel`,
    panelAddress: siteAddress(panel),
    signedInNote,
    details: {
      aid,
      challengeId: challenge,
      sealingKeyFingerprint,
    },
  };
}
