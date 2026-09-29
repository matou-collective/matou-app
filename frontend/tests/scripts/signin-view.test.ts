/**
 * The approve-card view model (idss #1492 story 13, WS-A2). Service first, then
 * the sign-in site (home site marked), then what will be shown; the AID, SAID,
 * nonce and bound message live only in the details disclosure, never the face.
 */
import { describe, it, expect } from 'vitest';
import { buildCardView, siteAddress } from 'src/lib/signin/view';
import type { SigninAsk } from 'src/lib/signin/link';
import { describeCredential, type CredentialToShow } from 'src/lib/signin/credential';

const ask: SigninAsk = {
  door: 'https://id.example.nz/login',
  present: 'https://id.example.nz/login/app/present',
  challenge: 'c_3f9',
  schemas: ['EMe'],
  community: 'Te Rūnanga o Example',
  service: 'Files',
};

const shown: CredentialToShow = describeCredential(
  { sad: { d: 'ECredSAID', s: 'EMe', a: { i: 'EHa4mPq', role: 'Member', dt: '2026-08-12T00:00:00Z' } } },
  { EMe: 'membership' },
  'Te Rūnanga o Example',
);

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

describe('buildCardView — the steward-unlock region (#663)', () => {
  it('carries the unlock region and the sealing-key fingerprint when supplied', () => {
    const v = buildCardView(ask, shown, 'EHa4mPq', true, { sealingKeyFingerprint: 'eff1·63d6' });
    expect(v.unlock).toEqual({ sealingKeyFingerprint: 'eff1·63d6' });
    // The identifiers on the face are unchanged — the fingerprint is not among
    // the details identifiers (it rides view.unlock, shown inside the disclosure).
    expect(v.details).not.toHaveProperty('sealingKeyFingerprint');
  });

  it('has no unlock region by default (every ordinary card is untouched)', () => {
    const v = buildCardView(ask, shown, 'EHa4mPq', true);
    expect(v.unlock).toBeNull();
  });
});

// What the door asked for, in words (#683): the no-credential screen names it,
// and the proving line says what is being proved.
describe('buildCardView — the credential the door asked for (#683)', () => {
  const panelAsk: SigninAsk = {
    ...ask,
    schemas: ['ECo', 'EMe'],
    service: 'the control panel',
    credential: 'administrator',
  };

  it('carries the asked credential\'s name, with or without a credential to show', () => {
    expect(buildCardView(panelAsk, null, 'EHa4mPq', true, null, 'Administrator').askedName).toBe('Administrator');
    expect(buildCardView(ask, shown, 'EHa4mPq', true, null, 'Membership').askedName).toBe('Membership');
    expect(buildCardView(ask, shown, 'EHa4mPq', true).askedName).toBe('');
  });

  const administrator = describeCredential(
    { sad: { d: 'EAdmin', s: 'ECo', a: { i: 'EHa4mPq', committee: 'administrator', dt: '2026-09-28T00:00:00Z' } } },
    { ECo: 'committee' },
    'Te Rūnanga o Example',
  );

  it('proves what is presented: holding the named credential, else membership as before', () => {
    expect(buildCardView(panelAsk, administrator, 'EHa4mPq', true, null, 'Administrator').provingLine).toBe(
      'Proving you hold Administrator…',
    );
    expect(buildCardView(ask, shown, 'EHa4mPq', true, null, 'Membership').provingLine).toBe(
      "Proving you're a member…",
    );
  });

  it('an operator answering the panel with their Membership is proving membership', () => {
    // The door asked for Administrator; what is shown is the fallback Membership.
    const v = buildCardView(panelAsk, shown, 'EHa4mPq', true, null, 'Administrator');
    expect(v.askedName).toBe('Administrator');
    expect(v.provingLine).toBe("Proving you're a member…");
  });

  it('carries the card of the credential to show', () => {
    expect(buildCardView(ask, shown, 'EHa4mPq', true).credential?.card.name).toBe('Membership');
  });
});

describe('siteAddress', () => {
  it('is the host of the door URL, or the raw door when it does not parse', () => {
    expect(siteAddress('https://id.example.nz/login')).toBe('id.example.nz');
    expect(siteAddress('not a url')).toBe('not a url');
  });
});
