/**
 * Choosing, describing and trimming the presented credential (idss #1492
 * stories 13/14, ADR 0236 §2). The single-match line names kind, role and
 * issue date; the export is trimmed to the ACDC and its iss, dropping the KEL
 * noise the door reads from the witnessed ledger itself.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  chooseCredential,
  describeCredential,
  credentialCard,
  askedCredentialName,
  credentialSpokenName,
  ADMINISTRATOR_SLUG,
  trimPresentation,
  formatIssueDate,
  type HeldCredential,
} from 'src/lib/signin/credential';
import golden from './fixtures/app-door/app-door-golden.json';
import { NO_CREDENTIAL_TEXT, normalizeRefusal } from 'src/lib/signin/refusal';
import { parseSigninLink } from 'src/lib/signin/link';
import { asTheDoorReadThem, rememberRevoked, forgetRevoked, clearRevokedMemory } from 'src/lib/signin/revokedMemory';

// What a door said of one credential must never leak into the next test.
beforeEach(() => {
  clearRevokedMemory();
});

const MEMBERSHIP = 'EMembershipSchemaSAID';
const HOLDER = 'EHolderAID';

const membershipCred: HeldCredential = {
  sad: { d: 'ECredSAID', s: MEMBERSHIP, i: 'EIssuer', a: { i: HOLDER, role: 'Member', dt: '2026-08-12T00:00:00Z' } },
};

describe('chooseCredential', () => {
  it('picks the credential of the asked schema held by this member', () => {
    const other: HeldCredential = { sad: { d: 'EOther', s: 'EOtherSchema', a: { i: HOLDER } } };
    expect(chooseCredential([other, membershipCred], [MEMBERSHIP], HOLDER)).toBe(membershipCred);
  });

  it('does not present a credential issued to someone else', () => {
    const someoneElse: HeldCredential = { sad: { d: 'EX', s: MEMBERSHIP, a: { i: 'ESomeoneElse' } } };
    expect(chooseCredential([someoneElse], [MEMBERSHIP], HOLDER)).toBeUndefined();
  });

  it('falls back to the first credential when the ask names no schema', () => {
    expect(chooseCredential([membershipCred], [], HOLDER)).toBe(membershipCred);
  });

  it('returns undefined when nothing matches the asked schema', () => {
    expect(chooseCredential([membershipCred], ['ENope'], HOLDER)).toBeUndefined();
  });

  // A revoked credential is never presented, whether or not the door named the
  // credential it asks for (#687).
  it('passes over a revoked Membership for the live one issued after it', () => {
    const revoked: HeldCredential = {
      sad: { d: 'ERevokedMembership', s: MEMBERSHIP, a: { i: HOLDER } },
      status: { s: '1', et: 'rev' },
    };
    expect(chooseCredential([revoked, membershipCred], [MEMBERSHIP], HOLDER)).toBe(membershipCred);
  });

  it('presents nothing when the only Membership held is revoked', () => {
    const revoked: HeldCredential = { ...membershipCred, status: { s: '1', et: 'rev' } };
    expect(chooseCredential([revoked], [MEMBERSHIP], HOLDER)).toBeUndefined();
  });
});

// The credential the door NAMES (#683, idss ADR 0289). The control panel asks
// for Administrator by its definition slug, which a committee ACDC carries as
// `a.committee`; the schema is shared with every komiti credential, so picking
// "the first credential of an asked schema" would present the wrong one.
const COMMITTEE = 'ECommitteeSchemaSAID';
const PANEL_SCHEMAS = [COMMITTEE, MEMBERSHIP];

const financeCred: HeldCredential = {
  sad: { d: 'EFinanceSAID', s: COMMITTEE, i: 'EIssuer', a: { i: HOLDER, committee: 'finance', dt: '2026-09-01T00:00:00Z' } },
};
const administratorCred: HeldCredential = {
  sad: {
    d: 'EAdministratorSAID',
    s: COMMITTEE,
    i: 'EIssuer',
    a: { i: HOLDER, committee: 'administrator', communityName: 'Whakatōhea', dt: '2026-09-28T00:00:00Z' },
  },
  // The standing the agent returns beside a live credential.
  status: { s: '0', et: 'iss' },
};

describe('chooseCredential — the credential the door names (#683)', () => {
  it.each([
    ['Membership, Finance, Administrator', [membershipCred, financeCred, administratorCred]],
    ['Administrator, Finance, Membership', [administratorCred, financeCred, membershipCred]],
    ['Finance, Administrator, Membership', [financeCred, administratorCred, membershipCred]],
  ])('presents Administrator whatever order the wallet holds them in (%s)', (_order, held) => {
    expect(chooseCredential(held, PANEL_SCHEMAS, HOLDER, 'administrator')).toBe(administratorCred);
  });

  it('never presents another komiti credential of the same schema', () => {
    expect(chooseCredential([financeCred, membershipCred], PANEL_SCHEMAS, HOLDER, 'administrator')).toBeUndefined();
  });

  it("never presents a member's Membership at the control panel's door", () => {
    // Only an operator's Membership is a fallback there; a Membership with any
    // other role is not presented, and its holder sees the no-credential screen.
    expect(chooseCredential([membershipCred], PANEL_SCHEMAS, HOLDER, 'administrator')).toBeUndefined();
    expect(chooseCredential([financeCred, membershipCred], PANEL_SCHEMAS, HOLDER, 'administrator')).toBeUndefined();
  });

  it('does not present an Administrator issued to someone else', () => {
    const someoneElses: HeldCredential = {
      sad: { d: 'EX', s: COMMITTEE, a: { i: 'ESomeoneElse', committee: 'administrator' } },
    };
    expect(chooseCredential([someoneElses], PANEL_SCHEMAS, HOLDER, 'administrator')).toBeUndefined();
  });

  it('does not present a named credential held on a schema the door did not ask for', () => {
    const offSchema: HeldCredential = {
      sad: { d: 'EY', s: 'ESomeOtherSchema', a: { i: HOLDER, committee: 'administrator' } },
    };
    expect(chooseCredential([offSchema], PANEL_SCHEMAS, HOLDER, 'administrator')).toBeUndefined();
  });

  it('passes over a revoked Administrator for the live one issued after it', () => {
    const revoked: HeldCredential = {
      sad: { d: 'ERevokedSAID', s: COMMITTEE, a: { i: HOLDER, committee: 'administrator' } },
      status: { s: '1', et: 'rev' },
    };
    expect(chooseCredential([revoked, administratorCred], PANEL_SCHEMAS, HOLDER, 'administrator')).toBe(
      administratorCred,
    );
    expect(chooseCredential([revoked], PANEL_SCHEMAS, HOLDER, 'administrator')).toBeUndefined();
  });

  it.each([
    ['the event type alone', { et: 'rev' }],
    ['the sequence number alone', { s: '1' }],
  ])('reads a credential as revoked from %s', (_case, status) => {
    const revoked: HeldCredential = { sad: administratorCred.sad, status };
    expect(chooseCredential([revoked], PANEL_SCHEMAS, HOLDER, 'administrator')).toBeUndefined();
  });

  it('presents a credential whose standing the agent did not return', () => {
    // No status is not a revocation: the door makes the final check.
    const unread: HeldCredential = { sad: administratorCred.sad };
    expect(chooseCredential([unread], PANEL_SCHEMAS, HOLDER, 'administrator')).toBe(unread);
  });

  // The one fallback (#683 as amended, Ben 2026-09-28; app-door-golden
  // `panel.administrator.wallet_rule`): at the control panel's door a wallet
  // holding no Administrator presents its Membership when that Membership's
  // role is `operator` — the founding operator and any steward still on the
  // legacy role, whom the gateway admits on it until idss #1956 retires `role`.
  describe('the operator Membership fallback at the control panel', () => {
    const operatorCred: HeldCredential = {
      sad: {
        d: 'EOperatorSAID',
        s: MEMBERSHIP,
        i: 'EIssuer',
        a: { i: HOLDER, role: 'operator', dt: '2026-08-01T00:00:00Z' },
      },
      status: { s: '0', et: 'iss' },
    };

    it.each([
      ['alone', [operatorCred]],
      ['after a komiti credential', [financeCred, operatorCred]],
      ['before a komiti credential', [operatorCred, financeCred]],
    ])('presents the operator Membership when no Administrator is held (%s)', (_case, held) => {
      expect(chooseCredential(held, PANEL_SCHEMAS, HOLDER, 'administrator')).toBe(operatorCred);
    });

    it.each([
      ['Membership first', [operatorCred, financeCred, administratorCred]],
      ['Administrator first', [administratorCred, operatorCred]],
    ])('presents Administrator when both are held (%s)', (_case, held) => {
      expect(chooseCredential(held, PANEL_SCHEMAS, HOLDER, 'administrator')).toBe(administratorCred);
    });

    it('reads the role as the rest of the app does — whatever its case', () => {
      const shouted: HeldCredential = { sad: { ...operatorCred.sad, a: { ...operatorCred.sad!.a, role: 'Operator' } } };
      expect(chooseCredential([shouted], PANEL_SCHEMAS, HOLDER, 'administrator')).toBe(shouted);
    });

    it('is for administrator only — any other named credential is that credential or nothing', () => {
      expect(chooseCredential([operatorCred], PANEL_SCHEMAS, HOLDER, 'finance')).toBeUndefined();
      expect(chooseCredential([operatorCred, financeCred], PANEL_SCHEMAS, HOLDER, 'finance')).toBe(financeCred);
    });

    it('never falls back to another komiti credential, even one that claims the role', () => {
      const komitiClaimingRole: HeldCredential = {
        sad: { d: 'EZ', s: COMMITTEE, a: { i: HOLDER, committee: 'finance', role: 'operator' } },
      };
      expect(chooseCredential([komitiClaimingRole], PANEL_SCHEMAS, HOLDER, 'administrator')).toBeUndefined();
    });

    it("does not present an operator Membership of a schema the door did not ask for, or someone else's", () => {
      const offSchema: HeldCredential = { sad: { ...operatorCred.sad, s: 'ESomeOtherSchema' } };
      const someoneElses: HeldCredential = {
        sad: { ...operatorCred.sad, a: { ...operatorCred.sad!.a, i: 'ESomeoneElse' } },
      };
      expect(chooseCredential([offSchema, someoneElses], PANEL_SCHEMAS, HOLDER, 'administrator')).toBeUndefined();
    });

    it('passes over a revoked operator Membership', () => {
      const revoked: HeldCredential = { ...operatorCred, status: { s: '1', et: 'rev' } };
      expect(chooseCredential([revoked], PANEL_SCHEMAS, HOLDER, 'administrator')).toBeUndefined();
    });

  });

  // The wallet's own values, held against the contract the door is built to.
  describe('the wire contract (golden)', () => {
    it('names the slug the door sends, and the words the door expects the member to be told', () => {
      expect(ADMINISTRATOR_SLUG).toBe(golden.panel.administrator.adds_to_ask_response.credential);
      expect(golden.panel.administrator.wallet_rule).toContain(`"${NO_CREDENTIAL_TEXT}"`);
      expect(golden.panel.administrator.wallet_rule).toContain('`a.role` is `operator`');
    });

    it("reads the door's own control-panel code", () => {
      const ask = parseSigninLink(golden.panel.challenge.deep_link);
      expect(ask?.credential).toBe(ADMINISTRATOR_SLUG);
      expect(ask?.offer).toBe(golden.panel.challenge.adds_to_ask_response.offer);
      // …an unlock asks for the same credential: one door, one ask.
      expect(parseSigninLink(golden.unlock_hop.challenge.deep_link)?.credential).toBe(ADMINISTRATOR_SLUG);
      // …and the ordinary service code names no credential.
      expect(parseSigninLink(golden.ask.response.deep_link)).not.toHaveProperty('credential');
    });

    it("knows the door's no-credential refusal by its slug", () => {
      expect(normalizeRefusal(golden.present.no_credential.body.refusal)).toBe('no-credential');
    });

    it('is byte-for-byte the file idss holds', () => {
      // sha256 over the vendored file's own bytes: idss
      // `internal/idp/testdata/app-door-golden.json` @ 71c2edad (idss #1994, on
      // idss main). The copy adds nothing and changes nothing — not a note, not
      // a newline — so re-vendoring is `cp` and this digest; editing the copy by
      // hand fails here (#688).
      const bytes = readFileSync(new URL('./fixtures/app-door/app-door-golden.json', import.meta.url));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(
        'f77bdcf66d5ed306cac662624635cdfeaf9e0e12c2d2bac2bbe2b07f0117b6bb',
      );
      expect(golden).not.toHaveProperty('_copied_from');
    });
  });

  it('an ask that names no credential picks exactly as before — the first of an asked schema', () => {
    expect(chooseCredential([financeCred, membershipCred], [MEMBERSHIP], HOLDER)).toBe(membershipCred);
    expect(chooseCredential([financeCred, membershipCred], [MEMBERSHIP], HOLDER, undefined)).toBe(membershipCred);
    expect(chooseCredential([financeCred, membershipCred], [MEMBERSHIP], HOLDER, '')).toBe(membershipCred);
  });
});

// A credential the DOOR called revoked (#690). The door's answer is the witnessed
// ledger's; the agent's record of a held credential is as old as the day it was
// admitted, so a credential revoked since still reads as live there. What the
// door said is remembered of that one SAID, at that one sign-in site, and the
// credentials are read as that site read them before one is chosen — so it is
// passed over exactly as one the agent reads as revoked.
describe('chooseCredential — a credential the door called revoked (#690)', () => {
  const DOOR = 'https://id.example.nz/login';
  const operatorCred: HeldCredential = {
    sad: { d: 'EOperatorSAID', s: MEMBERSHIP, i: 'EIssuer', a: { i: HOLDER, role: 'operator' } },
    status: { s: '0', et: 'iss' },
  };
  /** The choice at DOOR, from the credentials as DOOR read them. */
  const chooseAtDoor = (held: readonly HeldCredential[], schemas: readonly string[], credential?: string) =>
    chooseCredential(asTheDoorReadThem(held, DOOR), schemas, HOLDER, credential);

  it('is presented until the door has said so — the agent reads it as live', () => {
    expect(chooseAtDoor([administratorCred, operatorCred], PANEL_SCHEMAS, 'administrator')).toBe(administratorCred);
  });

  it.each([
    ['Administrator first', [administratorCred, operatorCred]],
    ['Membership first', [operatorCred, financeCred, administratorCred]],
  ])("passes over it for the steward's Membership (%s)", (_order, held) => {
    rememberRevoked(DOOR, 'EAdministratorSAID');
    expect(chooseAtDoor(held, PANEL_SCHEMAS, 'administrator')).toBe(operatorCred);
  });

  it('passes over it for nothing when the holder is not a steward', () => {
    rememberRevoked(DOOR, 'EAdministratorSAID');
    expect(
      chooseAtDoor([administratorCred, financeCred, membershipCred], PANEL_SCHEMAS, 'administrator'),
    ).toBeUndefined();
  });

  it('passes over it for the live one issued after it', () => {
    const issuedAgain: HeldCredential = {
      sad: { ...administratorCred.sad, d: 'EAdministratorAgainSAID' },
      status: { s: '0', et: 'iss' },
    };
    rememberRevoked(DOOR, 'EAdministratorSAID');
    expect(chooseAtDoor([administratorCred, operatorCred, issuedAgain], PANEL_SCHEMAS, 'administrator')).toBe(
      issuedAgain,
    );
  });

  it('is presented again once it is read as live', () => {
    rememberRevoked(DOOR, 'EAdministratorSAID');
    forgetRevoked('EAdministratorSAID');
    expect(chooseAtDoor([administratorCred, operatorCred], PANEL_SCHEMAS, 'administrator')).toBe(administratorCred);
  });

  it('is what that one sign-in site said: at another site it is presented as the agent reads it', () => {
    rememberRevoked('https://id.other.nz/login', 'EAdministratorSAID');
    expect(chooseAtDoor([administratorCred, operatorCred], PANEL_SCHEMAS, 'administrator')).toBe(administratorCred);
  });

  it('is never read by the choice itself: what is chosen follows from the credentials it is given', () => {
    rememberRevoked(DOOR, 'EAdministratorSAID');
    expect(chooseCredential([administratorCred, operatorCred], PANEL_SCHEMAS, HOLDER, 'administrator')).toBe(
      administratorCred,
    );
  });

  describe('a Membership the door called revoked', () => {
    const laterOperator: HeldCredential = {
      sad: { ...operatorCred.sad, d: 'EOperatorLaterSAID' },
      status: { s: '0', et: 'iss' },
    };
    const laterMembership: HeldCredential = {
      sad: { ...membershipCred.sad, d: 'ECredLaterSAID' },
      status: { s: '0', et: 'iss' },
    };

    // The wallet still holds the revoked one — an agent lists every credential
    // it was ever issued — so the choice is made with both in hand.
    it.each([
      ['the revoked one first', [operatorCred, laterOperator]],
      ['the later one first', [laterOperator, operatorCred]],
    ])("at the control panel: the steward's later Membership is the fallback (%s)", (_order, held) => {
      rememberRevoked(DOOR, 'EOperatorSAID');
      expect(chooseAtDoor(held, PANEL_SCHEMAS, 'administrator')).toBe(laterOperator);
    });

    it('at the control panel: a steward whose only Membership it was has nothing to present', () => {
      rememberRevoked(DOOR, 'EOperatorSAID');
      expect(chooseAtDoor([operatorCred], PANEL_SCHEMAS, 'administrator')).toBeUndefined();
    });

    it.each([
      ['the revoked one first', [membershipCred, laterMembership]],
      ['the later one first', [laterMembership, membershipCred]],
      ['the revoked one first, among others', [financeCred, membershipCred, administratorCred, laterMembership]],
    ])("at a service's door: the later, live Membership is presented (%s)", (_order, held) => {
      rememberRevoked(DOOR, 'ECredSAID');
      expect(chooseAtDoor(held, [MEMBERSHIP])).toBe(laterMembership);
    });

    it("at a service's door: the agent's own reading is passed over the same way", () => {
      const revoked: HeldCredential = { ...membershipCred, status: { s: '1', et: 'rev' } };
      expect(chooseCredential([revoked, laterMembership], [MEMBERSHIP], HOLDER)).toBe(laterMembership);
      expect(chooseCredential([laterMembership, revoked], [MEMBERSHIP], HOLDER)).toBe(laterMembership);
    });

    it("at a service's door: when it is the only one held it is still presented, so the door says why", () => {
      rememberRevoked(DOOR, 'ECredSAID');
      expect(chooseAtDoor([membershipCred], [MEMBERSHIP])?.sad?.d).toBe('ECredSAID');
      expect(chooseAtDoor([financeCred, membershipCred], [MEMBERSHIP])?.sad?.d).toBe('ECredSAID');
    });
  });

  it('wears the revoked status on its card', () => {
    expect(credentialCard(administratorCred, {}).statusTone).toBe('healthy');
    rememberRevoked(DOOR, 'EAdministratorSAID');
    const card = credentialCard(asTheDoorReadThem([administratorCred], DOOR)[0]!, {});
    expect(card.statusTone).toBe('warning');
    expect(card.statusLabel).toBe(credentialCard({ ...administratorCred, status: { s: '1', et: 'rev' } }, {}).statusLabel);
    expect(card.statusLabel).toBe('Revoked');
  });
});

// What a credential is called in a sentence (#690) — the refusal that says
// which credential was revoked and which will be presented next.
describe('credentialSpokenName', () => {
  const kinds = { [MEMBERSHIP]: 'membership', [COMMITTEE]: 'committee' };

  it('calls a Membership by its kind, never by its schema title', () => {
    // As the agent returns it: the schema rides beside the credential.
    const asHeld: HeldCredential = { ...membershipCred, schema: { title: 'MATOU Membership Credential' } };
    expect(credentialSpokenName(asHeld, kinds)).toBe('Membership');
    expect(credentialSpokenName(membershipCred, kinds)).toBe('Membership');
    expect(credentialSpokenName(membershipCred, {})).toBe('Membership');
  });

  it('calls a komiti credential by its own name', () => {
    const asHeld: HeldCredential = { ...administratorCred, schema: { title: 'Committee Credential' } };
    expect(credentialSpokenName(asHeld, kinds)).toBe('Administrator');
    expect(credentialSpokenName(financeCred, kinds)).toBe('Finance');
  });

  it('uses the name its community gave it, when it gave one', () => {
    const named: HeldCredential = {
      sad: { ...administratorCred.sad, a: { ...administratorCred.sad!.a, display: { name: 'Kaiwhakahaere' } } },
    };
    expect(credentialSpokenName(named, kinds)).toBe('Kaiwhakahaere');
  });
});

describe('describeCredential — a named credential (#683)', () => {
  it('carries the slug of a komiti credential, and none for a Membership', () => {
    expect(describeCredential(administratorCred, {}).slug).toBe('administrator');
    expect(describeCredential(membershipCred, {}).slug).toBe('');
  });

  it('has one name for a credential — the name on its card', () => {
    const titled: HeldCredential = { ...membershipCred, schema: { title: 'Mātou Membership' } };
    const shown = describeCredential(titled, { [MEMBERSHIP]: 'membership' });
    expect(shown.name).toBe('Mātou Membership');
    expect(shown.name).toBe(shown.card.name);
    // The kind stays the kind, whatever the credential is called.
    expect(shown.kindLabel).toBe('Membership');
  });

  it('names a committee credential by its slug, not by its schema kind', () => {
    const shown = describeCredential(administratorCred, { [COMMITTEE]: 'committee', [MEMBERSHIP]: 'membership' });
    expect(shown.name).toBe('Administrator');
    expect(shown.said).toBe('EAdministratorSAID');
    expect(shown.issuedOn).toBe('28 Sep 2026');
  });

  it('prefers the name the community gave the credential in its display block', () => {
    const branded: HeldCredential = {
      sad: {
        ...administratorCred.sad,
        a: { ...administratorCred.sad!.a, display: { name: 'Kaiwhakahaere', background: '#1a4d3a' } },
      },
    };
    expect(describeCredential(branded, { [COMMITTEE]: 'committee' }).name).toBe('Kaiwhakahaere');
  });

  it('carries the card the approve screen draws, with the community from the ask', () => {
    const shown = describeCredential(membershipCred, { [MEMBERSHIP]: 'membership' }, 'Te Rūnanga o Example');
    expect(shown.card).toEqual(credentialCard(membershipCred, { [MEMBERSHIP]: 'membership' }, 'Te Rūnanga o Example'));
  });

  it('names a Membership as it always did', () => {
    expect(describeCredential(membershipCred, { [MEMBERSHIP]: 'membership' }).name).toBe('Membership');
  });
});

// The card the approve screen draws is the wallet's own credential card, so the
// model carries the wallet's fields: the mark and look, the name, the community
// and the issue date.
describe('credentialCard', () => {
  it('draws Administrator as the wallet does: name, slug, community, issue date, live', () => {
    const card = credentialCard(administratorCred, { [COMMITTEE]: 'committee' }, 'Te Whakatōhea');
    expect(card.name).toBe('Administrator');
    expect(card.tag).toBe('Received');
    expect(card.serviceName).toBe('administrator');
    // The community the credential itself names wins over the code's claim.
    expect(card.description).toBe('Whakatōhea');
    expect(card.footer).toBe('Issued 28 Sep 2026');
    expect(card.statusLabel).toBe('Active');
    expect(card.statusTone).toBe('healthy');
    expect(card.credential.said).toBe('EAdministratorSAID');
    expect(card.credential.committee).toBe('administrator');
  });

  it('carries the look the credential was issued with', () => {
    const branded: HeldCredential = {
      sad: {
        ...administratorCred.sad,
        a: { ...administratorCred.sad!.a, display: { name: 'Kaiwhakahaere', icon: 'shield', background: '#1a4d3a' } },
      },
    };
    const card = credentialCard(branded, {}, 'Whakatōhea');
    expect(card.name).toBe('Kaiwhakahaere');
    expect(card.credential.display).toEqual({ name: 'Kaiwhakahaere', icon: 'shield', background: '#1a4d3a' });
  });

  it('draws a Membership with its role and the community from the ask when the credential names none', () => {
    const card = credentialCard(membershipCred, { [MEMBERSHIP]: 'membership' }, 'Te Rūnanga o Example');
    expect(card.name).toBe('Membership');
    expect(card.subtitle).toBe('Member');
    expect(card.serviceName).toBe('');
    expect(card.description).toBe('Te Rūnanga o Example');
    expect(card.footer).toBe('Issued 12 Aug 2026');
  });

  // The approve card's contract names the issuer line (idss PU-A4,
  // `credential-issuer`), so the card always has one to draw (#688).
  it('names the community as the headline does when neither the credential nor the code names one', () => {
    expect(credentialCard(membershipCred, { [MEMBERSHIP]: 'membership' }).description).toBe('your community');
    expect(credentialCard(membershipCred, { [MEMBERSHIP]: 'membership' }, '  ').description).toBe('your community');
  });

  it('uses the schema title the agent holds, as the wallet card does', () => {
    const titled: HeldCredential = { ...membershipCred, schema: { title: 'Mātou Membership' } };
    expect(credentialCard(titled, { [MEMBERSHIP]: 'membership' }, 'Home').name).toBe('Mātou Membership');
  });

  it('marks a revoked credential', () => {
    const revoked: HeldCredential = { ...membershipCred, status: { s: '1', et: 'rev' } };
    const card = credentialCard(revoked, {}, 'Home');
    expect(card.statusLabel).toBe('Revoked');
    expect(card.statusTone).toBe('warning');
  });
});

// What the no-credential screen calls the thing the door asked for.
describe('askedCredentialName', () => {
  it('names the credential the door named by its slug', () => {
    expect(askedCredentialName('administrator', PANEL_SCHEMAS, { [COMMITTEE]: 'committee' })).toBe('Administrator');
    expect(askedCredentialName('finance-komiti', PANEL_SCHEMAS, {})).toBe('Finance Komiti');
  });

  it('names the kind of the first asked schema it knows when the door named none', () => {
    expect(askedCredentialName(undefined, [MEMBERSHIP], { [MEMBERSHIP]: 'membership' })).toBe('Membership');
    expect(askedCredentialName(undefined, ['EUnknown', MEMBERSHIP], { [MEMBERSHIP]: 'membership' })).toBe('Membership');
  });

  it('is blank when nothing on the ask can be named', () => {
    expect(askedCredentialName(undefined, ['EUnknown'], {})).toBe('');
    expect(askedCredentialName(undefined, [], {})).toBe('');
  });
});

describe('describeCredential', () => {
  it('names the kind, role and issue date', () => {
    const shown = describeCredential(membershipCred, { [MEMBERSHIP]: 'membership' });
    expect(shown).toMatchObject({
      said: 'ECredSAID',
      schema: MEMBERSHIP,
      kindLabel: 'Membership',
      name: 'Membership',
      role: 'Member',
      issuedOn: '12 Aug 2026',
    });
  });

  it('title-cases an unknown kind key and defaults when unmapped', () => {
    expect(describeCredential(membershipCred, { [MEMBERSHIP]: 'kaitiaki' }).kindLabel).toBe('Kaitiaki');
    expect(describeCredential(membershipCred, {}).kindLabel).toBe('Membership');
  });
});

describe('formatIssueDate', () => {
  it('formats an ISO date and tolerates junk', () => {
    expect(formatIssueDate('2026-08-12T09:30:00Z')).toBe('12 Aug 2026');
    expect(formatIssueDate('not-a-date')).toBe('');
    expect(formatIssueDate(undefined)).toBe('');
  });
});

// Build a CESR message whose version-string size field matches its byte length
// (KERI "sizeify"); replacing the 6-char placeholder keeps the length stable.
function sizeify(proto: 'ACDC' | 'KERI', fields: Record<string, unknown>): string {
  const withV = { v: `${proto}10JSON000000_`, ...fields };
  const size = new TextEncoder().encode(JSON.stringify(withV)).length;
  withV.v = `${proto}10JSON${size.toString(16).padStart(6, '0')}_`;
  return JSON.stringify(withV);
}

describe('trimPresentation', () => {
  const icp = sizeify('KERI', { t: 'icp', d: 'Eicp', i: 'Eissuer', s: '0' });
  const acdc = sizeify('ACDC', { d: 'Ecred', i: 'Eissuer', ri: 'Ereg', s: MEMBERSHIP, a: { i: HOLDER } });
  const iss = sizeify('KERI', { t: 'iss', d: 'Eiss', i: 'Ecred', s: '0', ri: 'Ereg' });

  it('keeps only the ACDC and its iss, dropping KEL messages', () => {
    const trimmed = trimPresentation(icp + acdc + iss + icp);
    expect(trimmed).toBe(acdc + iss);
  });

  it('returns the full stream unchanged when both messages are not found', () => {
    const onlyAcdc = icp + acdc;
    expect(trimPresentation(onlyAcdc)).toBe(onlyAcdc);
  });
});
