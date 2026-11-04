/**
 * Assembled catalogues for every supported locale (#783).
 *
 * `en` is the authoritative schema; `MessageSchema` is derived from it so the
 * other locales (and `useI18n<...>`) are type-checked against the English keys.
 */
import en from './en';
import es from './es';
import nl from './nl';
import fr from './fr';
import ptBR from './pt-BR';

export const messages = {
  en,
  es,
  nl,
  fr,
  'pt-BR': ptBR,
};

export type MessageSchema = typeof en;
