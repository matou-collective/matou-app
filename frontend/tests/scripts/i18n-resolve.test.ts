import { describe, it, expect } from 'vitest';
import {
  resolveInitialLocale,
  matchLocale,
} from '../../src/i18n/resolve';

/**
 * First-run locale resolution (#783).
 *
 * Precedence: explicit stored choice → community primary → device → en.
 */
describe('matchLocale', () => {
  it('matches an exact supported code including the region subtag', () => {
    expect(matchLocale('pt-BR')).toBe('pt-BR');
    expect(matchLocale('en')).toBe('en');
  });

  it('falls back from a regional tag to the primary subtag', () => {
    expect(matchLocale('es-ES')).toBe('es');
    expect(matchLocale('es-419')).toBe('es');
    expect(matchLocale('fr-CA')).toBe('fr');
    expect(matchLocale('pt')).toBe('pt-BR'); // only Portuguese catalogue we ship
  });

  it('returns null for an unsupported or empty tag', () => {
    expect(matchLocale('de')).toBeNull();
    expect(matchLocale('')).toBeNull();
    expect(matchLocale(null)).toBeNull();
    expect(matchLocale(undefined)).toBeNull();
  });
});

describe('resolveInitialLocale', () => {
  it('prefers an explicit stored choice above everything', () => {
    expect(
      resolveInitialLocale({
        stored: 'nl',
        communityPrimary: 'es',
        deviceLanguages: ['fr-FR'],
      }),
    ).toBe('nl');
  });

  it('ignores an unsupported stored value and falls through', () => {
    expect(
      resolveInitialLocale({
        stored: 'de',
        communityPrimary: 'es',
        deviceLanguages: ['fr-FR'],
      }),
    ).toBe('es');
  });

  it('uses the community primary when there is no stored choice', () => {
    expect(
      resolveInitialLocale({
        communityPrimary: 'pt',
        deviceLanguages: ['fr-FR'],
      }),
    ).toBe('pt-BR');
  });

  it('falls back to the device language when the community is unknown', () => {
    expect(
      resolveInitialLocale({
        communityPrimary: null,
        deviceLanguages: ['es-MX', 'en-US'],
      }),
    ).toBe('es');
  });

  it('skips unsupported device languages to the first supported one', () => {
    expect(
      resolveInitialLocale({
        deviceLanguages: ['de-DE', 'fr-CA'],
      }),
    ).toBe('fr');
  });

  it('defaults to en when nothing resolves', () => {
    expect(
      resolveInitialLocale({
        communityPrimary: 'de',
        deviceLanguages: ['de-DE', 'ja-JP'],
      }),
    ).toBe('en');
    expect(resolveInitialLocale({})).toBe('en');
  });
});
