import { describe, it, expect } from 'vitest';
import { parseCesrStream, filterKelMessages } from '../../src/lib/keri/cesr';

/** Build a CESR-framed event with a correct size field in the version string. */
function cesrEvent(fields: Record<string, unknown>): string {
  const withPlaceholder = JSON.stringify({ v: 'KERI10JSON000000_', ...fields });
  const size = new TextEncoder().encode(withPlaceholder).length;
  const hex = size.toString(16).padStart(6, '0');
  return withPlaceholder.replace('KERI10JSON000000_', `KERI10JSON${hex}_`);
}

const ICP = cesrEvent({ t: 'icp', d: 'EIcpIcpIcpIcpIcpIcpIcpIcpIcpIcpIcpIcpIcpIcpI', s: '0' });
const IXN = cesrEvent({ t: 'ixn', d: 'EIxnIxnIxnIxnIxnIxnIxnIxnIxnIxnIxnIxnIxnIxnI', s: '1' });
const RPY = cesrEvent({ t: 'rpy', r: '/loc/scheme', a: { url: 'http://keria:3902/' } });
const ATT1 = '-VAn-AABAABZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ';
const ATT2 = '-VAn-AABAABYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY';

describe('parseCesrStream', () => {
  it('splits a stream into events with their trailing attachments', () => {
    const messages = parseCesrStream(`${ICP}${ATT1}${IXN}${ATT2}`);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.event.t).toBe('icp');
    expect(messages[0]!.eventRaw).toBe(ICP);
    expect(messages[0]!.attachment).toBe(ATT1);
    expect(messages[1]!.event.t).toBe('ixn');
    expect(messages[1]!.attachment).toBe(ATT2);
  });

  it('handles an event with no attachment at end of stream', () => {
    const messages = parseCesrStream(`${ICP}${ATT1}${IXN}`);
    expect(messages).toHaveLength(2);
    expect(messages[1]!.attachment).toBe('');
  });

  it('returns empty for an empty or garbage stream', () => {
    expect(parseCesrStream('')).toEqual([]);
    expect(parseCesrStream('not cesr at all')).toEqual([]);
  });

  it('stops cleanly on a truncated event', () => {
    const truncated = ICP.slice(0, ICP.length - 5);
    expect(parseCesrStream(truncated)).toEqual([]);
  });
});

describe('filterKelMessages', () => {
  it('keeps only KEL establishment/interaction events (drops rpy etc.)', () => {
    const messages = parseCesrStream(`${ICP}${ATT1}${RPY}${ATT2}${IXN}${ATT1}`);
    const kel = filterKelMessages(messages);
    expect(kel.map(m => m.event.t)).toEqual(['icp', 'ixn']);
  });
});

describe('mergeKelMessages', () => {
  const mk = (t: string, d: string, att: string) => ({
    event: { t, d },
    eventRaw: JSON.stringify({ t, d }),
    attachment: att,
  });

  it('prefers primary (receipted) copies and appends extra events not in primary', async () => {
    const { mergeKelMessages } = await import('../../src/lib/keri/cesr');
    const primary = [mk('icp', 'E0', '-RECEIPTED0'), mk('rot', 'E1', '-RECEIPTED1')];
    const extra = [mk('rot', 'E1', '-BARE1'), mk('ixn', 'E2', '-BARE2')];
    const merged = mergeKelMessages(primary, extra);
    expect(merged.map(m => m.event.d)).toEqual(['E0', 'E1', 'E2']);
    expect(merged[1]!.attachment).toBe('-RECEIPTED1');
    expect(merged[2]!.attachment).toBe('-BARE2');
  });

  it('handles empty primary', async () => {
    const { mergeKelMessages } = await import('../../src/lib/keri/cesr');
    const extra = [mk('icp', 'E0', '-A0')];
    expect(mergeKelMessages([], extra).map(m => m.event.d)).toEqual(['E0']);
  });
});
