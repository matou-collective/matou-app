/**
 * The steward-credential check (issue #534, ADR 0226 ruling). "Holds a steward
 * credential" = a held Membership credential from community.aid whose role is
 * operator (and, when known, issued to this member). No such credential → the
 * wallet creates nothing (AC3).
 */
import { describe, it, expect } from 'vitest';
import { findStewardCredential, isStewardCredential, STEWARD_ROLE } from 'src/lib/spaces/steward';
import type { HeldCredential } from 'src/lib/signin/credential';

const COMMUNITY = 'ECommunityGroupAID000000000000000000000000000';
const MEMBERSHIP = 'EMembershipSchemaSAID00000000000000000000000';
const ME = 'EOperatorBenAID00000000000000000000000000000';

function cred(over: Partial<{ i: string; s: string; role: string; issuee: string; d: string }> = {}): HeldCredential {
  return {
    sad: {
      d: over.d ?? 'ECredSAID',
      i: over.i ?? COMMUNITY,
      s: over.s ?? MEMBERSHIP,
      a: { i: over.issuee ?? ME, role: over.role ?? 'operator' },
    },
  };
}

const match = { communityAid: COMMUNITY, membershipSchema: MEMBERSHIP, holderAid: ME };

describe('isStewardCredential', () => {
  it('accepts a Membership credential from community.aid with role operator', () => {
    expect(isStewardCredential(cred(), match)).toBe(true);
  });

  it('is case-insensitive on the role', () => {
    expect(isStewardCredential(cred({ role: 'Operator' }), match)).toBe(true);
    expect(STEWARD_ROLE).toBe('operator');
  });

  it('rejects a plain member (role: member)', () => {
    expect(isStewardCredential(cred({ role: 'member' }), match)).toBe(false);
  });

  it('rejects a credential from a different issuer', () => {
    expect(isStewardCredential(cred({ i: 'ESomeOtherIssuer' }), match)).toBe(false);
  });

  it('rejects a credential of the wrong schema when a membership schema is named', () => {
    expect(isStewardCredential(cred({ s: 'ECommitteeSchema' }), match)).toBe(false);
  });

  it('rejects someone else\'s credential when the holder is known', () => {
    expect(isStewardCredential(cred({ issuee: 'ESomeoneElse' }), match)).toBe(false);
  });

  it('never matches on a blank community AID', () => {
    expect(isStewardCredential(cred(), { ...match, communityAid: '' })).toBe(false);
  });

  it('tolerates an unknown holder/schema (the door makes the final check)', () => {
    expect(isStewardCredential(cred(), { communityAid: COMMUNITY })).toBe(true);
  });
});

describe('findStewardCredential', () => {
  it('finds the steward credential among the wallet\'s held credentials', () => {
    const held = [cred({ role: 'member', d: 'Emember' }), cred({ d: 'Eoperator' })];
    expect(findStewardCredential(held, match)?.sad?.d).toBe('Eoperator');
  });

  it('returns null when the wallet holds no steward credential (AC3)', () => {
    const held = [cred({ role: 'member' }), cred({ i: 'EOther' })];
    expect(findStewardCredential(held, match)).toBeNull();
  });
});
