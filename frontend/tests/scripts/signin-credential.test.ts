/**
 * Choosing, describing and trimming the presented credential (idss #1492
 * stories 13/14, ADR 0236 §2). The single-match line names kind, role and
 * issue date; the export is trimmed to the ACDC and its iss, dropping the KEL
 * noise the door reads from the witnessed ledger itself.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  chooseCredential,
  describeCredential,
  credentialCard,
  askedCredentialName,
  ADMINISTRATOR_SLUG,
  trimPresentation,
  formatIssueDate,
  type HeldCredential,
} from 'src/lib/signin/credential';
import golden from './fixtures/app-door/app-door-golden.json';
import { NO_CREDENTIAL_TEXT, normalizeRefusal } from 'src/lib/signin/refusal';
import { parseSigninLink } from 'src/lib/signin/link';

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
      expect(ask?.sealingKey).toBe(golden.panel.challenge.adds_to_ask_response.sealing_key);
      // …and the ordinary service code names no credential.
      expect(parseSigninLink(golden.ask.response.deep_link)).not.toHaveProperty('credential');
    });

    it("knows the door's no-credential refusal by its slug", () => {
      expect(normalizeRefusal(golden.present.no_credential.body.refusal)).toBe('no-credential');
    });

    it('is the file idss holds at the commit it names', () => {
      // sha256 over the contract's JSON with keys sorted (its content, not its
      // whitespace), less the `_copied_from` note this copy adds. Re-vendoring
      // the golden means updating both the note and this digest; editing the
      // copy by hand fails here.
      const { _copied_from: copiedFrom, ...contract } = golden as Record<string, unknown>;
      expect(copiedFrom).toContain('@ af7ba1db');
      expect(createHash('sha256').update(canonical(contract)).digest('hex')).toBe(
        '911eeadd6f346d6439b35fb0bea9a9bd7c9825921302dca57e69a88621c6efa7',
      );
    });
  });

  it('an ask that names no credential picks exactly as before — the first of an asked schema', () => {
    expect(chooseCredential([financeCred, membershipCred], [MEMBERSHIP], HOLDER)).toBe(membershipCred);
    expect(chooseCredential([financeCred, membershipCred], [MEMBERSHIP], HOLDER, undefined)).toBe(membershipCred);
    expect(chooseCredential([financeCred, membershipCred], [MEMBERSHIP], HOLDER, '')).toBe(membershipCred);
  });
});

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

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
