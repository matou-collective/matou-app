/**
 * Whether the wallet's identity is one of the community's stewards — the ONE
 * place the sign-in path reads it (#688; idss ADR 0282 as amended 2026-09-29,
 * ruling 3: "the wallet decides whether there is a seat to unlock").
 *
 * Being a steward is not a credential: it is membership of the community group
 * identity. Until idss #1956 removes the legacy `role`, the wallet reads it
 * where it still lives — **a held Membership whose `role` is `operator`**
 * ({@link STEWARD_ROLE}, ADR 0226). What replaces this reading is #1956's
 * concern; when it lands, it changes here and nowhere else.
 *
 * Two things hang off the answer, and nothing else does:
 *  - a control-panel sign-in whose code offers a seat unlock shows a steward the
 *    unlock line (PU-A2u), and shows anyone else the same card without it;
 *  - a code that says it is an unlock shows a steward the approve card in its
 *    unlock form (PU-A4), and tells anyone else they cannot (PU-A4n).
 *
 * It decides nothing about WHAT is presented — that is `chooseCredential`'s
 * rule (the golden's `panel.administrator.wallet_rule`), unchanged.
 */

import { credentialSlug, isOperatorMembership, type HeldCredential } from './credential';
import { STEWARD_ROLE } from 'src/lib/spaces/steward';

/**
 * True when the identity about to present is a steward.
 *
 * Nothing presented, no steward: there is no seat to unlock without a sign-in.
 *
 * When a **Membership** is presented, its own role decides, as it always did:
 * `operator` (case-insensitive) is a steward, and a second credential the wallet
 * also holds never lends it that standing. When a **komiti credential** is
 * presented — Administrator, at the control panel's door (#683, idss ADR 0289)
 * — the credential carries no role, and holding it makes nobody a steward (idss
 * ADR 0286 d.2): the standing is read off the member's own live operator
 * Membership of an asked schema.
 */
export function identityIsSteward(
  presented: HeldCredential | null,
  held: readonly HeldCredential[],
  schemas: readonly string[],
  holderAid: string,
): boolean {
  if (!presented) return false;
  if (!credentialSlug(presented)) {
    return (presented.sad?.a?.role ?? '').trim().toLowerCase() === STEWARD_ROLE;
  }
  return held.some((c) => isOperatorMembership(c, schemas, holderAid));
}
