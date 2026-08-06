import { describe, it, expect } from 'vitest';
import { resolveAidDisplay } from '../../src/lib/aidDisplay';

const profiles = {
  EBL4I1BwDjIi9RXSyxHBdPHSmwE97Z1usHA3dcVZTf7g: { displayName: 'test admin' },
  EEmpty: { displayName: '' },
};

const org = { aid: 'ENrgLciCMRW8HWUMfwhnxqEMMPVKpReG5KN5pUAuG21A', name: 'Matou' };

describe('resolveAidDisplay', () => {
  it('returns the profile display name when the AID has a profile', () => {
    expect(resolveAidDisplay('EBL4I1BwDjIi9RXSyxHBdPHSmwE97Z1usHA3dcVZTf7g', profiles, org)).toBe(
      'test admin',
    );
  });

  it('resolves the organization AID to the org name', () => {
    expect(resolveAidDisplay(org.aid, profiles, org)).toBe('Matou (organisation)');
  });

  it('falls back to a sliced AID for unknown AIDs', () => {
    expect(resolveAidDisplay('EUnknownAidValue123456', profiles, org)).toBe('EUnknownAidV...');
  });

  it('falls back to a sliced AID when the profile display name is empty', () => {
    expect(resolveAidDisplay('EEmpty', profiles, org)).toBe('EEmpty...');
  });

  it('returns empty string for missing AIDs', () => {
    expect(resolveAidDisplay(undefined, profiles, org)).toBe('');
    expect(resolveAidDisplay(null, profiles, org)).toBe('');
    expect(resolveAidDisplay('', profiles, org)).toBe('');
  });

  it('works without org info', () => {
    expect(resolveAidDisplay('EUnknownAidValue123456', profiles)).toBe('EUnknownAidV...');
  });
});
