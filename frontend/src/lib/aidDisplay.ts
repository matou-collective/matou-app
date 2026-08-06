/**
 * Resolve an AID to a human-readable display name.
 *
 * Resolution order: community profile display name → organisation name (when
 * the AID is the org group AID, e.g. actions recorded before the personal
 * admin AID was resolved) → sliced AID fallback.
 */
export function resolveAidDisplay(
  aid: string | null | undefined,
  profiles: Record<string, { displayName: string }>,
  org?: { aid: string | null; name: string | null },
): string {
  if (!aid) return '';
  const profileName = profiles[aid]?.displayName;
  if (profileName) return profileName;
  if (org?.aid && aid === org.aid) return `${org.name || 'Organisation'} (organisation)`;
  return aid.slice(0, 12) + '...';
}
