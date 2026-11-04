/**
 * vue-i18n instance factory (#783).
 *
 * Composition API only (`legacy: false`) — components read strings through
 * `useI18n()`, matching the IDSS convention. `en` is both the initial default
 * and the fallback, so an unreviewed draft that is missing a key still renders
 * the authoritative English rather than a raw key.
 */
import { createI18n, type I18n } from 'vue-i18n';
import { DEFAULT_LOCALE } from './config';
import { messages } from './messages';

export function createI18nInstance(locale: string = DEFAULT_LOCALE): I18n {
  return createI18n({
    legacy: false,
    globalInjection: true,
    locale,
    fallbackLocale: DEFAULT_LOCALE,
    messages,
    // A draft locale deliberately falls back to `en` for any key a human has
    // not translated yet — don't spam the console about it.
    fallbackWarn: false,
    missingWarn: false,
  });
}

export { SUPPORTED_LOCALES, DEFAULT_LOCALE } from './config';
