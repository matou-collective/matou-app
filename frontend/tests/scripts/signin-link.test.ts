/**
 * The `matou://signin?…` link parser (idss #1492 story 4/10, app-door-golden
 * `deep_link_params`). Reads the site address, the `present` URL, challenge,
 * schema(s), community and service; tolerates the missing service the prototype
 * omitted; and rejects anything that is not a well-formed sign-in link —
 * including a link with no `present`, which is a door this app cannot answer, so
 * it is refused rather than answered by guessing a path (#574).
 */
import { describe, it, expect } from 'vitest';
import { parseSigninLink, isSigninLink } from 'src/lib/signin/link';

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

describe('isSigninLink', () => {
  it('accepts a signin link and refuses the pairing link', () => {
    expect(isSigninLink(LINK)).toBe(true);
    expect(isSigninLink('matou://pair?id=x&pk=y&s=z')).toBe(false);
    expect(isSigninLink('matou://signin?c=n1')).toBe(false);
  });
});
