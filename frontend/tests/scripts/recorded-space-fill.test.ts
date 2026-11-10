/**
 * #645: every set-identity on an IDSS community carries the descriptor's recorded
 * space IDs, and a backend identity saved without them is re-set at boot.
 */
import { describe, it, expect } from 'vitest';
import { withRecordedSpaces, backendNeedsRecordedSpaces } from 'src/lib/spaces/recordedSpaceFill';

const REC = { communitySpaceId: 'C', readOnlySpaceId: 'R', adminSpaceId: 'A' };

describe('withRecordedSpaces', () => {
  it('fills every missing space ID from the descriptor', () => {
    expect(withRecordedSpaces({ aid: 'x' }, REC)).toEqual({ aid: 'x', ...REC });
  });
  it("keeps the caller's IDs where it has them", () => {
    expect(withRecordedSpaces({ communitySpaceId: 'mine' }, REC).communitySpaceId).toBe('mine');
  });
  it('leaves the request alone with no recorded spaces', () => {
    const req = { aid: 'x' };
    expect(withRecordedSpaces(req, null)).toBe(req);
  });
});

describe('backendNeedsRecordedSpaces', () => {
  it('is true for a configured backend with no community space when the descriptor records one', () => {
    expect(backendNeedsRecordedSpaces({ configured: true, communitySpaceId: '' }, REC)).toBe(true);
  });
  it('is false once the backend has the community space', () => {
    expect(backendNeedsRecordedSpaces({ configured: true, communitySpaceId: 'C' }, REC)).toBe(false);
  });
  it('is false with no recorded spaces (the founding-ceremony state)', () => {
    expect(backendNeedsRecordedSpaces({ configured: true }, null)).toBe(false);
  });
});
