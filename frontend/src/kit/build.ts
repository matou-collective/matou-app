// Build-flavour helpers derived from the generated kit.
//
// A "Coa build" is a community app produced by Coa from its own kit — anything
// whose slug is not the stock Mātou build. Mātou-only chrome (roadmap
// placeholders, the credentials graph) is hidden in Coa builds; see #619, #622.
import { KIT } from 'src/generated/kit';

/** The stock Mātou build's kit slug. */
export const MATOU_KIT_SLUG = 'matou';

/** True for a Coa-built community app (kit slug ≠ the stock Mātou build). */
export function isCoaBuild(): boolean {
  return KIT.slug !== MATOU_KIT_SLUG;
}
