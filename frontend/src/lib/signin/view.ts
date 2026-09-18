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
  /** The single-match credential line, or null when nothing matches. */
  credential: CredentialToShow | null;
  /** The details disclosure — never on the face. */
  details: {
    aid: string;
    credentialSaid: string;
    challengeId: string;
    boundMessage: string;
  };
}

/** Build the card view model. `aid` is the signing member's AID. */
export function buildCardView(
  ask: SigninAsk,
  credential: CredentialToShow | null,
  aid: string,
  isHome: boolean,
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
