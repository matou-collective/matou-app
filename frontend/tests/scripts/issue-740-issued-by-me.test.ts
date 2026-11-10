/**
 * Issue #740 — the wallet tagged a credential "Issued" (with a "To:" line)
 * whenever its recipient was someone other than me, never checking that I was
 * the issuer. A Founding Member credential issued *to* another member and
 * surfaced in the wallet was therefore mislabelled as issued by me.
 *
 * The fix: a credential is "Issued" only when I am its issuer
 * (`issuerAid === myAid`); everything else is "Received".
 */
import { describe, it, expect } from 'vitest';
import { isIssuedByMe, type WalletCredential } from 'src/lib/walletCredential';

const ME = 'EME000000000000000000000000000000000000000000';
const OTHER = 'EOTHER00000000000000000000000000000000000000';
const BEN = 'EBEN0000000000000000000000000000000000000000';

function cred(issuerAid: string, issueeAid: string): Pick<WalletCredential, 'issuerAid' | 'issueeAid'> {
  return { issuerAid, issueeAid };
}

describe('isIssuedByMe (#740)', () => {
  it('is true only when I am the issuer', () => {
    expect(isIssuedByMe(cred(ME, OTHER), ME)).toBe(true);
    expect(isIssuedByMe(cred(ME, ME), ME)).toBe(true);
  });

  it('is false when someone else issued the credential, even to a third party', () => {
    // The reported case: a credential issued by someone else to Ben, showing in
    // my wallet — must NOT be labelled "Issued" just because Ben isn't me.
    expect(isIssuedByMe(cred(OTHER, BEN), ME)).toBe(false);
    // Issued by someone else to me (the common "Received" case).
    expect(isIssuedByMe(cred(OTHER, ME), ME)).toBe(false);
  });

  it('is false when my AID is unknown', () => {
    expect(isIssuedByMe(cred(ME, OTHER), '')).toBe(false);
  });
});
