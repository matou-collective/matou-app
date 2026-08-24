import { describe, it, expect } from 'vitest';
import {
  NAV_ITEM_META,
  isNavActive,
  badgeLabel,
} from '../../src/composables/navItems';

describe('navItems metadata', () => {
  it('exposes the 7 primary nav entries in order', () => {
    expect(NAV_ITEM_META.map((i) => i.name)).toEqual([
      'dashboard',
      'chat',
      'wallet',
      'activity',
      'proposals',
      'projects',
      'contributions',
    ]);
  });

  it('gives every entry a non-empty label', () => {
    for (const item of NAV_ITEM_META) {
      expect(item.label.length).toBeGreaterThan(0);
    }
  });
});

describe('isNavActive', () => {
  const contributions = NAV_ITEM_META.find((i) => i.name === 'contributions')!;
  const dashboard = NAV_ITEM_META.find((i) => i.name === 'dashboard')!;

  it('matches the entry’s own route name', () => {
    expect(isNavActive(dashboard, 'dashboard')).toBe(true);
    expect(isNavActive(dashboard, 'chat')).toBe(false);
  });

  it('matches alias route names (contribution-detail → Contributions)', () => {
    expect(isNavActive(contributions, 'contributions')).toBe(true);
    expect(isNavActive(contributions, 'contribution-detail')).toBe(true);
    expect(isNavActive(contributions, 'projects')).toBe(false);
  });

  it('is false for a null/undefined route name', () => {
    expect(isNavActive(dashboard, null)).toBe(false);
    expect(isNavActive(dashboard, undefined)).toBe(false);
  });
});

describe('badgeLabel', () => {
  it('renders small counts verbatim', () => {
    expect(badgeLabel(1)).toBe('1');
    expect(badgeLabel(99)).toBe('99');
  });

  it('clamps counts over 99 to 99+', () => {
    expect(badgeLabel(100)).toBe('99+');
    expect(badgeLabel(5000)).toBe('99+');
  });
});
