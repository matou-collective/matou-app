/**
 * Membership is recognised against the schema the descriptor names, not the
 * hardcoded Mātou schema (issue #615).
 *
 * A founder holding the community's OWN Membership credential — of the schema
 * the descriptor names in `schemas.membership.said`, issued by `community.aid`
 * to their AID — must be recognised as a member (routed to the welcome/
 * dashboard path), not stranded on "Your application is being reviewed". The
 * previous checks matched only the coa-shared Mātou schema SAID, so a correctly
 * issued IDSS credential never counted.
 *
 * These assert the pure predicate that drives the routing (SplashScreen /
 * WelcomeOverlay call `hasMembershipCredential` with the descriptor-resolved
 * schema) and the descriptor resolver that feeds it — no live descriptor or
 * KERIA needed.
 */
import { describe, it, expect } from 'vitest';
import type { HeldCredential } from '../../src/lib/signin/credential';
import { hasMembershipCredential, isMembershipCredential } from '../../src/lib/membership';
import {
  membershipSchemaSaid,
  MATOU_MEMBERSHIP_SCHEMA_SAID,
  parseDescriptor,
} from '../../src/lib/descriptor';

// The kept whakatohea-demo IDSS community's Membership schema + community AID.
const IDSS_MEMBERSHIP_SCHEMA = 'IBpju1vRXOpF3gG-PXOdkeseqsqr0uD1ut7YN5538x9t';
const COMMUNITY_AID = 'ECommunityGroupAID00000000000000000000000000';
const FOUNDER_AID = 'EFounderPersonalAID0000000000000000000000000';

function membershipCred(opts: { schema: string; issuer: string; holder: string }): HeldCredential {
  return {
    sad: {
      d: 'ECredentialSAID000000000000000000000000000000',
      s: opts.schema,
      i: opts.issuer,
      a: { i: opts.holder, role: 'operator', dt: '2026-09-01T00:00:00Z' },
    },
  };
}

describe('membership recognition against the descriptor schema (#615)', () => {
  it('recognises the founder\'s community-schema credential as membership', () => {
    const creds = [
      membershipCred({ schema: IDSS_MEMBERSHIP_SCHEMA, issuer: COMMUNITY_AID, holder: FOUNDER_AID }),
    ];
    // Routes to welcome/dashboard, not pending-approval.
    expect(
      hasMembershipCredential(creds, {
        membershipSchema: IDSS_MEMBERSHIP_SCHEMA,
        holderAid: FOUNDER_AID,
        communityAid: COMMUNITY_AID,
      }),
    ).toBe(true);
  });

  it('does NOT count a Mātou-schema credential when the descriptor names its own schema', () => {
    // The exact bug: matching only the hardcoded Mātou schema. A wallet holding
    // ONLY a Mātou-schema credential must not satisfy an IDSS membership check.
    const creds = [
      membershipCred({ schema: MATOU_MEMBERSHIP_SCHEMA_SAID, issuer: COMMUNITY_AID, holder: FOUNDER_AID }),
    ];
    expect(
      hasMembershipCredential(creds, {
        membershipSchema: IDSS_MEMBERSHIP_SCHEMA,
        holderAid: FOUNDER_AID,
      }),
    ).toBe(false);
  });

  it('does NOT count a credential issued to someone else', () => {
    const creds = [
      membershipCred({ schema: IDSS_MEMBERSHIP_SCHEMA, issuer: COMMUNITY_AID, holder: 'ESomeoneElse' }),
    ];
    expect(
      isMembershipCredential(creds[0]!, {
        membershipSchema: IDSS_MEMBERSHIP_SCHEMA,
        holderAid: FOUNDER_AID,
      }),
    ).toBe(false);
  });

  it('does NOT count a credential issued by a different community when the issuer is checked', () => {
    const creds = [
      membershipCred({ schema: IDSS_MEMBERSHIP_SCHEMA, issuer: 'EOtherCommunityAID', holder: FOUNDER_AID }),
    ];
    expect(
      isMembershipCredential(creds[0]!, {
        membershipSchema: IDSS_MEMBERSHIP_SCHEMA,
        holderAid: FOUNDER_AID,
        communityAid: COMMUNITY_AID,
      }),
    ).toBe(false);
  });

  it('resolves the descriptor schema for an IDSS descriptor', () => {
    const d = parseDescriptor({
      version: '1.1',
      backend_kind: 'idss',
      community: { aid: COMMUNITY_AID },
      admins: [],
      schemas: {
        membership: {
          said: IDSS_MEMBERSHIP_SCHEMA,
          oobi: `https://schema.whakatohea.idss.nz/oobi/${IDSS_MEMBERSHIP_SCHEMA}`,
        },
      },
    });
    expect(membershipSchemaSaid(d)).toBe(IDSS_MEMBERSHIP_SCHEMA);
  });

  it('falls back to the Mātou constant for a coa-shared descriptor with no schemas block', () => {
    const d = parseDescriptor({ version: '1.0', backend_kind: '', admins: [] });
    expect(membershipSchemaSaid(d)).toBe(MATOU_MEMBERSHIP_SCHEMA_SAID);
  });
});
