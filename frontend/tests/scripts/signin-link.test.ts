/**
 * The `matou://signin?…` link parser (idss #1492 story 4/10, app-door-golden
 * `deep_link_params`). Reads the site address, the `present` URL, challenge,
 * schema(s), community and service; tolerates the missing service the prototype
 * omitted; and rejects anything that is not a well-formed sign-in link —
 * including a link with no `present`, which is a door this app cannot answer, so
 * it is refused rather than answered by guessing a path (#574).
 */
import { describe, it, expect } from 'vitest';
import {
  parseSigninLink,
  signinAskFromQuery,
  isSigninLink,
  offersSeatUnlock,
  isUnlockAsk,
  OFFER_PARAM,
  OFFER_SEAT_UNLOCK,
  OFFER_UNLOCK,
} from 'src/lib/signin/link';
import golden from './fixtures/app-door/app-door-golden.json';

const PRESENT = 'https%3A%2F%2Fid.example.nz%2Flogin%2Fapp%2Fpresent';
const LINK =
  'matou://signin?door=https%3A%2F%2Fid.example.nz%2Flogin&present=' +
  PRESENT +
  '&c=c_3f9abc&s=EMe7Qzr&name=Te%20R%C5%ABnanga%20o%20Example&service=Files';

describe('parseSigninLink', () => {
  it('reads every field off a full link, including the present URL', () => {
    const ask = parseSigninLink(LINK);
    expect(ask).toEqual({
      door: 'https://id.example.nz/login',
      present: 'https://id.example.nz/login/app/present',
      challenge: 'c_3f9abc',
      schemas: ['EMe7Qzr'],
      community: 'Te Rūnanga o Example',
      service: 'Files',
    });
  });

  it('splits a comma-separated multi-schema ask', () => {
    const ask = parseSigninLink('matou://signin?door=https://d.nz&present=https://d.nz/p&c=n1&s=EA,EB');
    expect(ask?.schemas).toEqual(['EA', 'EB']);
  });

  it('tolerates a link with no service (the prototype shape)', () => {
    const ask = parseSigninLink('matou://signin?door=https://d.nz&present=https://d.nz/p&c=n1&s=EA&name=Home');
    expect(ask?.service).toBe('');
    expect(ask?.community).toBe('Home');
  });

  it('reads the short svc alias for the service', () => {
    const ask = parseSigninLink('matou://signin?door=https://d.nz&present=https://d.nz/p&c=n1&svc=Portal');
    expect(ask?.service).toBe('Portal');
  });

  it('yields no schema for an empty s rather than a blank entry', () => {
    const ask = parseSigninLink('matou://signin?door=https://d.nz&present=https://d.nz/p&c=n1&s=');
    expect(ask?.schemas).toEqual([]);
  });

  it('does not derive the present path — a link with no present is refused', () => {
    expect(parseSigninLink('matou://signin?door=https://d.nz&c=n1&s=EA')).toBeNull();
  });

  it('rejects the pairing link and other non-signin text', () => {
    expect(parseSigninLink('matou://pair?id=x&pk=y&s=z')).toBeNull();
    expect(parseSigninLink('https://id.example.nz')).toBeNull();
    expect(parseSigninLink('')).toBeNull();
  });

  it('rejects a signin link missing the door or the challenge', () => {
    expect(parseSigninLink('matou://signin?c=n1&present=https://d.nz/p')).toBeNull();
    expect(parseSigninLink('matou://signin?door=https://d.nz&present=https://d.nz/p')).toBeNull();
  });
});

// What the code offers, in a field of its own: `offer=` (#688, idss ADR 0282 as
// amended 2026-09-29, app-door-golden `offer_field`). The wallet reads THIS
// field — never a sealing key on the code (`ek=` is retired), never the display
// name in `svc`, never `cred`.
describe('parseSigninLink — what the code offers (#688)', () => {
  const BASE = 'matou://signin?door=https://d.nz&present=https://d.nz/p&c=n1&s=EA';

  it('reads offer=seat-unlock: a control-panel sign-in that offers a seat unlock', () => {
    const ask = parseSigninLink(`${BASE}&offer=seat-unlock`);
    expect(ask?.offer).toBe('seat-unlock');
    expect(offersSeatUnlock(ask!)).toBe(true);
    expect(isUnlockAsk(ask!)).toBe(false);
  });

  it('reads offer=unlock: a code that says it is an unlock', () => {
    const ask = parseSigninLink(`${BASE}&offer=unlock`);
    expect(ask?.offer).toBe('unlock');
    expect(isUnlockAsk(ask!)).toBe(true);
    expect(offersSeatUnlock(ask!)).toBe(false);
  });

  it('an ordinary service sign-in offers nothing — the field is absent from the ask', () => {
    const ask = parseSigninLink(LINK);
    expect(ask).not.toHaveProperty('offer');
    expect(offersSeatUnlock(ask!)).toBe(false);
    expect(isUnlockAsk(ask!)).toBe(false);
  });

  it('never infers the offer from ek=, from the display name in svc, or from cred', () => {
    // Everything the old wallet keyed off, and no offer field: an ordinary card.
    const ask = parseSigninLink(`${BASE}&ek=DVERKEY&svc=the%20control%20panel&cred=administrator`);
    expect(ask).not.toHaveProperty('offer');
    expect(offersSeatUnlock(ask!)).toBe(false);
    expect(isUnlockAsk(ask!)).toBe(false);
  });

  it('does not read ek= at all — no sealing key is carried off any code', () => {
    const ask = parseSigninLink(`${BASE}&offer=seat-unlock&ek=DVERKEY`);
    expect(ask).not.toHaveProperty('sealingKey');
    expect(JSON.stringify(ask)).not.toContain('DVERKEY');
  });

  it('treats a blank or unknown offer as no offer — nothing is armed for a word it does not know', () => {
    expect(parseSigninLink(`${BASE}&offer=%20`)).not.toHaveProperty('offer');
    expect(parseSigninLink(`${BASE}&offer=everything`)).not.toHaveProperty('offer');
    expect(parseSigninLink(`${BASE}&offer=Seat-Unlock`)).not.toHaveProperty('offer');
  });

  describe('the wire contract (golden)', () => {
    it('names the field and its values as the golden does', () => {
      expect(OFFER_PARAM).toBe(golden.offer_field.deep_link_param);
      expect(Object.keys(golden.offer_field.values).sort()).toEqual(
        ['<absent>', OFFER_SEAT_UNLOCK, OFFER_UNLOCK].sort(),
      );
      expect(golden.panel.challenge.adds_to_ask_response.offer).toBe(OFFER_SEAT_UNLOCK);
      expect(golden.unlock_hop.challenge.adds_to_ask_response.offer).toBe(OFFER_UNLOCK);
    });

    it('no code carries ek, and none of the deep-link params is a sealing key', () => {
      expect(golden.deep_link_params).toEqual(['c', 'cred', 'door', 'name', 'offer', 'present', 's', 'svc']);
      expect(golden.panel.challenge.deep_link).not.toContain('ek=');
      expect(golden.unlock_hop.challenge.deep_link).not.toContain('ek=');
      expect(golden.panel.challenge.adds_to_ask_response).not.toHaveProperty('sealing_key');
    });

    it("reads the door's own control-panel code as offering a seat unlock", () => {
      const ask = parseSigninLink(golden.panel.challenge.deep_link);
      expect(ask?.offer).toBe(OFFER_SEAT_UNLOCK);
      expect(ask?.credential).toBe('administrator');
      expect(ask?.challenge).toBe('nonce-PANEL');
    });

    it("reads the door's own unlock code as an unlock — a sign-in code, not a scheme of its own", () => {
      expect(golden.unlock_hop.challenge.deep_link.startsWith('matou://signin?')).toBe(true);
      const ask = parseSigninLink(golden.unlock_hop.challenge.deep_link);
      expect(ask?.offer).toBe(OFFER_UNLOCK);
      expect(ask?.credential).toBe('administrator');
      expect(ask?.challenge).toBe('nonce-UNLOCK');
    });

    it("reads the door's ordinary service code as offering nothing", () => {
      expect(golden.ask.response).not.toHaveProperty('offer');
      expect(parseSigninLink(golden.ask.response.deep_link)).not.toHaveProperty('offer');
    });

    it('an armed present carries armed:true and no passcode', () => {
      expect(golden.panel.present.request.armed).toBe(true);
      expect(golden.panel.present.request).not.toHaveProperty('sealed_passcode');
      expect(golden.present.request).not.toHaveProperty('armed');
    });
  });
});

// The credential the door asks for, `cred=` (#683, idss ADR 0289, app-door-golden
// `panel.administrator`). The control panel's door names the Administrator
// credential by its definition slug, because the committee schema it is issued
// on is shared with every komiti credential and so cannot name it.
describe('parseSigninLink — the credential the door names (#683)', () => {
  const PANEL =
    'matou://signin?c=nonce-PANEL&cred=administrator&door=https://d.nz&name=Home&offer=seat-unlock&present=https://d.nz/p&s=ECommittee,EMembership&svc=the%20control%20panel';

  it('reads cred= onto credential, beside the schemas in the order the door sent them', () => {
    const ask = parseSigninLink(PANEL);
    expect(ask?.credential).toBe('administrator');
    expect(ask?.schemas).toEqual(['ECommittee', 'EMembership']);
    // What the code offers is its own field, read beside the credential.
    expect(ask?.offer).toBe('seat-unlock');
  });

  it('leaves credential unset on a service sign-in, so the ask is what it was before', () => {
    const ask = parseSigninLink(LINK);
    expect(ask).not.toHaveProperty('credential');
  });

  it('treats a blank cred= as absent', () => {
    const ask = parseSigninLink('matou://signin?door=https://d.nz&present=https://d.nz/p&c=n1&s=EA&cred=%20');
    expect(ask).not.toHaveProperty('credential');
  });

  it('the wire contract lists cred among the deep-link params and names administrator (golden)', () => {
    expect(golden.deep_link_params).toContain('cred');
    expect(golden.panel.administrator.adds_to_ask_response.credential).toBe('administrator');
    expect(golden.panel.challenge.deep_link).toContain('cred=administrator');
    // The ordinary service ask carries neither — the negative is contract too.
    expect(golden.ask.response).not.toHaveProperty('credential');
    expect(golden.ask.response.deep_link).not.toContain('cred=');
    expect(golden.present.no_credential.body).toEqual({ status: 'refused', refusal: 'no-credential' });
  });
});

// The approve page rebuilds the ask from its route query (the scanner and the OS
// deep-link handler both route there with the code's params as query).
describe('signinAskFromQuery', () => {
  it('rebuilds a panel ask, carrying cred and offer', () => {
    expect(
      signinAskFromQuery({
        door: 'https://d.nz',
        present: 'https://d.nz/p',
        c: 'n1',
        s: 'ECommittee,EMembership',
        name: 'Home',
        svc: 'the control panel',
        cred: 'administrator',
        offer: 'seat-unlock',
      }),
    ).toEqual({
      door: 'https://d.nz',
      present: 'https://d.nz/p',
      challenge: 'n1',
      schemas: ['ECommittee', 'EMembership'],
      community: 'Home',
      service: 'the control panel',
      credential: 'administrator',
      offer: 'seat-unlock',
    });
  });

  it('rebuilds a service ask with neither cred nor offer', () => {
    expect(
      signinAskFromQuery({ door: 'https://d.nz', present: 'https://d.nz/p', c: 'n1', s: 'EA', service: 'Files' }),
    ).toEqual({
      door: 'https://d.nz',
      present: 'https://d.nz/p',
      challenge: 'n1',
      schemas: ['EA'],
      community: '',
      service: 'Files',
    });
  });

  it('takes the first value of a repeated param and refuses a query with no door, challenge or present', () => {
    expect(signinAskFromQuery({ door: ['https://d.nz', 'https://x.nz'], present: 'https://d.nz/p', c: 'n1' })?.door).toBe(
      'https://d.nz',
    );
    expect(signinAskFromQuery({ present: 'https://d.nz/p', c: 'n1' })).toBeNull();
    expect(signinAskFromQuery({ door: 'https://d.nz', c: 'n1' })).toBeNull();
    expect(signinAskFromQuery({ door: 'https://d.nz', present: 'https://d.nz/p' })).toBeNull();
  });
});

describe('isSigninLink', () => {
  it('accepts a signin link and refuses the pairing link', () => {
    expect(isSigninLink(LINK)).toBe(true);
    expect(isSigninLink('matou://pair?id=x&pk=y&s=z')).toBe(false);
    expect(isSigninLink('matou://signin?c=n1')).toBe(false);
  });
});

// The panel's own unlock code is RETIRED (#688, idss ADR 0282 as amended
// 2026-09-29; app-door-golden `unlock_hop`): a locked panel unlocks through the
// sign-in door, so `matou://unlock` is not a code this wallet answers.
describe('the retired matou://unlock code', () => {
  const OLD_UNLOCK =
    'matou://unlock?panel=https%3A%2F%2Fadmin.example.nz&present=https%3A%2F%2Fid.example.nz%2Flogin%2Fapp%2Funlock&u=u_2d7abc&ek=DFRESHKEY&name=Home';

  it('is not a sign-in link, and nothing parses it', () => {
    expect(isSigninLink(OLD_UNLOCK)).toBe(false);
    expect(parseSigninLink(OLD_UNLOCK)).toBeNull();
  });
});
