import { describe, it, expect } from 'vitest';
import { serderSaid } from '../../src/lib/keri/said';

// A real Blake3-256 SAID in qb64 is 44 chars.
const SAID = 'ECg6npd1vQ5mEnoLrsK7DG72gHJXklSa61Ybh559wZOI';

describe('serderSaid', () => {
  it('reads the SAID from serder.sad (signify-ts 0.3.0-rc2 shape)', () => {
    // createExchangeMessage / ipex().grant return serders with fields on .sad;
    // reading only .ked here used to print "unknown" (issue #653).
    expect(serderSaid({ sad: { d: SAID } })).toBe(SAID);
  });

  it('falls back to serder.ked (older signify-ts shape)', () => {
    expect(serderSaid({ ked: { d: SAID } })).toBe(SAID);
  });

  it('prefers .sad over .ked when both are present', () => {
    expect(serderSaid({ sad: { d: SAID }, ked: { d: 'stale' } })).toBe(SAID);
  });

  it('returns "unknown" for a serder with neither field', () => {
    expect(serderSaid({})).toBe('unknown');
    expect(serderSaid({ sad: {} })).toBe('unknown');
  });

  it('returns "unknown" for null/undefined', () => {
    expect(serderSaid(null)).toBe('unknown');
    expect(serderSaid(undefined)).toBe('unknown');
  });
});
