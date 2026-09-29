/**
 * The approve card's view model (idss spec #1492 story 13, wireframe WS-A2).
 *
 * Pure: given a parsed ask, the chosen credential and whether the site is home,
 * it produces exactly what the card renders — service first, then the sign-in
 * site, then what will be shown — and the details disclosure's four lines. No
 * AID, SAID, nonce or words reach the face; those live only in `details`.
 *
 * One view serves the card's two forms (#688): the sign-in form (WS-A2, and
 * PU-A2u when the unlock line is offered) and the unlock form (PU-A4), which a
 * code that says it is an unlock opens. The form is the ask's; the view carries
 * what either draws.
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
   * True when the code is a control-panel one — it said what it offers (a seat
   * unlock, or an unlock). Read from the code's own offer field, never from the
   * display name in `service`.
   */
  panel: boolean;
  /**
   * Whether the steward-unlock line is offered (PU-A2u): true ONLY when the code
   * offers a seat unlock AND the wallet's identity is a steward; false on every
   * other card, which is therefore untouched. The line is on by default and is
   * the whole consent. The unlock form (PU-A4) has no line — it has no switch.
   */
  unlockLine: boolean;
  /**
   * PU-A4's WHERE line: "‹community›'s control panel". By name only — the code
   * carries no address for the panel, and none is derived from the sign-in
   * site's (the panel is not always `admin.` beside `id.`).
   */
  panelName: string;
  /** The details disclosure — never on the face. */
  details: {
    aid: string;
    credentialSaid: string;
    challengeId: string;
    boundMessage: string;
  };
}

/**
 * Build the card view model. `aid` is the signing member's AID. `unlockLine` is
 * whether the steward-unlock line is offered — true only when the code offers a
 * seat unlock and the wallet's identity is a steward (#663, #688); every
 * ordinary card passes false and is untouched. `askedName` is what the door
 * asked for, in words (see `askedCredentialName`).
 */
export function buildCardView(
  ask: SigninAsk,
  credential: CredentialToShow | null,
  aid: string,
  isHome: boolean,
  unlockLine = false,
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
    panel: ask.offer !== undefined,
    unlockLine,
    panelName: `${community}'s control panel`,
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
