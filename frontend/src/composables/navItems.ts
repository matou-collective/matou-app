import kitFeatures from 'src/generated/features.json';
import type { KitFeatures } from 'src/kit/types';

/**
 * Navigation entries, shared by the desktop sidebar and the mobile bottom tab
 * bar (DashboardLayout.vue). Keeping the metadata (route name, label, active
 * aliases, primary/overflow) in one place guarantees the navigations never
 * drift apart; the layout maps icons and live unread badges onto each entry.
 *
 * On mobile the bottom bar shows only the `primary` entries plus a "More" tab;
 * the non-primary (overflow) entries live behind that tab's bottom sheet. The
 * desktop sidebar still renders every entry regardless of `primary`.
 */
export interface NavItemMeta {
  /** Target route name (also the v-for key). */
  name: string;
  /** Visible label in both navigations. */
  label: string;
  /** Extra route names that should still mark this entry active. */
  aliases?: string[];
  /**
   * Whether this entry shows as its own tab in the mobile bottom bar. Non-primary
   * entries are collapsed into the "More" sheet instead. Desktop ignores this.
   */
  primary: boolean;
}

export const NAV_ITEM_META: readonly NavItemMeta[] = [
  { name: 'dashboard', label: 'Home', primary: true },
  { name: 'chat', label: 'Chat', primary: true },
  { name: 'wallet', label: 'Wallet', primary: false },
  { name: 'activity', label: 'Notices', primary: true },
  { name: 'proposals', label: 'Proposals', primary: false },
  { name: 'projects', label: 'Projects', primary: false },
  { name: 'contributions', label: 'Contributions', aliases: ['contribution-detail'], primary: true },
];

/** COA toggleable feature → nav entry name. `events` is a notice type, not a module —
    it has no nav slot (coa spec §3.3). */
const FEATURE_NAV = {
  chat: 'chat',
  projects: 'projects',
  proposals: 'proposals',
  notices: 'activity',
} as const;

/**
 * Apply a kit's feature selection to the nav skeleton (coa phase-4 spec §3.4):
 * fixed entries keep their positions; the toggleable entries' slots are filled
 * left-to-right with the ENABLED features in the kit's `order`; leftover slots
 * drop. `primary` (mobile tab membership) travels with the entry.
 */
export function applyFeatureNav(meta: readonly NavItemMeta[], features: KitFeatures): NavItemMeta[] {
  const toggleable = new Set<string>(Object.values(FEATURE_NAV));
  const byName = new Map(meta.map((m) => [m.name, m]));
  const ordered = features.order
    .filter((f): f is keyof typeof FEATURE_NAV => f in FEATURE_NAV && features[f as keyof typeof FEATURE_NAV])
    .map((f) => byName.get(FEATURE_NAV[f]))
    .filter((m): m is NavItemMeta => m !== undefined);
  const out: NavItemMeta[] = [];
  let next = 0;
  for (const m of meta) {
    if (!toggleable.has(m.name)) out.push(m);
    else if (next < ordered.length) out.push(ordered[next++]!);
  }
  return out;
}

/** The nav this build actually shows — the kit skeleton with features applied. */
export const FEATURE_NAV_ITEMS: readonly NavItemMeta[] = applyFeatureNav(
  NAV_ITEM_META,
  kitFeatures as KitFeatures,
);

/** Entries shown as their own tab in the mobile bottom bar, in order. */
export const PRIMARY_NAV_ITEMS: readonly NavItemMeta[] = FEATURE_NAV_ITEMS.filter((i) => i.primary);

/** Entries collapsed into the mobile "More" sheet, in order. */
export const OVERFLOW_NAV_ITEMS: readonly NavItemMeta[] = FEATURE_NAV_ITEMS.filter((i) => !i.primary);

/**
 * Whether a nav entry should render as active for the current route name.
 * Matches the entry's own route name or any of its aliases.
 */
export function isNavActive(item: NavItemMeta, routeName: string | null | undefined): boolean {
  if (!routeName) return false;
  return routeName === item.name || (item.aliases?.includes(routeName) ?? false);
}

/** Clamp an unread count to the `99+` badge label shown in both navigations. */
export function badgeLabel(count: number): string {
  return count > 99 ? '99+' : String(count);
}
