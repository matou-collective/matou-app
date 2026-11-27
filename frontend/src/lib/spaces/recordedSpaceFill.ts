/**
 * Filling the backend identity's space IDs from the IDSS descriptor (#645).
 *
 * An IDSS community records its three any-sync space IDs in the descriptor's
 * `anysync` block (ADR 0226). The boot restore path's #534 fallback reads them,
 * but the recover / register paths and a backend identity saved without them
 * never did — so a recovered founder's backend had `communitySpace=` empty, the
 * community-access check failed, and the app parked them on the approval screen.
 * These pure helpers let every set-identity carry the recorded IDs.
 */

import type { RecordedSpaces } from 'src/lib/descriptor';

/** The space-ID fields a set-identity request carries. */
export interface SpaceIdFields {
  communitySpaceId?: string;
  readOnlySpaceId?: string;
  adminSpaceId?: string;
}

/**
 * Fill any missing space ID in `req` from the descriptor's recorded spaces. IDs
 * the caller already has win; with no recorded spaces the request is unchanged.
 */
export function withRecordedSpaces<T extends SpaceIdFields>(req: T, recorded: RecordedSpaces | null): T {
  if (!recorded) return req;
  return {
    ...req,
    communitySpaceId: req.communitySpaceId || recorded.communitySpaceId,
    readOnlySpaceId: req.readOnlySpaceId || recorded.readOnlySpaceId,
    adminSpaceId: req.adminSpaceId || recorded.adminSpaceId,
  };
}

/**
 * True when a backend identity that is already configured is missing the
 * community space the descriptor records, so it must be re-set (the recovered
 * founder's stuck state). False with no recorded spaces: there is nothing to
 * fill, and the #1867 founding-ceremony state is not a backend fault.
 */
export function backendNeedsRecordedSpaces(
  backend: { configured: boolean; communitySpaceId?: string },
  recorded: RecordedSpaces | null,
): boolean {
  return !!recorded && backend.configured && !backend.communitySpaceId;
}
