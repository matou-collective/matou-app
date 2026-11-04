/**
 * Locale switching for components (#783).
 *
 * Wraps vue-i18n's global `locale` ref so the picker (and anything else) share
 * one switch point that also persists the member's choice.
 */
import { useI18n } from 'vue-i18n';
import { SUPPORTED_LOCALES, isSupportedLocale } from 'src/i18n/config';
import { persistLocale, loadStoredLocale, matchLocale } from 'src/i18n/resolve';

export function useLocale() {
  const { locale } = useI18n({ useScope: 'global' });

  /** Switch the active locale and remember it as the member's explicit choice. */
  function setLocale(code: string): void {
    if (!isSupportedLocale(code)) return;
    locale.value = code;
    persistLocale(code);
  }

  /**
   * Apply the community's primary language as the default — but only when the
   * member has not already picked one themselves (an explicit choice always
   * wins). Safe to call whenever the community's language becomes known.
   */
  function applyCommunityDefault(primary: string | null | undefined): void {
    if (loadStoredLocale()) return;
    const matched = matchLocale(primary ?? null);
    if (matched) locale.value = matched;
  }

  return {
    locale,
    locales: SUPPORTED_LOCALES,
    setLocale,
    applyCommunityDefault,
  };
}
