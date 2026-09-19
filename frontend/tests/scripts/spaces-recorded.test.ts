/**
 * Reading the community's recorded space IDs from the descriptor (issue #534).
 * The three IDs ride inside the `anysync` block under matou-app's own camelCase
 * keys, together or not at all — the golden documents are idss's own renders.
 */
import { describe, it, expect } from 'vitest';
import { parseDescriptor, recordedSpaces, hasContentLayer } from 'src/lib/descriptor';

import goldenAnysync from './fixtures/descriptor/golden-anysync.json';
import goldenAnysyncSpaces from './fixtures/descriptor/golden-anysync-spaces.json';
import goldenNoAnysync from './fixtures/descriptor/golden-no-anysync.json';

describe('recordedSpaces', () => {
  it('reads the three camelCase IDs when the record is whole (join case, AC4)', () => {
    const d = parseDescriptor(goldenAnysyncSpaces);
    expect(hasContentLayer(d)).toBe(true);
    expect(recordedSpaces(d)).toEqual({
      communitySpaceId: 'bafyreicommunityspace000000000000000000000000000000000000.1',
      readOnlySpaceId: 'bafyreireadonlyspace0000000000000000000000000000000000000.2',
      adminSpaceId: 'bafyreiadminspace000000000000000000000000000000000000000.3',
    });
  });

  it('returns null when any-sync is present but names no IDs (the fallback case)', () => {
    const d = parseDescriptor(goldenAnysync);
    expect(hasContentLayer(d)).toBe(true);
    expect(recordedSpaces(d)).toBeNull();
  });

  it('returns null when the content layer is absent entirely', () => {
    const d = parseDescriptor(goldenNoAnysync);
    expect(hasContentLayer(d)).toBe(false);
    expect(recordedSpaces(d)).toBeNull();
  });

  it('returns null on a partial set — a half-created run never half-records', () => {
    const d = parseDescriptor({
      ...goldenAnysync,
      anysync: {
        ...(goldenAnysync as { anysync: Record<string, unknown> }).anysync,
        communitySpaceId: 'bafyCommunity.1',
        // read-only + admin missing → not whole → null
      },
    });
    expect(recordedSpaces(d)).toBeNull();
  });
});
