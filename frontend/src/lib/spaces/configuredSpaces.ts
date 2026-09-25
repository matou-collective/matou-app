/**
 * resolveConfiguredSpaces — where the community's three any-sync space IDs come
 * from when a joining member (recover / linked-device / invite claim) hands them
 * to set-identity and join (issue #645).
 *
 * On an **IDSS** backend the three IDs live in the community backend
 * descriptor's `anysync` block (the 2026-09-15 ADR 0226 spaces amendment), NOT
 * in the OrgConfig the wallet derives from the descriptor's `community` block —
 * `deriveIdssOrgConfig` never copies them across. So the recover path must read
 * them from the descriptor, exactly as the boot restore path's #534 fallback
 * does; reading them from orgConfig (as the pre-#645 path did) always yielded
 * `undefined` and the member dead-ended at "No community space found".
 *
 * On any other backend the founding flow records the three IDs in orgConfig, so
 * that stays the source.
 *
 * When an IDSS descriptor records **no** spaces yet, that is the founding-
 * ceremony state (idss #1867) — the stewards have not created the content layer
 * — not a backend fault. `idssAwaitingSpaces` marks it so the caller can say so.
 */

import { getCommunityDescriptor } from 'src/lib/clientConfig';
import { recordedSpaces } from 'src/lib/descriptor';
import type { OrgConfig } from 'src/api/config';

export interface ConfiguredSpaces {
  communitySpaceId?: string;
  readOnlySpaceId?: string;
  adminSpaceId?: string;
  /**
   * True only on an IDSS backend whose descriptor records none of the three
   * spaces yet (founding-ceremony state, idss #1867) — not a misconfiguration.
   */
  idssAwaitingSpaces: boolean;
}

/**
 * Resolve the three space IDs to pass to set-identity and join. On an IDSS
 * backend they come from the descriptor's `anysync` block; on any other backend
 * from orgConfig. A descriptor fetch failure falls back to orgConfig rather than
 * throwing.
 */
export async function resolveConfiguredSpaces(
  orgConfig: OrgConfig | null | undefined,
  isIdssBackend: boolean,
): Promise<ConfiguredSpaces> {
  if (isIdssBackend) {
    try {
      const descriptor = await getCommunityDescriptor();
      const rec = recordedSpaces(descriptor);
      if (rec) {
        return {
          communitySpaceId: rec.communitySpaceId,
          readOnlySpaceId: rec.readOnlySpaceId,
          adminSpaceId: rec.adminSpaceId,
          idssAwaitingSpaces: false,
        };
      }
      // any-sync installed or not, no whole set recorded → founding-ceremony
      // state. The caller surfaces this as "still being set up", not a fault.
      return { idssAwaitingSpaces: true };
    } catch {
      // Descriptor unreachable — fall through to orgConfig (usually also empty
      // on IDSS, but never worse than the pre-#645 behaviour).
    }
  }
  return {
    communitySpaceId: orgConfig?.communitySpaceId ?? undefined,
    readOnlySpaceId: orgConfig?.readOnlySpaceId ?? undefined,
    adminSpaceId: orgConfig?.adminSpaceId ?? undefined,
    idssAwaitingSpaces: false,
  };
}
