import { describe, it, expect } from 'vitest';
import type { KitFeatures } from '../../src/kit/types';
import {
  NAV_ITEM_META,
  PRIMARY_NAV_ITEMS,
  OVERFLOW_NAV_ITEMS,
  isNavActive,
  badgeLabel,
  applyFeatureNav,
  FEATURE_NAV_ITEMS,
} from '../../src/composables/navItems';

describe('navItems metadata', () => {
  it('exposes the 7 nav entries in order', () => {
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

  it('marks the 4 primary tabs (Home · Chat · Notices · Contributions)', () => {
    // The mobile bottom bar shows these plus a "More" tab (5 tabs total).
    expect(PRIMARY_NAV_ITEMS.map((i) => i.name)).toEqual([
      'dashboard',
      'chat',
      'activity',
      'contributions',
    ]);
  });

  it('collapses the remaining entries into the More sheet (Wallet · Proposals · Projects)', () => {
    expect(OVERFLOW_NAV_ITEMS.map((i) => i.name)).toEqual([
      'wallet',
      'proposals',
      'projects',
    ]);
  });

  it('partitions every entry into exactly one of primary/overflow', () => {
    expect(PRIMARY_NAV_ITEMS.length + OVERFLOW_NAV_ITEMS.length).toBe(NAV_ITEM_META.length);
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

const ALL_ON: KitFeatures = {
  identity: true, chat: true, projects: true, proposals: true, notices: true,
  events: true, maramataka: true,
  order: ['chat', 'notices', 'proposals', 'projects', 'events'],
};

describe('applyFeatureNav (coa phase 4, spec §3.4)', () => {
  it('the committed default reproduces todays nav exactly', () => {
    expect(applyFeatureNav(NAV_ITEM_META, ALL_ON)).toEqual([...NAV_ITEM_META]);
    expect(FEATURE_NAV_ITEMS).toEqual([...NAV_ITEM_META]);
  });

  it('permutes toggleable entries within their slots; fixed entries hold position', () => {
    const nav = applyFeatureNav(NAV_ITEM_META, {
      ...ALL_ON, order: ['proposals', 'chat', 'projects', 'notices', 'events'],
    });
    expect(nav.map((i) => i.name)).toEqual([
      'dashboard', 'proposals', 'wallet', 'chat', 'projects', 'activity', 'contributions',
    ]);
  });

  it('disabled entries vanish without shifting fixed entries', () => {
    const nav = applyFeatureNav(NAV_ITEM_META, { ...ALL_ON, chat: false, projects: false });
    expect(nav.map((i) => i.name)).toEqual([
      'dashboard', 'activity', 'wallet', 'proposals', 'contributions',
    ]);
  });

  it('events never claims a nav slot', () => {
    const nav = applyFeatureNav(NAV_ITEM_META, {
      ...ALL_ON, order: ['events', 'chat', 'notices', 'proposals', 'projects'],
    });
    expect(nav.map((i) => i.name)).toContain('chat');
    expect(nav).toHaveLength(NAV_ITEM_META.length);
  });

  it('primary travels with the entry, not the slot', () => {
    const nav = applyFeatureNav(NAV_ITEM_META, {
      ...ALL_ON, order: ['proposals', 'chat', 'projects', 'notices', 'events'],
    });
    expect(nav.find((i) => i.name === 'proposals')?.primary).toBe(false);
    expect(nav.find((i) => i.name === 'chat')?.primary).toBe(true);
  });
});
