import type { Component } from 'vue';
import { Users, CoinsIcon, Vote, Target } from 'lucide-vue-next';

export interface HeaderStat {
  label: string;
  value: number;
  icon: Component;
  visible: boolean;
  comingSoon?: boolean;
}

export interface HeaderStatOptions {
  /** Whether the current user is a steward/admin. */
  isSteward: boolean;
  /** Number of pending registrations (only surfaced to stewards). */
  pendingCount: number;
  /** Whether the viewport is at or below the mobile breakpoint (≤767px). */
  isMobile: boolean;
}

/**
 * Builds the Home header stat tiles.
 *
 * The three placeholder "coming soon" tiles — New Transactions, Proposal
 * Updates, Contribution Actions — are hidden on mobile (≤767px) so they don't
 * crowd the header; on desktop they render as before (#123). The steward-only
 * "Pending Registrations" tile is gated on `isSteward` and is unaffected by
 * viewport.
 */
export function buildHeaderStats({
  isSteward,
  pendingCount,
  isMobile,
}: HeaderStatOptions): HeaderStat[] {
  return [
    {
      label: 'Pending Registrations',
      value: isSteward ? pendingCount : 0,
      icon: Users,
      visible: isSteward,
    },
    { label: 'New Transactions', value: 0, icon: CoinsIcon, visible: !isMobile, comingSoon: true },
    { label: 'Proposal Updates', value: 0, icon: Vote, visible: !isMobile, comingSoon: true },
    { label: 'Contribution Actions', value: 0, icon: Target, visible: !isMobile, comingSoon: true },
  ];
}
