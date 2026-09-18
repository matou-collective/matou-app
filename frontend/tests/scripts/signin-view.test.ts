/**
 * The approve-card view model (idss #1492 story 13, WS-A2). Service first, then
 * the sign-in site (home site marked), then what will be shown; the AID, SAID,
 * nonce and bound message live only in the details disclosure, never the face.
 */
import { describe, it, expect } from 'vitest';
import { buildCardView, siteAddress } from 'src/lib/signin/view';
import type { SigninAsk } from 'src/lib/signin/link';
import type { CredentialToShow } from 'src/lib/signin/credential';

const ask: SigninAsk = {
  door: 'https://id.example.nz/login',
  challenge: 'c_3f9',
  schemas: ['EMe'],
  community: 'Te Rūnanga o Example',
  service: 'Files',
};

const shown: CredentialToShow = {
  said: 'ECredSAID',
  schema: 'EMe',
  kindLabel: 'Membership',
  role: 'Member',
  issuedOn: '12 Aug 2026',
};

describe('buildCardView', () => {
  it('names the service, community, site line and home mark', () => {
    const v = buildCardView(ask, shown, 'EHa4mPq', true);
    expect(v.service).toBe('Files');
    expect(v.community).toBe('Te Rūnanga o Example');
    expect(v.siteName).toBe("Te Rūnanga o Example's sign-in site");
    expect(v.siteAddress).toBe('id.example.nz');
    expect(v.isHome).toBe(true);
    expect(v.credential).toBe(shown);
  });

  it('puts the identifiers only in the details disclosure', () => {
    const v = buildCardView(ask, shown, 'EHa4mPq', false);
    expect(v.isHome).toBe(false);
    expect(v.details).toEqual({
      aid: 'EHa4mPq',
      credentialSaid: 'ECredSAID',
      challengeId: 'c_3f9',
      boundMessage: 'idss-idp:https://id.example.nz/login:EHa4mPq:c_3f9',
    });
  });

  it('keeps the headline grammatical when the link omits the service/community', () => {
    const v = buildCardView({ ...ask, service: '', community: '' }, null, 'EHa', false);
    expect(v.service).toBe('the service');
    expect(v.community).toBe('your community');
    expect(v.credential).toBeNull();
  });
});

describe('siteAddress', () => {
  it('is the host of the door URL, or the raw door when it does not parse', () => {
    expect(siteAddress('https://id.example.nz/login')).toBe('id.example.nz');
    expect(siteAddress('not a url')).toBe('not a url');
  });
});
