/**
 * i18n locale registry (#783).
 *
 * `en` is the single source of truth: every key lives in `en` first, and the
 * parity guard (tests/scripts/i18n-parity.test.ts) fails CI if any other
 * locale is missing a key that `en` has. The non-`en` catalogues are machine
 * drafts — see the banner comment at the top of each `src/i18n/<locale>/*`
 * file — and `en` always wins until a human reviews a draft.
 *
 * Mirrors the five locales IDSS ships (IDSS ADR 0232 / DDR 0300): English,
 * Spanish, Dutch, French and Brazilian Portuguese.
 */

export const DEFAULT_LOCALE = 'en';

export interface LocaleMeta {
  /** BCP-47 code, also the vue-i18n locale key and the catalogue directory. */
  code: string;
  /** The language's name in its own language, for the picker. */
  nativeName: string;
  /**
   * English name, for aria-labels / tooltips where a second label helps.
   */
  englishName: string;
  /**
   * True while the catalogue is an unreviewed machine draft. `en` is the only
   * authoritative locale today; every other locale is a draft (#783).
   */
  draft: boolean;
}

/**
 * Ordered for the picker — `en` first (authoritative), then the drafts in the
 * same order IDSS lists them.
 */
export const SUPPORTED_LOCALES: readonly LocaleMeta[] = [
  { code: 'en', nativeName: 'English', englishName: 'English', draft: false },
  { code: 'es', nativeName: 'Español', englishName: 'Spanish', draft: true },
  { code: 'nl', nativeName: 'Nederlands', englishName: 'Dutch', draft: true },
  { code: 'fr', nativeName: 'Français', englishName: 'French', draft: true },
  { code: 'pt-BR', nativeName: 'Português (Brasil)', englishName: 'Brazilian Portuguese', draft: true },
] as const;

export const SUPPORTED_LOCALE_CODES: readonly string[] = SUPPORTED_LOCALES.map(
  (l) => l.code,
);

/** localStorage key holding the member's explicit picker choice. */
export const LOCALE_STORAGE_KEY = 'matou:locale';

export function isSupportedLocale(code: string | null | undefined): code is string {
  return !!code && SUPPORTED_LOCALE_CODES.includes(code);
}

export function localeMeta(code: string): LocaleMeta | undefined {
  return SUPPORTED_LOCALES.find((l) => l.code === code);
}
