import { describe, it, expect } from 'vitest';
import {
  naturalCompare,
  compareSiblings,
  sortSiblings,
  type OrderableContribution,
} from 'src/lib/contributions/ordering';

describe('naturalCompare (numeric-aware)', () => {
  it('sorts 1.2.9 before 1.2.10', () => {
    expect(naturalCompare('1.2.9', '1.2.10')).toBeLessThan(0);
    expect(naturalCompare('1.2.10', '1.2.9')).toBeGreaterThan(0);
  });

  it('sorts item2 before item10', () => {
    expect(naturalCompare('item2', 'item10')).toBeLessThan(0);
  });

  it('is case-insensitive with a deterministic tie-break', () => {
    expect(naturalCompare('Audit', 'target')).toBeLessThan(0);
    expect(naturalCompare('abc', 'abc')).toBe(0);
  });
});

function c(title: string, sort_order?: number): OrderableContribution {
  return sort_order === undefined ? { title } : { title, sort_order };
}

describe('sortSiblings', () => {
  it('falls back to a natural title sort when no explicit order', () => {
    const sorted = sortSiblings([c('1.2.10'), c('1.2.2'), c('1.2.9')]);
    expect(sorted.map(x => x.title)).toEqual(['1.2.2', '1.2.9', '1.2.10']);
  });

  it('respects explicit sort_order', () => {
    const sorted = sortSiblings([c('Alpha', 2), c('Bravo', 0), c('Charlie', 1)]);
    expect(sorted.map(x => x.title)).toEqual(['Bravo', 'Charlie', 'Alpha']);
  });

  it('places newly-ordered items after unordered legacy items', () => {
    // "new" has order 0 but legacy unordered items sort ahead of it, so it
    // lands at the end — the default-to-end behaviour.
    const sorted = sortSiblings([c('zzz new', 0), c('Apple'), c('Banana')]);
    expect(sorted.map(x => x.title)).toEqual(['Apple', 'Banana', 'zzz new']);
  });

  it('does not mutate the input array', () => {
    const input = [c('b', 1), c('a', 0)];
    const copy = [...input];
    sortSiblings(input);
    expect(input).toEqual(copy);
  });
});

describe('compareSiblings', () => {
  it('treats null and undefined order as unordered', () => {
    expect(compareSiblings({ title: 'x', sort_order: null }, { title: 'y', sort_order: 0 })).toBeLessThan(0);
  });
});
