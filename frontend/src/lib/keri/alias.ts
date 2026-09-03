/**
 * Turn a human-readable name into a KERI identifier alias.
 *
 * KERIA's admin API addresses identifiers by alias inside the URL path
 * (`/identifiers/{alias}`, `/identifiers/{alias}/credentials`, ...), and
 * signify-ts does not encode the alias safely: a name carrying a macron
 * reached KERIA as `/identifiers/m%25C4%2581tou` — the percent-escape of `ā`
 * with its own `%` escaped again — which KERIA rejects with 401. That killed
 * community setup for any org named in te reo (`Mātou` → alias `mātou`),
 * aborting at `createRegistry`, the first step that reads the identifier back
 * by alias.
 *
 * So an alias is an internal, URL-safe handle — never display text. The
 * community keeps its real name (macrons and all) in the org config; only this
 * handle is folded down to ASCII.
 */
export interface KeriAliasOptions {
  /** Lowercase the result. Matches the historical derivation for org/person aliases. */
  lowercase?: boolean;
  /** Used when a name folds away to nothing (e.g. a name in a non-Latin script). */
  fallback?: string;
}

export function toKeriAlias(name: string, opts: KeriAliasOptions = {}): string {
  const { lowercase = false, fallback = 'identity' } = opts;

  const ascii = (name ?? '')
    // Split base letters from their combining marks so ā → a + ̄ , then drop
    // the marks. Handles the whole macron/accent family, not just te reo.
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    // Anything still outside printable ASCII has no safe path representation.
    .replace(/[^\x20-\x7E]/g, '');

  const alias = ascii
    // Collapse whitespace and the characters that would change the path's shape.
    .replace(/[/\\?#%\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .trim();

  const result = lowercase ? alias.toLowerCase() : alias;
  return result || fallback;
}
