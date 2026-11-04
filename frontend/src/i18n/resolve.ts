/**
 * First-run locale resolution (#783).
 *
 * Precedence, highest first:
 *   1. The member's explicit picker choice (persisted in localStorage).
 *   2. The community's primary language, when the app knows it.
 *   3. The device / browser language.
 *   4. `en`.
 *
 * Steps 2–4 are the ticket's first-run default (community primary → device →
 * `en`); step 1 sits above them so that once a member has picked a language it
 * is never silently overridden on the next launch.
 */
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  SUPPORTED_LOCALE_CODES,
  isSupportedLocale,
} from './config';

/**
 * Normalise an arbitrary language tag onto a supported locale, or null.
 *
 * Tries the exact tag first (so `pt-BR` matches the `pt-BR` catalogue), then
 * the primary subtag (so `es-ES`, `es-419` … all fall back to `es`, and a bare
 * `pt` lands on `pt-BR` — the only Portuguese catalogue we ship).
 */
export function matchLocale(tag: string | null | undefined): string | null {
  if (!tag) return null;
  const normalized = tag.trim();
  if (!normalized) return null;

  // Exact match (case-insensitive on the region subtag): en, pt-BR, …
  const exact = SUPPORTED_LOCALE_CODES.find(
    (c) => c.toLowerCase() === normalized.toLowerCase(),
  );
  if (exact) return exact;

  // Primary subtag: es-ES → es, pt → pt-BR, fr-CA → fr.
  const primary = normalized.split('-')[0].toLowerCase();
  const byPrimary = SUPPORTED_LOCALE_CODES.find(
    (c) => c.split('-')[0].toLowerCase() === primary,
  );
  return byPrimary ?? null;
}

export interface ResolveLocaleInput {
  /** The member's persisted picker choice, if any. */
  stored?: string | null;
  /** The community's primary language (e.g. from org config), if known. */
  communityPrimary?: string | null;
  /** Ordered device/browser language preferences (navigator.languages). */
  deviceLanguages?: readonly string[];
}

export function resolveInitialLocale(input: ResolveLocaleInput): string {
  if (isSupportedLocale(input.stored)) return input.stored;

  const community = matchLocale(input.communityPrimary);
  if (community) return community;

  for (const lang of input.deviceLanguages ?? []) {
    const device = matchLocale(lang);
    if (device) return device;
  }

  return DEFAULT_LOCALE;
}

/** Read the device languages from the browser, most-preferred first. */
export function deviceLanguages(): string[] {
  if (typeof navigator === 'undefined') return [];
  if (Array.isArray(navigator.languages) && navigator.languages.length > 0) {
    return [...navigator.languages];
  }
  return navigator.language ? [navigator.language] : [];
}

export function loadStoredLocale(): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(LOCALE_STORAGE_KEY);
    return isSupportedLocale(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function persistLocale(code: string): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(LOCALE_STORAGE_KEY, code);
    }
  } catch {
    // Best-effort — a blocked/full localStorage must not crash the app.
  }
}
