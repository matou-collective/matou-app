/**
 * The Approve action, as a pure orchestration (idss spec #1492 story 14, ADR
 * 0236 §2). Sign the door-bound message over the site's address, export the
 * credential and its issuance event, and post the answer to the site's present
 * route. Split out from the composable so the whole sign → export → post → verdict
 * path is unit-testable with fakes and never needs signify-ts or a live door.
 */

import { boundMessage, type PresentBody, type PresentVerdict } from './present';
import { trimPresentation } from './credential';

/** Everything Approve needs, resolved by the composable (or faked in tests). */
export interface ApproveInput {
  /** The sign-in site address the signature binds to (never posted to). */
  door: string;
  /** The URL to POST the presentation to (the ask's `present_url`, verbatim). */
  present: string;
  /** The challenge id / nonce. */
  challenge: string;
  /** The signing (holder) AID. */
  aid: string;
  /** The SAID of the credential to present. */
  credentialSaid: string;
  /**
   * The steward's passcode already sealed to the control-panel tab's sealing key
   * (a CESR qb64 `X25519_Cipher_Salt` cipher), when this is a control-panel
   * unlock with the line on. Posted verbatim as `sealed_passcode`; omitted (and
   * the field never appears on the wire) on every ordinary sign-in (#663).
   */
  sealedPasscode?: string;
}

/** The side-effecting dependencies, injected for testability. */
export interface ApproveDeps {
  /** Sign a UTF-8 message, returning the qb64 signature (the cached signer). */
  sign(message: string): Promise<string>;
  /** Export the credential's full `includeCESR` stream by SAID. */
  exportCredential(said: string): Promise<string>;
  /** POST the presentation to a URL and read the door's verdict. */
  present(presentUrl: string, body: PresentBody): Promise<PresentVerdict>;
}

/**
 * Run Approve: export + trim the credential, sign the bound message, post, and
 * return the door's verdict. Throws only on a genuine wallet-side failure
 * (missing signature, export error); a door refusal or an unreachable site is a
 * {@link PresentVerdict}, not an exception.
 */
export async function runApprove(input: ApproveInput, deps: ApproveDeps): Promise<PresentVerdict> {
  const { door, present, challenge, aid, credentialSaid, sealedPasscode } = input;

  // Export the full stream, then trim to the ACDC + iss the door reads. The
  // door also accepts the full stream, so a trim that cannot find both messages
  // falls back to the whole export (trimPresentation).
  const full = await deps.exportCredential(credentialSaid);
  const presentation = trimPresentation(full);

  // Sign over the DOOR (the sign-in site's own address), but POST to the ask's
  // `present_url` — the two need not share a path, and the URL is never derived.
  const response = await deps.sign(boundMessage(door, aid, challenge));

  const body: PresentBody = { aid, challenge_id: challenge, response, presentation };
  // The sealed passcode rides the ONE present request on a panel unlock; on an
  // ordinary sign-in it is absent, so the field never appears on the wire.
  if (sealedPasscode) body.sealed_passcode = sealedPasscode;

  return deps.present(present, body);
}
