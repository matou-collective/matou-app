import { describe, it, expect } from 'vitest';
import { messages } from '../../src/i18n/messages';
import { DEFAULT_LOCALE, SUPPORTED_LOCALE_CODES } from '../../src/i18n/config';

/**
 * i18n parity guard (#783).
 *
 * `en` is authoritative. Every key present in `en` must exist in every other
 * locale, and no locale may carry a key `en` does not have (a stray key is a
 * typo or an orphan a later `en` rename left behind). This runs in CI via
 * `npm run test:script`, so a dropped or mistyped key fails the build.
 */

/** Collect the dotted leaf-key paths of a nested message object. */
function leafKeys(obj: unknown, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object') return [prefix];
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    out.push(...leafKeys(v, path));
  }
  return out;
}

describe('i18n catalogue parity (#783)', () => {
  const allMessages = messages as Record<string, unknown>;
  const enKeys = new Set(leafKeys(allMessages[DEFAULT_LOCALE]));

  it('ships every supported locale', () => {
    for (const code of SUPPORTED_LOCALE_CODES) {
      expect(allMessages[code], `catalogue missing for locale "${code}"`).toBeTruthy();
    }
  });

  const others = SUPPORTED_LOCALE_CODES.filter((c) => c !== DEFAULT_LOCALE);

  it.each(others)('%s has no key missing from en', (code) => {
    const localeKeys = new Set(leafKeys(allMessages[code]));
    const missing = [...enKeys].filter((k) => !localeKeys.has(k));
    expect(missing, `${code} is missing keys present in ${DEFAULT_LOCALE}`).toEqual([]);
  });

  it.each(others)('%s has no key absent from en', (code) => {
    const localeKeys = leafKeys(allMessages[code]);
    const stray = localeKeys.filter((k) => !enKeys.has(k));
    expect(stray, `${code} has keys not present in ${DEFAULT_LOCALE}`).toEqual([]);
  });
});
