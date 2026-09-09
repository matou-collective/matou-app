import { KIT } from 'src/generated/kit';
import type { KitFeatures } from 'src/kit/types';

export type NoticeType = 'event' | 'update' | 'announcement';

/** Events are a notice *type*, not a module (coa spec §3.3): they exist only
    when the community selected both notices and events at build time. */
export function eventsEnabled(features: KitFeatures = KIT.features): boolean {
  return features.events && features.notices;
}

export function defaultNoticeType(features: KitFeatures = KIT.features): NoticeType {
  return eventsEnabled(features) ? 'event' : 'announcement';
}

export function noticeFilters(features: KitFeatures = KIT.features) {
  return [
    { label: 'All', value: 'all' as const },
    ...(eventsEnabled(features) ? [{ label: 'Events', value: 'event' as const }] : []),
    { label: 'Announcements', value: 'announcement' as const },
    { label: 'Updates', value: 'update' as const },
  ];
}
