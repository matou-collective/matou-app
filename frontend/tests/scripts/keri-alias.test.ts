import { describe, it, expect } from 'vitest';
import { toKeriAlias } from '../../src/lib/keri/alias';

/**
 * KERI identifier aliases travel inside KERIA admin API URL paths. A macron in
 * an alias reached KERIA as `/identifiers/m%25C4%2581tou` — the percent-escape
 * itself re-escaped — and KERIA answered 401, which aborted community setup at
 * `createRegistry`. Every name → alias derivation goes through toKeriAlias.
 */
describe('toKeriAlias', () => {
  it('folds macrons to plain ASCII', () => {
    expect(toKeriAlias('Mātou', { lowercase: true })).toBe('matou');
    expect(toKeriAlias('Tāmati Rewi', { lowercase: true })).toBe('tamati-rewi');
    expect(toKeriAlias('Ngāhuia Whakatōhea', { lowercase: true })).toBe('ngahuia-whakatohea');
  });

  it('leaves plain ASCII names byte-identical to the old derivation', () => {
    // Guards existing communities: their alias was derived by the previous
    // `toLowerCase().replace(/\s+/g, '-')` rule and must not shift.
    for (const name of ['Matou', 'Matou Community', 'Aroha Mika', 'admin user']) {
      expect(toKeriAlias(name, { lowercase: true })).toBe(
        name.toLowerCase().replace(/\s+/g, '-'),
      );
    }
  });

  it('strips characters that break URL paths', () => {
    expect(toKeriAlias('a/b\\c?d#e%f', { lowercase: true })).toBe('a-b-c-d-e-f');
    expect(toKeriAlias('  spaced   out  ', { lowercase: true })).toBe('spaced-out');
  });

  it('preserves case unless asked to lowercase', () => {
    expect(toKeriAlias('Aroha Mika')).toBe('Aroha-Mika');
  });

  it('falls back when a name folds away to nothing', () => {
    expect(toKeriAlias('日本語', { fallback: 'member' })).toBe('member');
    expect(toKeriAlias('', { fallback: 'member' })).toBe('member');
  });

  it('produces only characters that survive a URL path unchanged', () => {
    for (const name of ['Mātou', 'Tāmati Rewi', 'a/b?c#d', 'Ngā Puhi']) {
      const alias = toKeriAlias(name, { lowercase: true });
      expect(encodeURIComponent(alias)).toBe(alias);
    }
  });
});
