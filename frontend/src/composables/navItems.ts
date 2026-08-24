/**
 * Primary navigation entries, shared by the desktop sidebar and the mobile
 * bottom tab bar (DashboardLayout.vue). Keeping the metadata (route name,
 * label, active aliases) in one place guarantees the two navigations never
 * drift apart; the layout maps icons and live unread badges onto each entry.
 */
export interface NavItemMeta {
  /** Target route name (also the v-for key). */
  name: string;
  /** Visible label in both navigations. */
  label: string;
  /** Extra route names that should still mark this entry active. */
  aliases?: string[];
}

export const NAV_ITEM_META: readonly NavItemMeta[] = [
  { name: 'dashboard', label: 'Home' },
  { name: 'chat', label: 'Chat' },
  { name: 'wallet', label: 'Wallet' },
  { name: 'activity', label: 'Notices' },
  { name: 'proposals', label: 'Proposals' },
  { name: 'projects', label: 'Projects' },
  { name: 'contributions', label: 'Contributions', aliases: ['contribution-detail'] },
];

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
