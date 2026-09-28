/**
 * The `matou://signin?…` link parser (idss #1492 story 4/10, app-door-golden
 * `deep_link_params`). Reads the site address, the `present` URL, challenge,
 * schema(s), community and service; tolerates the missing service the prototype
 * omitted; and rejects anything that is not a well-formed sign-in link —
 * including a link with no `present`, which is a door this app cannot answer, so
 * it is refused rather than answered by guessing a path (#574).
 */
import { describe, it, expect } from 'vitest';
import { parseSigninLink, isSigninLink, isPanelSignin, parseUnlockLink, isUnlockLink } from 'src/lib/signin/link';
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

// The control-panel sealing key `ek=` (#663, app-door-golden `panel`). Its mere
// presence — not the display-name `svc` — is the signal that this is a
// control-panel sign-in offering a passcode handover.
describe('parseSigninLink — the control-panel sealing key (#663)', () => {
  it('reads ek= onto sealingKey and marks the ask a panel sign-in', () => {
    const ask = parseSigninLink(
      'matou://signin?door=https://d.nz&present=https://d.nz/p&c=n1&s=EA&svc=the%20control%20panel&ek=DVERKEY',
    );
    expect(ask?.sealingKey).toBe('DVERKEY');
    expect(isPanelSignin(ask!)).toBe(true);
  });

  it('leaves sealingKey unset on an ordinary sign-in — not a panel sign-in', () => {
    const ask = parseSigninLink(LINK);
    expect(ask?.sealingKey).toBeUndefined();
    expect(isPanelSignin(ask!)).toBe(false);
  });

  it('the wire contract lists ek among the deep-link params (golden)', () => {
    // The panel handover rides ek on the code and a sealing_key on the panel
    // challenge (idss #1939); the parser answers ek. Under option B (idss
    // #1961/#1967) the panel present carries `armed: true` and NO box — the
    // wallet seals later on the sign_in_armed_handover routes.
    expect(golden.deep_link_params).toContain('ek');
    expect(golden.panel.challenge.adds_to_ask_response.sealing_key).toBeTruthy();
    expect(golden.panel.present.request.armed).toBe(true);
    expect(golden.panel.present.request).not.toHaveProperty('sealed_passcode');
  });
});

describe('isSigninLink', () => {
  it('accepts a signin link and refuses the pairing link', () => {
    expect(isSigninLink(LINK)).toBe(true);
    expect(isSigninLink('matou://pair?id=x&pk=y&s=z')).toBe(false);
    expect(isSigninLink('matou://signin?c=n1')).toBe(false);
  });
});

// The control-panel UNLOCK code (#664, idss#1929 PU-M0q/PU-A4). A distinct
// scheme, `matou://unlock?…`, a locked-but-signed-in panel shows; it carries a
// FRESH sealing key and no credential presentation.
const UNLOCK_PRESENT = 'https%3A%2F%2Fid.example.nz%2Flogin%2Fapp%2Funlock';
const UNLOCK_LINK =
  'matou://unlock?panel=https%3A%2F%2Fadmin.example.nz&present=' +
  UNLOCK_PRESENT +
  '&u=u_2d7abc&ek=DFRESHKEY&name=Te%20R%C5%ABnanga%20o%20Example&t=14%3A06&exp=1800000000';

describe('parseUnlockLink', () => {
  it('reads every field off a full unlock code', () => {
    const ask = parseUnlockLink(UNLOCK_LINK);
    expect(ask).toEqual({
      panel: 'https://admin.example.nz',
      present: 'https://id.example.nz/login/app/unlock',
      challenge: 'u_2d7abc',
      sealingKey: 'DFRESHKEY',
      community: 'Te Rūnanga o Example',
      signedInAt: '14:06',
      expiresAt: 1800000000 * 1000,
    });
  });

  it('tolerates a code with no name, time or expiry', () => {
    const ask = parseUnlockLink('matou://unlock?panel=https://admin.nz&present=https://d.nz/u&u=n1&ek=DK');
    expect(ask?.community).toBe('');
    expect(ask?.signedInAt).toBe('');
    expect(ask?.expiresAt).toBeNull();
  });

  it('drops a malformed exp to null rather than reading it as already expired', () => {
    const ask = parseUnlockLink('matou://unlock?panel=https://admin.nz&present=https://d.nz/u&u=n1&ek=DK&exp=soon');
    expect(ask?.expiresAt).toBeNull();
  });

  it('refuses a code missing the panel, challenge, sealing key or present URL', () => {
    expect(parseUnlockLink('matou://unlock?present=https://d.nz/u&u=n1&ek=DK')).toBeNull();
    expect(parseUnlockLink('matou://unlock?panel=https://admin.nz&present=https://d.nz/u&ek=DK')).toBeNull();
    expect(parseUnlockLink('matou://unlock?panel=https://admin.nz&present=https://d.nz/u&u=n1')).toBeNull();
    expect(parseUnlockLink('matou://unlock?panel=https://admin.nz&u=n1&ek=DK')).toBeNull();
  });

  it('is not confused with a sign-in link and vice versa', () => {
    expect(parseUnlockLink(LINK)).toBeNull();
    expect(parseSigninLink(UNLOCK_LINK)).toBeNull();
  });
});

describe('isUnlockLink', () => {
  it('accepts an unlock code and refuses sign-in and pairing links', () => {
    expect(isUnlockLink(UNLOCK_LINK)).toBe(true);
    expect(isUnlockLink(LINK)).toBe(false);
    expect(isUnlockLink('matou://pair?id=x&pk=y&s=z')).toBe(false);
    expect(isUnlockLink('matou://unlock?panel=https://admin.nz')).toBe(false);
  });
});
