/**
 * Canonical sibling ordering for contributions, mirroring the backend
 * (backend/internal/contributions/ordering.go). A contribution's `sort_order`
 * is the source of truth; contributions without one (created before ordering
 * existed) fall back to a numeric-aware ("natural") title sort and sort ahead
 * of the explicitly-ordered ones — which is what makes a freshly created
 * contribution (assigned the next order past the end) land at the end of a
 * legacy, title-sorted list.
 *
 * Use this everywhere a sibling group is displayed (a milestone's top-level
 * contributions, or one parent's children) so every view and viewer agrees.
 */

/** Minimal shape needed to order a contribution. */
export interface OrderableContribution {
  title: string;
  sort_order?: number | null;
}

/**
 * Numeric-aware string comparison so e.g. "1.2.9" sorts before "1.2.10"
 * instead of lexicographically after it. Digit runs compare by value;
 * everything else compares case-insensitively, with the raw strings breaking
 * ties for a total, deterministic order.
 */
export function naturalCompare(a: string, b: string): number {
  const ar = Array.from(a);
  const br = Array.from(b);
  let i = 0;
  let j = 0;
  const isDigit = (c: string) => c >= '0' && c <= '9';
  while (i < ar.length && j < br.length) {
    if (isDigit(ar[i]!) && isDigit(br[j]!)) {
      const is = i;
      const js = j;
      while (i < ar.length && isDigit(ar[i]!)) i++;
      while (j < br.length && isDigit(br[j]!)) j++;
      const na = ar.slice(is, i).join('').replace(/^0+(?=\d)/, '');
      const nb = br.slice(js, j).join('').replace(/^0+(?=\d)/, '');
      if (na.length !== nb.length) return na.length - nb.length;
      if (na !== nb) return na < nb ? -1 : 1;
      // equal numeric value: fewer leading zeros first
      if (i - is !== j - js) return i - is - (j - js);
      continue;
    }
    const ca = ar[i]!.toLowerCase();
    const cb = br[j]!.toLowerCase();
    if (ca !== cb) return ca < cb ? -1 : 1;
    i++;
    j++;
  }
  if (ar.length - i !== br.length - j) return ar.length - i - (br.length - j);
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Comparator for two siblings; see module docs for the ordering rules. */
export function compareSiblings(a: OrderableContribution, b: OrderableContribution): number {
  const ao = a.sort_order;
  const bo = b.sort_order;
  const aHas = ao !== undefined && ao !== null;
  const bHas = bo !== undefined && bo !== null;
  if (!aHas && !bHas) return naturalCompare(a.title, b.title);
  if (!aHas) return -1; // unordered sorts before ordered
  if (!bHas) return 1;
  if (ao !== bo) return (ao as number) - (bo as number);
  return naturalCompare(a.title, b.title);
}

/**
 * Returns a new array of one sibling group sorted into canonical display order.
 * Does not mutate the input.
 */
export function sortSiblings<T extends OrderableContribution>(contributions: readonly T[]): T[] {
  return [...contributions].sort(compareSiblings);
}
